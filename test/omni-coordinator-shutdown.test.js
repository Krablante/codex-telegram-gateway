import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHarness,
  ensureSession,
  buildHumanTopicMessage,
} from "../test-support/omni-coordinator-fixtures.js";

test("OmniCoordinator treats interrupted Spike finals as an operator pause", async () => {
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
  session = await harness.sessionService.captureAutoInitialPrompt(
    session,
    "Initial Spike prompt",
  );
  session = await harness.sessionService.updateAutoMode(session, {
    ...session.auto_mode,
    phase: "running",
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Initial Spike prompt",
    last_agent_reply: "Interrupted.",
    exchange_log_entries: 6,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 6,
    status: "interrupted",
    finished_at: "2026-04-01T16:34:00.000Z",
    final_reply_text: "Interrupted.",
    telegram_message_ids: ["904"],
    reply_to_message_id: "700",
    thread_id: "thread-5",
  });

  await harness.coordinator.scanPendingSpikeFinals();

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  assert.equal(stored.auto_mode.phase, "blocked");
  assert.equal(stored.auto_mode.blocked_reason, "Interrupted by operator");
  assert.equal(stored.auto_mode.last_evaluated_exchange_log_entries, 6);
  assert.equal(harness.execPrompts.length, 0);
  assert.equal(harness.sent.length, 0);
});

test("OmniCoordinator respects /auto off even if a decision finishes afterwards", async () => {
  let resolveDecision;
  let killSignal = null;
  const decisionPrompts = [];
  const harness = await buildHarness({
    startExecRun({ prompt }) {
      decisionPrompts.push(prompt);
      return {
        child: {
          kill(signal) {
            killSignal = signal;
          },
        },
        done: new Promise((resolve) => {
          resolveDecision = resolve;
        }),
      };
    },
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
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Initial Spike prompt",
    last_agent_reply: "Still not done.",
    exchange_log_entries: 9,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 9,
    status: "completed",
    finished_at: "2026-04-01T16:37:00.000Z",
    final_reply_text: "Still not done.",
    telegram_message_ids: ["907"],
    reply_to_message_id: "700",
    thread_id: "thread-8",
  });

  const evaluationPromise = harness.coordinator.evaluateSession(session);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "/auto off",
      messageId: 108,
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    }),
  );
  resolveDecision({
    ok: true,
    finalReply: JSON.stringify({
      status: "continue",
      summary: "Continue anyway.",
      next_prompt: "Resume the work.",
      user_message: null,
      blocked_reason: null,
    }),
  });
  await evaluationPromise;

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  assert.equal(stored.auto_mode.enabled, false);
  assert.equal(stored.auto_mode.phase, "off");
  assert.equal(killSignal, "SIGINT");
  assert.equal(decisionPrompts.length, 1);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /выключен/u);
});

test("OmniCoordinator clears queued handoff immediately on /auto off", async () => {
  const harness = await buildHarness();
  const baseSession = await ensureSession(harness.sessionStore);
  const session = await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "1234567890",
    omniBotId: "2234567890",
    spikeBotId: "3234567890",
  });
  await harness.promptHandoffStore.queue(session, {
    mode: "continuation",
    prompt: "Resume the same goal after wake-up.",
  });

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "/auto off",
      messageId: 109,
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    }),
  );

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(result.reason, "auto-disabled");
  assert.equal(stored.auto_mode.phase, "off");
  assert.equal(pendingPrompt, null);
});

test("OmniCoordinator can re-arm /auto cleanly after /auto off", async () => {
  const harness = await buildHarness();
  const baseSession = await ensureSession(harness.sessionStore);
  let session = await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "1234567890",
    omniBotId: "2234567890",
    spikeBotId: "3234567890",
  });
  session = await harness.sessionService.captureAutoGoal(
    session,
    "Old goal that should be dropped.",
  );
  session = await harness.sessionService.clearAutoMode(session);

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "/auto",
      messageId: 110,
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    }),
  );

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  assert.equal(result.reason, "auto-armed");
  assert.equal(stored.auto_mode.enabled, true);
  assert.equal(stored.auto_mode.phase, "await_goal");
  assert.equal(stored.auto_mode.literal_goal_text, null);
});
