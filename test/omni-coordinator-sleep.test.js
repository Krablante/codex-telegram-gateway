import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHarness,
  ensureSession,
  buildHumanTopicMessage,
} from "../test-support/omni-coordinator-fixtures.js";

test("OmniCoordinator resumes a due sleeping session by sending the stored continuation", async () => {
  const harness = await buildHarness();
  const baseSession = await ensureSession(harness.sessionStore);
  let session = await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
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
    phase: "sleeping",
    continuation_count: 2,
    last_evaluated_exchange_log_entries: 4,
    sleep_until: "2026-04-01T16:00:00.000Z",
    sleep_next_prompt: "Wake up and keep monitoring the same live proof line.",
  });

  await harness.coordinator.resumeDueSleepingSessions();

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(stored.auto_mode.phase, "running");
  assert.equal(stored.auto_mode.continuation_count, 3);
  assert.equal(stored.auto_mode.sleep_until, null);
  assert.equal(stored.auto_mode.sleep_next_prompt, null);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /Omni -> Spike continuation handoff preview/u);
  assert.match(
    pendingPrompt.prompt,
    /Wake up and keep monitoring the same live proof line/u,
  );
});

test("OmniCoordinator fails a broken sleeping state instead of silently swallowing operator input", async () => {
  const harness = await buildHarness();
  const baseSession = await ensureSession(harness.sessionStore);
  let session = await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
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
    phase: "sleeping",
    sleep_until: "2026-04-03T13:30:00.000Z",
    sleep_next_prompt: null,
  });

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Use the new deployment id.",
      messageId: 1301,
    }),
  );

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  assert.equal(result.reason, "auto-sleeping-state-corrupt");
  assert.equal(stored.auto_mode.phase, "failed");
  assert.match(stored.auto_mode.pending_user_input, /Use the new deployment id/u);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /sleep state is missing the queued wake-up prompt/u);
});

test("OmniCoordinator fails a sleeping state with an invalid wake timestamp during resume scan", async () => {
  const harness = await buildHarness();
  const baseSession = await ensureSession(harness.sessionStore);
  let session = await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
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
    phase: "sleeping",
    sleep_until: "not-a-date",
    sleep_next_prompt: "Wake up and keep monitoring the same live proof line.",
  });

  await harness.coordinator.resumeDueSleepingSessions();

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  assert.equal(stored.auto_mode.phase, "failed");
  assert.equal(harness.execPrompts.length, 0);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /invalid wake timestamp/u);
});

test("OmniCoordinator wakes a sleeping session immediately when fresh human input arrives", async () => {
  const harness = await buildHarness();
  const baseSession = await ensureSession(harness.sessionStore);
  let session = await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
  });
  session = await harness.sessionService.captureAutoGoal(
    session,
    "Ship Omni auto mode safely.",
  );
  session = await harness.sessionService.captureAutoInitialPrompt(
    session,
    "Keep working until the goal is done.",
  );
  session = await harness.sessionService.updateAutoMode(session, {
    ...session.auto_mode,
    phase: "sleeping",
    continuation_count: 3,
    sleep_until: "2099-04-01T16:00:00.000Z",
    sleep_next_prompt: "Wake up and continue the same live proof line.",
  });

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Use the fresh operator clue before waking.",
      messageId: 105,
    }),
  );

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(result.handled, true);
  assert.equal(result.reason, "auto-sleep-resumed-by-operator");
  assert.equal(stored.auto_mode.phase, "running");
  assert.equal(stored.auto_mode.continuation_count, 4);
  assert.equal(stored.auto_mode.sleep_until, null);
  assert.equal(stored.auto_mode.sleep_next_prompt, null);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /Use the fresh operator clue before waking/u);
  assert.match(pendingPrompt.prompt, /Use the fresh operator clue before waking/u);
  assert.match(pendingPrompt.prompt, /Wake up and continue the same live proof line/u);
});
