import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHarness,
  ensureSession,
  buildHumanTopicMessage,
} from "../test-support/omni-coordinator-fixtures.js";

test("OmniCoordinator seeds topic-scoped Omni memory when the goal is captured", async () => {
  const harness = await buildHarness();
  const baseSession = await ensureSession(harness.sessionStore);
  await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "1234567890",
    omniBotId: "2234567890",
    spikeBotId: "3234567890",
  });

  await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Ship Omni v2 without losing goal lock.",
      messageId: 105,
    }),
  );

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  const memory = await harness.coordinator.loadOmniMemory(stored);
  assert.deepEqual(memory.goal_constraints, [
    "Ship Omni v2 without losing goal lock.",
  ]);
  assert.equal(
    memory.why_this_matters_to_goal,
    "Ship Omni v2 without losing goal lock.",
  );
});

test("OmniCoordinator preserves existing side work when a later decision omits that field", async () => {
  const harness = await buildHarness();
  const session = await ensureSession(harness.sessionStore);

  await harness.coordinator.updateOmniMemoryFromDecision(
    session,
    {
      mode: "continue_same_line",
      sideWork: ["Inspect the queue boundary."],
    },
    {
      lockedGoal: "Keep Omni goal-locked.",
      spikeSummary: "Initial summary.",
    },
  );

  const updated = await harness.coordinator.updateOmniMemoryFromDecision(
    session,
    {
      mode: "continue_same_line",
      summary: "No change to side work this cycle.",
    },
    {
      lockedGoal: "Keep Omni goal-locked.",
      spikeSummary: "Follow-up summary.",
    },
  );

  assert.deepEqual(updated.side_work_queue, [
    "Inspect the queue boundary.",
  ]);
});

test("OmniCoordinator parks setup replies instead of throwing on unavailable topics", async () => {
  const transportError = new Error(
    "Telegram API sendMessage failed: Bad Request: message thread not found",
  );
  const lifecycleCalls = [];
  const harness = await buildHarness({
    sendMessageImpl() {
      throw transportError;
    },
    sessionLifecycleManager: {
      async handleTransportError(session, error) {
        lifecycleCalls.push({ sessionKey: session.session_key, error });
        return { handled: true, session };
      },
    },
  });
  const baseSession = await ensureSession(harness.sessionStore);
  await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "1234567890",
    omniBotId: "2234567890",
    spikeBotId: "3234567890",
  });

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Ship Omni auto mode safely.",
      messageId: 301,
    }),
  );

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  assert.equal(result.reason, "topic-unavailable");
  assert.equal(stored.auto_mode.phase, "await_initial_prompt");
  assert.equal(lifecycleCalls.length, 1);
  assert.equal(lifecycleCalls[0].error, transportError);
});

test("OmniCoordinator falls back to a plain topic send when the reply target disappeared", async () => {
  const sent = [];
  let attempts = 0;
  const harness = await buildHarness({
    sendMessageImpl(payload, { nextMessageId }) {
      attempts += 1;
      if (attempts === 1) {
        sent.push(payload);
        assert.equal(payload.reply_to_message_id, 700);
        throw new Error(
          "Telegram API sendMessage failed: Bad Request: message to be replied not found",
        );
      }

      sent.push(payload);
      return { message_id: nextMessageId };
    },
  });
  const session = await ensureSession(harness.sessionStore);

  const delivered = await harness.coordinator.sendTopicMessage(
    session,
    "Fallback reply target test.",
    { replyToMessageId: 700 },
  );

  assert.equal(attempts, 2);
  assert.equal(delivered.message_id, 500);
  assert.equal(sent[1].reply_to_message_id, undefined);
  assert.equal(sent[1].message_thread_id, 77);
  assert.equal(sent[1].text, "Fallback reply target test.");
});

test("OmniCoordinator ignores bare wait flush shortcuts during auto setup", async () => {
  const harness = await buildHarness();
  const baseSession = await ensureSession(harness.sessionStore);
  let session = await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "1234567890",
    omniBotId: "2234567890",
    spikeBotId: "3234567890",
  });
  session = await harness.sessionService.captureAutoGoal(
    session,
    "Ship Omni auto mode safely.",
  );

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Все",
      messageId: 103,
    }),
  );

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(result.reason, "auto-initial-prompt-flush-ignored");
  assert.equal(stored.auto_mode.phase, "await_initial_prompt");
  assert.equal(stored.auto_mode.initial_worker_prompt, null);
  assert.equal(pendingPrompt, null);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /\/wait/u);
});

test("OmniCoordinator combines buffered split setup messages before processing", async () => {
  const harness = await buildHarness();
  const baseSession = await ensureSession(harness.sessionStore);
  await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "1234567890",
    omniBotId: "2234567890",
    spikeBotId: "3234567890",
  });

  const goalResult = await harness.coordinator.handleBufferedHumanMessages([
    buildHumanTopicMessage({
      text: "Ship Omni auto mode",
      messageId: 201,
    }),
    buildHumanTopicMessage({
      text: "safely with split goal fragments.",
      messageId: 202,
    }),
  ]);

  let stored = await harness.sessionStore.load("-1001234567890", "77");
  assert.equal(goalResult.reason, "auto-goal-captured");
  assert.match(
    stored.auto_mode.literal_goal_text,
    /Ship Omni auto mode\s+safely with split goal fragments/u,
  );

  const promptResult = await harness.coordinator.handleBufferedHumanMessages([
    buildHumanTopicMessage({
      text: "Implement the first",
      messageId: 203,
    }),
    buildHumanTopicMessage({
      text: "safe vertical slice.",
      messageId: 204,
    }),
  ]);

  stored = await harness.sessionStore.load("-1001234567890", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(promptResult.reason, "auto-initial-prompt-sent");
  assert.match(
    stored.auto_mode.initial_worker_prompt,
    /Implement the first\s+safe vertical slice/u,
  );
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[1].text, /Spike/u);
  assert.match(
    pendingPrompt.prompt,
    /Implement the first\s+safe vertical slice/u,
  );
});

test("OmniCoordinator acknowledges the initial prompt handoff to Spike", async () => {
  const harness = await buildHarness();
  const baseSession = await ensureSession(harness.sessionStore);
  let session = await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "1234567890",
    omniBotId: "2234567890",
    spikeBotId: "3234567890",
  });
  session = await harness.sessionService.captureAutoGoal(
    session,
    "Ship Omni auto mode safely.",
  );

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Implement the first safe vertical slice.",
      messageId: 106,
    }),
  );

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(result.reason, "auto-initial-prompt-sent");
  assert.equal(stored.auto_mode.phase, "running");
  assert.equal(stored.auto_mode.initial_worker_prompt, "Implement the first safe vertical slice.");
  assert.equal(stored.auto_mode.last_omni_prompt_message_id, null);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /Spike/u);
  assert.match(pendingPrompt.prompt, /Implement the first safe vertical slice/u);
});
