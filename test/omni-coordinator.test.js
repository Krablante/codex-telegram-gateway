import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHarness,
  ensureSession,
  buildHumanTopicMessage,
} from "../test-support/omni-coordinator-fixtures.js";

test("OmniCoordinator arms /auto and waits for the goal", async () => {
  const harness = await buildHarness();
  await ensureSession(harness.sessionStore);

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "/auto",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    }),
  );

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  assert.equal(result.reason, "auto-armed");
  assert.equal(stored.auto_mode.enabled, true);
  assert.equal(stored.auto_mode.phase, "await_goal");
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /Реплай не нужен/u);
});

test("OmniCoordinator captures the goal, explains the next step, and forwards the initial prompt to Spike", async () => {
  const harness = await buildHarness();
  const baseSession = await ensureSession(harness.sessionStore);
  await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "1234567890",
    omniBotId: "2234567890",
    spikeBotId: "3234567890",
  });

  const goalResult = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Ship Omni auto mode safely.",
      messageId: 101,
    }),
  );
  let stored = await harness.sessionStore.load("-1001234567890", "77");
  assert.equal(goalResult.reason, "auto-goal-captured");
  assert.equal(stored.auto_mode.phase, "await_initial_prompt");
  assert.equal(stored.auto_mode.literal_goal_text, "Ship Omni auto mode safely.");
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /initial worker prompt/u);

  const promptResult = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Implement the first safe vertical slice.",
      messageId: 102,
    }),
  );

  stored = await harness.sessionStore.load("-1001234567890", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(promptResult.reason, "auto-initial-prompt-sent");
  assert.equal(stored.auto_mode.phase, "running");
  assert.equal(stored.auto_mode.initial_worker_prompt, "Implement the first safe vertical slice.");
  assert.equal(stored.auto_mode.last_omni_prompt_message_id, null);
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[1].text, /Spike/u);
  assert.match(pendingPrompt.prompt, /Autonomous continuation context\./u);
});

test("OmniCoordinator evaluates a Spike final event once and continues without re-looping", async () => {
  const harness = await buildHarness({
    decisionReply: JSON.stringify({
      status: "continue",
      summary: "Goal not done yet.",
      next_prompt: "Fix the remaining validation gap and verify again.",
      user_message: null,
      blocked_reason: null,
    }),
  });
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
  session = await harness.sessionService.captureAutoInitialPrompt(
    session,
    "Initial Spike prompt",
  );
  session = await harness.sessionService.updateAutoMode(session, {
    ...session.auto_mode,
    phase: "running",
    last_omni_prompt_message_id: "700",
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Initial Spike prompt",
    last_agent_reply: "I updated the code but one validation branch still fails.",
    exchange_log_entries: 3,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 3,
    status: "completed",
    finished_at: "2026-04-01T16:30:00.000Z",
    final_reply_text: "I updated the code but one validation branch still fails.",
    telegram_message_ids: ["900"],
    reply_to_message_id: "700",
    thread_id: "thread-1",
  });

  await harness.coordinator.scanPendingSpikeFinals();

  let stored = await harness.sessionStore.load("-1001234567890", "77");
  let pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(stored.auto_mode.phase, "running");
  assert.equal(stored.auto_mode.continuation_count, 1);
  assert.equal(stored.auto_mode.last_spike_final_message_id, "900");
  assert.equal(stored.auto_mode.last_spike_exchange_log_entries, 3);
  assert.equal(stored.auto_mode.last_evaluated_exchange_log_entries, 3);
  assert.equal(harness.execPrompts.length, 1);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /Omni -> Spike continuation handoff preview/u);
  assert.match(harness.sent[0].text, /locked goal/u);
  assert.match(harness.sent[0].text, /Fix the remaining validation gap/u);
  assert.match(pendingPrompt.prompt, /Fix the remaining validation gap/u);

  await harness.coordinator.scanPendingSpikeFinals();

  stored = await harness.sessionStore.load("-1001234567890", "77");
  pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(stored.auto_mode.continuation_count, 1);
  assert.equal(harness.execPrompts.length, 1);
  assert.match(pendingPrompt.prompt, /Fix the remaining validation gap/u);
});
