import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildBinding,
  buildHarness,
  ensureSession,
} from "../test-support/omni-coordinator-fixtures.js";

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

  const stored = await harness.sessionStore.load("-1001234567890", "77");
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

  const stored = await harness.sessionStore.load("-1001234567890", "77");
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

  const stored = await harness.sessionStore.load("-1001234567890", "77");
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
  const stored = await harness.sessionStore.load("-1001234567890", "77");
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

  const stored = await harness.sessionStore.load("-1001234567890", "77");
  assert.equal(stored.auto_mode.phase, "failed");
  assert.equal(stored.auto_mode.last_evaluated_exchange_log_entries, 5);
  assert.equal(harness.execPrompts.length, 1);
  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /blocked_reason/u);
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

  const stored = await harness.sessionStore.load("-1001234567890", "77");
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

  const stored = await harness.sessionStore.load("-1001234567890", "77");
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

  const stored = await harness.sessionStore.load("-1001234567890", "77");
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
