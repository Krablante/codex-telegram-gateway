import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHarness,
  ensureSession,
  buildHumanTopicMessage,
} from "../test-support/omni-coordinator-fixtures.js";

test("OmniCoordinator resumes a blocked topic with fresh human input", async () => {
  const harness = await buildHarness({
    decisionReply: JSON.stringify({
      status: "continue",
      summary: "Resume with the new deployment id.",
      next_prompt: "Use DEPLOYMENT_ID=abc123 and continue the deployment flow.",
      user_message: null,
      blocked_reason: null,
    }),
  });
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
    "Ask for deployment id",
  );
  session = await harness.sessionService.updateAutoMode(session, {
    ...session.auto_mode,
    phase: "blocked",
    blocked_reason: "Missing DEPLOYMENT_ID",
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Ask for deployment id",
    last_agent_reply: "I am blocked waiting for DEPLOYMENT_ID.",
    exchange_log_entries: 4,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 4,
    status: "completed",
    finished_at: "2026-04-01T16:31:00.000Z",
    final_reply_text: "I am blocked waiting for DEPLOYMENT_ID.",
    telegram_message_ids: ["901"],
    reply_to_message_id: "700",
    thread_id: "thread-2",
  });

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "DEPLOYMENT_ID=abc123",
      messageId: 103,
    }),
  );

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(result.reason, "auto-blocked-resume");
  assert.equal(stored.auto_mode.phase, "running");
  assert.equal(stored.auto_mode.blocked_reason, null);
  assert.equal(stored.auto_mode.pending_user_input, null);
  assert.equal(stored.auto_mode.last_evaluated_exchange_log_entries, 4);
  assert.equal(harness.execPrompts.length, 1);
  assert.match(harness.execPrompts[0], /Fresh operator input: DEPLOYMENT_ID=abc123/u);
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[0].text, /Ввод принят|Input accepted/u);
  assert.match(harness.sent[1].text, /Omni -> Spike continuation handoff preview/u);
  assert.match(harness.sent[1].text, /DEPLOYMENT_ID=abc123/u);
  assert.match(pendingPrompt.prompt, /DEPLOYMENT_ID=abc123/u);
});

test("OmniCoordinator ignores non-/auto commands so they do not pollute pending input", async () => {
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

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "/status",
      messageId: 104,
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    }),
  );

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  assert.equal(result.handled, false);
  assert.equal(result.reason, "non-omni-command");
  assert.equal(stored.auto_mode.pending_user_input, null);
  assert.equal(harness.execPrompts.length, 0);
  assert.equal(harness.sent.length, 0);
});

test("OmniCoordinator ignores commands targeted at another bot so they do not become operator input", async () => {
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

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "/status@spikebot",
      messageId: 1041,
      entities: [{ type: "bot_command", offset: 0, length: 17 }],
    }),
  );

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  assert.equal(result.handled, false);
  assert.equal(result.reason, "foreign-bot-command");
  assert.equal(stored.auto_mode.pending_user_input, null);
  assert.equal(harness.execPrompts.length, 0);
  assert.equal(harness.sent.length, 0);
});

test("OmniCoordinator explains that explicit runtime-setting commands still go through Spike", async () => {
  const harness = await buildHarness();
  await ensureSession(harness.sessionStore);

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "/omni_model@omnibot gpt-5.4-mini",
      messageId: 1042,
      entities: [{ type: "bot_command", offset: 0, length: 19 }],
    }),
  );

  assert.equal(result.handled, true);
  assert.equal(result.reason, "runtime-setting-command-owned-by-spike");
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /Spike/u);
  assert.match(harness.sent[0].text, /`@omnibot`/u);
});

test("OmniCoordinator answers direct /omni questions without waking Spike or changing sleep state", async () => {
  const execCalls = [];
  const harness = await buildHarness({
    startExecRun({ prompt, model, reasoningEffort, repoRoot }) {
      execCalls.push({ prompt, model, reasoningEffort, repoRoot });
      return {
        child: null,
        done: Promise.resolve({
          ok: true,
          finalReply:
            "Latest progress: the CAD rerun is healthy, the fallback patch is waiting for the first real packetization step, and Omni plans to wake later and re-check the export handoff.",
        }),
      };
    },
  });
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
    sleep_until: "2026-04-02T16:08:53.045Z",
    sleep_next_prompt: "Keep monitoring the CAD export handoff after wake-up.",
    last_result_summary: "Healthy CAD rerun is still in flight; no blocker and no completion yet.",
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Previous continuation task",
    last_agent_reply: "The CAD rerun is healthy and waiting on planner.generate_program.",
  });

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "/omni what did we achieve and what happens next?",
      messageId: 1043,
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    }),
  );

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  assert.equal(result.handled, true);
  assert.equal(result.reason, "omni-query-answered");
  assert.equal(stored.auto_mode.phase, "sleeping");
  assert.equal(stored.auto_mode.sleep_until, "2026-04-02T16:08:53.045Z");
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].repoRoot, harness.workspaceRoot);
  assert.match(execCalls[0].prompt, /Operator question:/u);
  assert.match(execCalls[0].prompt, /what did we achieve and what happens next\?/u);
  assert.match(execCalls[0].prompt, /Healthy CAD rerun is still in flight/u);
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[0].text, /Вопрос принят|Question accepted/u);
  assert.match(harness.sent[1].text, /Latest progress:/u);
});

test("OmniCoordinator answers plain-text questions during active /auto without waking Spike", async () => {
  const execCalls = [];
  const harness = await buildHarness({
    startExecRun({ prompt, model, reasoningEffort, repoRoot }) {
      execCalls.push({ prompt, model, reasoningEffort, repoRoot });
      return {
        child: null,
        done: Promise.resolve({
          ok: true,
          finalReply:
            "No, the next solve bar is not closed yet. The current CAD line is still a bounded proof-line pass, not a 95%+ solved open biomedical case.",
        }),
      };
    },
  });
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
    sleep_until: "2026-04-02T16:08:53.045Z",
    sleep_next_prompt: "Keep monitoring the CAD export handoff after wake-up.",
    last_result_summary: "Healthy CAD rerun is still in flight; no blocker and no completion yet.",
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Previous continuation task",
    last_agent_reply: "The CAD rerun is healthy and waiting on planner.generate_program.",
  });

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Я правильно понимаю, что следующей цели мы еще не достигли?",
      messageId: 10431,
    }),
  );

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  assert.equal(result.handled, true);
  assert.equal(result.reason, "omni-query-answered");
  assert.equal(stored.auto_mode.phase, "sleeping");
  assert.equal(stored.auto_mode.pending_user_input, null);
  assert.equal(execCalls.length, 1);
  assert.match(execCalls[0].prompt, /Operator question:/u);
  assert.match(execCalls[0].prompt, /следующей цели мы еще не достигли\?/u);
  assert.equal(harness.execPrompts.length, 0);
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[0].text, /Вопрос принят|Question accepted/u);
  assert.match(harness.sent[1].text, /95%\+ solved open biomedical case/u);
});

test("OmniCoordinator still answers /omni after auto flips off if recent auto context remains", async () => {
  const execCalls = [];
  const harness = await buildHarness({
    startExecRun({ prompt }) {
      execCalls.push(prompt);
      return {
        child: null,
        done: Promise.resolve({
          ok: true,
          finalReply: "The last auto cycle already closed, but the locked goal is still not fully achieved.",
        }),
      };
    },
  });
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
    enabled: false,
    phase: "off",
    last_result_summary: "The last auto cycle completed, but the broader goal remains open.",
  });

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "/omni did the previous cycle finish the real goal?",
      messageId: 1044,
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    }),
  );

  assert.equal(result.handled, true);
  assert.equal(result.reason, "omni-query-answered");
  assert.equal(execCalls.length, 1);
  assert.match(execCalls[0], /The last auto cycle completed, but the broader goal remains open\./u);
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[0].text, /Вопрос принят|Question accepted/u);
  assert.match(harness.sent[1].text, /locked goal is still not fully achieved/u);
});

test("OmniCoordinator ignores plain human prompts after auto reaches a terminal phase", async () => {
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
  session = await harness.sessionService.markAutoDecision(session, {
    phase: "done",
    resultSummary: "Goal reached.",
    clearPendingUserInput: true,
  });

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Start a completely new manual task.",
      messageId: 105,
    }),
  );

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  assert.equal(result.handled, false);
  assert.equal(result.reason, "auto-terminal-phase");
  assert.equal(stored.auto_mode.pending_user_input, null);
  assert.equal(harness.execPrompts.length, 0);
  assert.equal(harness.sent.length, 0);
});

test("OmniCoordinator accepts fresh human input after a recoverable failed phase", async () => {
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
  session = await harness.sessionService.markAutoDecision(session, {
    phase: "failed",
    resultSummary: "Omni decision parse failed.",
  });

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Use the fresh operator clue and continue.",
      messageId: 105,
    }),
  );

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  assert.equal(result.handled, true);
  assert.equal(result.reason, "auto-input-queued");
  assert.equal(
    stored.auto_mode.pending_user_input,
    "Use the fresh operator clue and continue.",
  );
  assert.equal(harness.execPrompts.length, 0);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /Ввод принят|Input accepted/u);
});

test("OmniCoordinator can resume an interrupted Spike final after fresh human input", async () => {
  const harness = await buildHarness({
    decisionReply: JSON.stringify({
      status: "continue",
      summary: "Resume after the operator pause.",
      next_prompt: "Use the fresh operator input and continue the task.",
      user_message: null,
      blocked_reason: null,
    }),
  });
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
    phase: "blocked",
    blocked_reason: "Interrupted by operator",
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Initial Spike prompt",
    last_agent_reply: "Interrupted.",
    exchange_log_entries: 7,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 7,
    status: "interrupted",
    finished_at: "2026-04-01T16:35:00.000Z",
    final_reply_text: "Interrupted.",
    telegram_message_ids: ["905"],
    reply_to_message_id: "700",
    thread_id: "thread-6",
  });

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Resume with the new operator context.",
      messageId: 107,
    }),
  );

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(result.reason, "auto-blocked-resume");
  assert.equal(stored.auto_mode.phase, "running");
  assert.equal(stored.auto_mode.blocked_reason, null);
  assert.equal(stored.auto_mode.pending_user_input, null);
  assert.equal(harness.execPrompts.length, 1);
  assert.match(
    harness.execPrompts[0],
    /Fresh operator input: Resume with the new operator context\./u,
  );
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[0].text, /Ввод принят|Input accepted/u);
  assert.match(harness.sent[1].text, /Omni -> Spike continuation handoff preview/u);
  assert.match(harness.sent[1].text, /Resume with the new operator context\./u);
  assert.match(pendingPrompt.prompt, /Resume with the new operator context\./u);
});
