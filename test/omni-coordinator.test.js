import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OmniCoordinator } from "../src/omni/coordinator.js";
import { SessionService } from "../src/session-manager/session-service.js";
import { SessionStore } from "../src/session-manager/session-store.js";
import { SpikeFinalEventStore } from "../src/session-manager/spike-final-event-store.js";
import { OmniPromptHandoffStore } from "../src/omni/prompt-handoff.js";

function buildBinding(workspaceRoot) {
  return {
    repo_root: workspaceRoot,
    cwd: workspaceRoot,
    branch: "main",
    worktree_path: workspaceRoot,
  };
}

function buildConfig(stateRoot, workspaceRoot) {
  return {
    repoRoot: workspaceRoot,
    stateRoot,
    codexBinPath: "codex",
    workspaceRoot: workspaceRoot,
    defaultSessionBindingPath: workspaceRoot,
    telegramForumChatId: "-1003577434463",
    telegramAllowedUserId: "5825672398",
    telegramAllowedUserIds: ["5825672398"],
    telegramAllowedBotIds: ["8603043042"],
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
  };
}

async function buildHarness({
  decisionReply = null,
  startExecRun = null,
  sendMessageImpl = null,
  sessionLifecycleManager = null,
  sessionCompactor = null,
} = {}) {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-omni-coordinator-"),
  );
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-omni-workspace-"),
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: workspaceRoot });
  const sessionsRoot = path.join(stateRoot, "sessions");
  const sessionStore = new SessionStore(sessionsRoot);
  sessionStore.__testWorkspaceRoot = workspaceRoot;
  const config = buildConfig(stateRoot, workspaceRoot);
  const sessionService = new SessionService({
    sessionStore,
    config,
    sessionCompactor,
  });
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const promptHandoffStore = new OmniPromptHandoffStore(sessionStore);
  const sent = [];
  const execPrompts = [];
  const execCalls = [];
  let nextMessageId = 500;
  const api = {
    async sendMessage(payload) {
      if (typeof sendMessageImpl === "function") {
        return sendMessageImpl(payload, { nextMessageId });
      }
      sent.push(payload);
      return {
        message_id: nextMessageId++,
      };
    },
  };

  const coordinator = new OmniCoordinator({
    api,
    config,
    promptHandoffStore,
    serviceState: {
      botUsername: "omnibot",
      handledCommands: 0,
      ignoredUpdates: 0,
    },
    sessionService,
    sessionStore,
    sessionLifecycleManager,
    spikeFinalEventStore,
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
    startExecRun: startExecRun || ((params) => {
      execCalls.push(params);
      execPrompts.push(params.prompt);
      return {
        child: null,
        done: Promise.resolve({
          ok: true,
          finalReply:
            decisionReply ??
            JSON.stringify({
              status: "continue",
              summary: "Goal not done yet.",
              next_prompt: "Continue the work and verify the result.",
              user_message: null,
              blocked_reason: null,
            }),
        }),
      };
    }),
  });

  return {
    coordinator,
    config,
    execCalls,
    execPrompts,
    sent,
    promptHandoffStore,
    sessionService,
    sessionStore,
    spikeFinalEventStore,
    workspaceRoot,
  };
}

async function ensureSession(sessionStore) {
  const workspaceRoot = sessionStore.__testWorkspaceRoot;
  return sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 77,
    topicName: "Omni coordinator test",
    createdVia: "test",
    workspaceBinding: buildBinding(workspaceRoot),
  });
}

function buildHumanTopicMessage({
  text,
  messageId = 100,
  threadId = 77,
  entities = undefined,
} = {}) {
  return {
    text,
    entities,
    from: { id: 5825672398, is_bot: false },
    chat: { id: -1003577434463 },
    message_id: messageId,
    message_thread_id: threadId,
  };
}

test("OmniCoordinator arms /auto and waits for the goal", async () => {
  const harness = await buildHarness();
  await ensureSession(harness.sessionStore);

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "/auto",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    }),
  );

  const stored = await harness.sessionStore.load("-1003577434463", "77");
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
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
  });

  const goalResult = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Ship Omni auto mode safely.",
      messageId: 101,
    }),
  );
  let stored = await harness.sessionStore.load("-1003577434463", "77");
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

  stored = await harness.sessionStore.load("-1003577434463", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(promptResult.reason, "auto-initial-prompt-sent");
  assert.equal(stored.auto_mode.phase, "running");
  assert.equal(stored.auto_mode.initial_worker_prompt, "Implement the first safe vertical slice.");
  assert.equal(stored.auto_mode.last_omni_prompt_message_id, null);
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[1].text, /Spike/u);
  assert.match(pendingPrompt.prompt, /Autonomous continuation context\./u);
});

test("OmniCoordinator seeds topic-scoped Omni memory when the goal is captured", async () => {
  const harness = await buildHarness();
  const baseSession = await ensureSession(harness.sessionStore);
  await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
  });

  await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Ship Omni v2 without losing goal lock.",
      messageId: 105,
    }),
  );

  const stored = await harness.sessionStore.load("-1003577434463", "77");
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
    sendMessageImpl(payload) {
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
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
  });

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Ship Omni auto mode safely.",
      messageId: 301,
    }),
  );

  const stored = await harness.sessionStore.load("-1003577434463", "77");
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
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
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

  const stored = await harness.sessionStore.load("-1003577434463", "77");
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
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
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

  let stored = await harness.sessionStore.load("-1003577434463", "77");
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

  stored = await harness.sessionStore.load("-1003577434463", "77");
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

  let stored = await harness.sessionStore.load("-1003577434463", "77");
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

  stored = await harness.sessionStore.load("-1003577434463", "77");
  pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(stored.auto_mode.continuation_count, 1);
  assert.equal(harness.execPrompts.length, 1);
  assert.match(pendingPrompt.prompt, /Fix the remaining validation gap/u);
});

test("OmniCoordinator applies Omni v2 memory, pivot handoff, and auto-compact at a cycle boundary", async () => {
  const compactCalls = [];
  const harness = await buildHarness({
    decisionReply: JSON.stringify({
      decision_mode: "pivot_to_next_line",
      summary: "The current line is exhausted; pivot to the compaction integration line.",
      current_proof_line: "auto-compact cycle-boundary integration",
      proof_line_status: "pivoting",
      why_this_matters_to_goal: "The locked goal needs long-run continuity without re-growing the thread forever.",
      what_changed: "Spike finished the previous hardening line and confirmed the remaining gap is continuity refresh.",
      remaining_goal_gap: "Auto-compact still needs to trigger transparently before the next Spike handoff.",
      next_action: "Implement the internal auto-compact handshake, then verify that the stored Omni handoff survives the refresh.",
      side_work: ["Keep the current live path minimal and goal-linked."],
      do_not_regress: ["Do not break manual /compact UX."],
      known_bottlenecks: ["Compaction must happen only at cycle boundaries."],
      candidate_pivots: ["Session-compactor reset path"],
      supervisor_notes: ["Prefer internal handoff storage over public Telegram relay."],
      user_message: null,
      blocked_reason: null,
    }),
    sessionCompactor: {
      async compact(session, { reason }) {
        compactCalls.push(reason);
        const compactedSession = await harness.sessionStore.patch(session, {
          last_compacted_at: "2026-04-03T18:30:00.000Z",
          last_compaction_reason: reason,
        });
        return {
          session: compactedSession,
          reason,
          activeBrief: "# Active brief\n",
          exchangeLogEntries: 8,
          generatedWithCodex: true,
        };
      },
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
    "Ship Omni v2 with transparent continuity refresh.",
  );
  session = await harness.sessionService.captureAutoInitialPrompt(
    session,
    "Initial Spike prompt",
  );
  session = await harness.sessionService.updateAutoMode(session, {
    ...session.auto_mode,
    phase: "running",
    continuation_count: 30,
    continuation_count_since_compact: 30,
    first_omni_prompt_at: "2026-04-03T10:00:00.000Z",
    last_evaluated_exchange_log_entries: 7,
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Initial Spike prompt",
    last_agent_reply: "The last hardening pass is complete; only transparent continuity refresh remains.",
    exchange_log_entries: 8,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 8,
    status: "completed",
    finished_at: "2026-04-03T18:20:00.000Z",
    final_reply_text:
      "The last hardening pass is complete; only transparent continuity refresh remains.",
    telegram_message_ids: ["901"],
    reply_to_message_id: "700",
    thread_id: "thread-2",
  });

  await harness.coordinator.scanPendingSpikeFinals();

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  const memory = await harness.coordinator.loadOmniMemory(stored);
  assert.deepEqual(compactCalls, ["auto-compact:omni-cycle-boundary"]);
  assert.equal(harness.sent.length, 2);
  assert.match(harness.sent[0].text, /auto-compact/u);
  assert.match(harness.sent[1].text, /Omni -> Spike continuation handoff preview/u);
  assert.match(pendingPrompt.prompt, /Goal-locked handoff from Omni\./u);
  assert.match(
    pendingPrompt.prompt,
    /auto-compact cycle-boundary integration/u,
  );
  assert.match(
    pendingPrompt.prompt,
    /Do not break manual \/compact UX\./u,
  );
  assert.equal(memory.last_decision_mode, "pivot_to_next_line");
  assert.equal(
    memory.current_proof_line,
    "auto-compact cycle-boundary integration",
  );
  assert.equal(memory.continuation_count_since_compact, 1);
  assert.notEqual(
    memory.first_omni_prompt_at,
    "2026-04-03T10:00:00.000Z",
  );
  assert.deepEqual(memory.do_not_regress, [
    "Do not break manual /compact UX.",
  ]);
});

test("OmniCoordinator can sleep instead of instantly re-pinging Spike on a healthy wait", async () => {
  const harness = await buildHarness({
    decisionReply: JSON.stringify({
      status: "continue",
      summary: "The live run is healthy; wait before the next wake-up.",
      next_prompt: "Wake later and keep monitoring the same live proof line.",
      sleep_minutes: 15,
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
    phase: "running",
    continuation_count: 2,
    last_evaluated_exchange_log_entries: 1,
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Initial Spike prompt",
    last_agent_reply: "The current live run is healthy.",
    exchange_log_entries: 4,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 4,
    status: "completed",
    finished_at: "2026-04-01T16:31:00.000Z",
    final_reply_text: "The current live run is healthy.",
    telegram_message_ids: ["901"],
    reply_to_message_id: "700",
    thread_id: "thread-1b",
  });

  await harness.coordinator.scanPendingSpikeFinals();

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(stored.auto_mode.phase, "sleeping");
  assert.equal(stored.auto_mode.continuation_count, 2);
  assert.equal(stored.auto_mode.last_evaluated_exchange_log_entries, 4);
  assert.equal(
    stored.auto_mode.sleep_next_prompt,
    "Wake later and keep monitoring the same live proof line.",
  );
  assert.match(stored.auto_mode.sleep_until, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(pendingPrompt, null);
  assert.equal(harness.execPrompts.length, 1);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /(sleeping for 15 min|сплю 15 мин)/u);
  assert.match(harness.sent[0].text, /Wake later and keep monitoring/u);
});

test("OmniCoordinator synthesizes a monitoring prompt when Omni returns sleep without next_prompt", async () => {
  const harness = await buildHarness({
    decisionReply: JSON.stringify({
      status: "continue",
      summary: "The live run is healthy; wait before the next wake-up.",
      next_prompt: null,
      sleep_minutes: 10,
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
    "Monitor the live run without restarting it.",
  );
  session = await harness.sessionService.updateAutoMode(session, {
    ...session.auto_mode,
    phase: "running",
    continuation_count: 4,
    last_evaluated_exchange_log_entries: 7,
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: [
      "Autonomous continuation context.",
      "",
      "Continuation task:",
      "Keep passive watch on the live CAD proof line and intervene only on real regressions.",
    ].join("\n"),
    last_agent_reply: "The rerun is healthy and still waiting on planner.generate_program.",
    exchange_log_entries: 8,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 8,
    status: "completed",
    finished_at: "2026-04-01T16:32:00.000Z",
    final_reply_text:
      "The rerun is healthy and still waiting on planner.generate_program.",
    telegram_message_ids: ["902"],
    reply_to_message_id: "701",
    thread_id: "thread-1c",
  });

  await harness.coordinator.scanPendingSpikeFinals();

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  assert.equal(stored.auto_mode.phase, "sleeping");
  assert.equal(stored.auto_mode.last_evaluated_exchange_log_entries, 8);
  assert.match(
    stored.auto_mode.sleep_next_prompt,
    /Continue from the latest confirmed live state without redoing already completed setup work\./u,
  );
  assert.match(
    stored.auto_mode.sleep_next_prompt,
    /The rerun is healthy and still waiting on planner\.generate_program\./u,
  );
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /(sleeping for 10 min|сплю 10 мин)/u);
});

test("OmniCoordinator evaluates with the resolved Omni model and reasoning profile", async () => {
  const execCalls = [];
  const harness = await buildHarness({
    decisionReply: JSON.stringify({
      status: "done",
      summary: "Goal complete.",
      next_prompt: null,
      user_message: "Done.",
      blocked_reason: null,
    }),
    startExecRun({ model, reasoningEffort, prompt }) {
      execCalls.push({ model, reasoningEffort, prompt });
      return {
        child: null,
        done: Promise.resolve({
          ok: true,
          finalReply: JSON.stringify({
            status: "done",
            summary: "Goal complete.",
            next_prompt: null,
            user_message: "Done.",
            blocked_reason: null,
          }),
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
  session = await harness.sessionStore.patch(session, {
    omni_model_override: "gpt-5.4-mini",
    omni_reasoning_effort_override: "high",
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
    last_agent_reply: "Everything is done.",
    exchange_log_entries: 3,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 3,
    status: "completed",
    finished_at: "2026-04-01T16:30:00.000Z",
    final_reply_text: "Everything is done.",
    telegram_message_ids: ["900"],
    reply_to_message_id: "700",
    thread_id: "thread-1",
  });

  await harness.coordinator.scanPendingSpikeFinals();

  assert.equal(execCalls.length, 1);
  assert.deepEqual(execCalls[0].model, "gpt-5.4-mini");
  assert.deepEqual(execCalls[0].reasoningEffort, "high");
});

test("OmniCoordinator evaluates inside the session workspace instead of the gateway repo", async () => {
  const execCalls = [];
  const harness = await buildHarness({
    startExecRun({ repoRoot, prompt }) {
      execCalls.push({ repoRoot, prompt });
      return {
        child: null,
        done: Promise.resolve({
          ok: true,
          finalReply: JSON.stringify({
            status: "done",
            summary: "Goal complete.",
            next_prompt: null,
            user_message: null,
            blocked_reason: null,
          }),
        }),
      };
    },
  });
  const baseSession = await ensureSession(harness.sessionStore);
  const biomedicalRoot = path.join(
    harness.workspaceRoot,
    "work",
    "labs",
    "research",
    "biomed",
    "medical-research-runtime",
  );
  await fs.mkdir(biomedicalRoot, { recursive: true });
  let session = await harness.sessionStore.patch(baseSession, {
    workspace_binding: buildBinding(biomedicalRoot),
  });
  session = await harness.sessionService.activateAutoMode(session, {
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
  });
  session = await harness.sessionService.captureAutoGoal(
    session,
    "Push the biomedical runtime forward.",
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
    last_agent_reply: "The biomedical repo still has work to do.",
    exchange_log_entries: 3,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 3,
    status: "completed",
    finished_at: "2026-04-03T13:00:00.000Z",
    final_reply_text: "The biomedical repo still has work to do.",
    telegram_message_ids: ["999"],
    reply_to_message_id: "700",
    thread_id: "thread-biomed",
  });

  await harness.coordinator.scanPendingSpikeFinals();

  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].repoRoot, biomedicalRoot);
});

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

  const stored = await harness.sessionStore.load("-1003577434463", "77");
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

  const stored = await harness.sessionStore.load("-1003577434463", "77");
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

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  assert.equal(stored.auto_mode.phase, "failed");
  assert.equal(harness.execPrompts.length, 0);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /invalid wake timestamp/u);
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

  const stored = await harness.sessionStore.load("-1003577434463", "77");
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

test("OmniCoordinator acknowledges the initial prompt handoff to Spike", async () => {
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

  const result = await harness.coordinator.handleHumanMessage(
    buildHumanTopicMessage({
      text: "Implement the first safe vertical slice.",
      messageId: 106,
    }),
  );

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(result.reason, "auto-initial-prompt-sent");
  assert.equal(stored.auto_mode.phase, "running");
  assert.equal(stored.auto_mode.initial_worker_prompt, "Implement the first safe vertical slice.");
  assert.equal(stored.auto_mode.last_omni_prompt_message_id, null);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /Spike/u);
  assert.match(pendingPrompt.prompt, /Implement the first safe vertical slice/u);
});

test("OmniCoordinator queues continuation prompts for Spike without visible Omni chatter", async () => {
  const harness = await buildHarness({
    decisionReply: JSON.stringify({
      status: "continue",
      summary: "Need one more continuation.",
      next_prompt: "Continue the remaining work.",
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
    phase: "running",
    pending_user_input: "Use the new deployment id.",
    continuation_count: 2,
    last_evaluated_exchange_log_entries: 1,
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Initial Spike prompt",
    last_agent_reply: "One step still remains.",
    exchange_log_entries: 4,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 4,
    status: "completed",
    finished_at: "2026-04-01T16:32:00.000Z",
    final_reply_text: "One step still remains.",
    telegram_message_ids: ["902"],
    reply_to_message_id: "700",
    thread_id: "thread-3",
  });

  const result = await harness.coordinator.scanPendingSpikeFinals();
  const stored = await harness.sessionStore.load("-1003577434463", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(result, undefined);
  assert.equal(stored.auto_mode.phase, "running");
  assert.equal(stored.auto_mode.pending_user_input, null);
  assert.equal(stored.auto_mode.continuation_count, 3);
  assert.equal(stored.auto_mode.last_evaluated_exchange_log_entries, 4);
  assert.equal(harness.execPrompts.length, 1);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /Omni -> Spike continuation handoff preview/u);
  assert.match(harness.sent[0].text, /Use the new deployment id/u);
  assert.match(harness.sent[0].text, /Continue the remaining work/u);
  assert.match(pendingPrompt.prompt, /Use the new deployment id/u);
});

test("OmniCoordinator marks invalid decision payloads as failed once instead of re-looping", async () => {
  const harness = await buildHarness({
    decisionReply: "{\"status\":\"blocked\"}",
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
    phase: "running",
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Initial Spike prompt",
    last_agent_reply: "Still not done.",
    exchange_log_entries: 5,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 5,
    status: "completed",
    finished_at: "2026-04-01T16:33:00.000Z",
    final_reply_text: "Still not done.",
    telegram_message_ids: ["903"],
    reply_to_message_id: "700",
    thread_id: "thread-4",
  });

  await harness.coordinator.scanPendingSpikeFinals();
  await harness.coordinator.scanPendingSpikeFinals();

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  assert.equal(stored.auto_mode.phase, "failed");
  assert.equal(stored.auto_mode.last_evaluated_exchange_log_entries, 5);
  assert.equal(harness.execPrompts.length, 1);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /blocked_reason/u);
});

test("OmniCoordinator treats interrupted Spike finals as an operator pause", async () => {
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

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  assert.equal(stored.auto_mode.phase, "blocked");
  assert.equal(stored.auto_mode.blocked_reason, "Interrupted by operator");
  assert.equal(stored.auto_mode.last_evaluated_exchange_log_entries, 6);
  assert.equal(harness.execPrompts.length, 0);
  assert.equal(harness.sent.length, 0);
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

test("OmniCoordinator does not re-evaluate after a continuation prompt is already queued", async () => {
  const harness = await buildHarness({
    decisionReply: JSON.stringify({
      status: "continue",
      summary: "Need one more continuation.",
      next_prompt: "Continue the remaining work.",
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
    phase: "running",
    pending_user_input: "Use the parked context.",
    continuation_count: 2,
    last_evaluated_exchange_log_entries: 1,
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Initial Spike prompt",
    last_agent_reply: "One step still remains.",
    exchange_log_entries: 8,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 8,
    status: "completed",
    finished_at: "2026-04-01T16:36:00.000Z",
    final_reply_text: "One step still remains.",
    telegram_message_ids: ["906"],
    reply_to_message_id: "700",
    thread_id: "thread-7",
  });

  await harness.coordinator.scanPendingSpikeFinals();
  await harness.coordinator.scanPendingSpikeFinals();

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(stored.lifecycle_state, "active");
  assert.equal(harness.execPrompts.length, 1);
  assert.match(pendingPrompt.prompt, /Use the parked context/u);
});

test("OmniCoordinator evaluates a newer Spike final even if phase is stale blocked", async () => {
  const harness = await buildHarness({
    decisionReply: JSON.stringify({
      status: "continue",
      summary: "Resume from the new Spike result.",
      next_prompt: "Continue from the newly completed pass.",
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
    last_spike_exchange_log_entries: 53,
    last_evaluated_exchange_log_entries: 53,
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Initial Spike prompt",
    last_agent_reply: "A new completed run landed despite the stale blocked state.",
    exchange_log_entries: 54,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 54,
    status: "completed",
    finished_at: "2026-04-01T16:38:00.000Z",
    final_reply_text: "A new completed run landed despite the stale blocked state.",
    telegram_message_ids: ["908"],
    reply_to_message_id: "700",
    thread_id: "thread-7b",
  });

  await harness.coordinator.scanPendingSpikeFinals();

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(stored.auto_mode.phase, "running");
  assert.equal(stored.auto_mode.blocked_reason, null);
  assert.equal(stored.auto_mode.last_spike_final_message_id, "908");
  assert.equal(stored.auto_mode.last_spike_exchange_log_entries, 54);
  assert.equal(stored.auto_mode.last_evaluated_exchange_log_entries, 54);
  assert.equal(stored.auto_mode.continuation_count, 1);
  assert.equal(harness.execPrompts.length, 1);
  assert.match(pendingPrompt.prompt, /Continue from the newly completed pass/u);
});

test("OmniCoordinator evaluates a newer Spike final even if phase is stale failed", async () => {
  const harness = await buildHarness({
    decisionReply: JSON.stringify({
      status: "continue",
      summary: "Resume from the newer Spike result after the transient Omni failure.",
      next_prompt: "Continue from the newly completed pass after the failed phase.",
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
    phase: "failed",
    last_result_summary: "Previous Omni decision parse failed.",
    last_spike_exchange_log_entries: 57,
    last_evaluated_exchange_log_entries: 57,
  });
  session = await harness.sessionStore.patch(session, {
    last_user_prompt: "Initial Spike prompt",
    last_agent_reply: "A new completed run landed despite the stale failed state.",
    exchange_log_entries: 58,
  });
  await harness.spikeFinalEventStore.write(session, {
    exchange_log_entries: 58,
    status: "completed",
    finished_at: "2026-04-01T16:39:00.000Z",
    final_reply_text: "A new completed run landed despite the stale failed state.",
    telegram_message_ids: ["909"],
    reply_to_message_id: "700",
    thread_id: "thread-7c",
  });

  await harness.coordinator.scanPendingSpikeFinals();

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(stored.auto_mode.phase, "running");
  assert.equal(stored.auto_mode.last_spike_final_message_id, "909");
  assert.equal(stored.auto_mode.last_spike_exchange_log_entries, 58);
  assert.equal(stored.auto_mode.last_evaluated_exchange_log_entries, 58);
  assert.equal(stored.auto_mode.continuation_count, 1);
  assert.equal(harness.execPrompts.length, 1);
  assert.match(
    pendingPrompt.prompt,
    /Continue from the newly completed pass after the failed phase/u,
  );
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

  const stored = await harness.sessionStore.load("-1003577434463", "77");
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
  let session = await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
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

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  const pendingPrompt = await harness.promptHandoffStore.load(stored);
  assert.equal(result.reason, "auto-disabled");
  assert.equal(stored.auto_mode.phase, "off");
  assert.equal(pendingPrompt, null);
});

test("OmniCoordinator can re-arm /auto cleanly after /auto off", async () => {
  const harness = await buildHarness();
  const baseSession = await ensureSession(harness.sessionStore);
  let session = await harness.sessionService.activateAutoMode(baseSession, {
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
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

  const stored = await harness.sessionStore.load("-1003577434463", "77");
  assert.equal(result.reason, "auto-armed");
  assert.equal(stored.auto_mode.enabled, true);
  assert.equal(stored.auto_mode.phase, "await_goal");
  assert.equal(stored.auto_mode.literal_goal_text, null);
});
