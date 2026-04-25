import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexWorkerPool } from "../src/pty-worker/worker-pool.js";
import { SessionStore } from "../src/session-manager/session-store.js";
import { withSuppressedConsole } from "../test-support/console-fixtures.js";
import {
  createDeferred,
  sleep,
  waitFor,
} from "../test-support/worker-pool-fixtures.js";

const INITIAL_PROGRESS_TEXT = "...";

test("CodexWorkerPool preserves continuity metadata when native resume stays unavailable after retry", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 144,
    topicName: "Resume fallback test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_thread_id: "stale-thread",
    last_user_prompt: "Remember sentinel SENTINEL_FOX",
    last_agent_reply: "SENTINEL_FOX",
    last_run_status: "completed",
  });
  await sessionStore.appendExchangeLogEntry(resumedSession, {
    created_at: "2026-03-22T12:00:00.000Z",
    status: "completed",
    user_prompt: "Remember sentinel SENTINEL_FOX",
    assistant_reply: "SENTINEL_FOX",
  });

  await sessionStore.writeSessionText(
    resumedSession,
    "active-brief.md",
    "# Active brief\n\nSentinel: SENTINEL_FOX\n",
  );

  const sentMessages = [];
  const editedMessages = [];
  const deletedMessages = [];
  const runCalls = [];
  const runTask = ({ prompt, baseInstructions, sessionThreadId }) => {
    runCalls.push({ prompt, baseInstructions, sessionThreadId });
    const child = {
      kill() {},
    };

    if (runCalls.length <= 2) {
      return {
        child,
        finished: Promise.resolve({
          exitCode: 0,
          signal: null,
          threadId: "replacement-thread",
          warnings: [],
          resumeReplacement: {
            requestedThreadId: "stale-thread",
            replacementThreadId: "replacement-thread",
          },
        }),
      };
    }

    throw new Error(`unexpected extra run attempt #${runCalls.length}`);
  };

  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async editMessageText(payload) {
        editedMessages.push(payload);
        return { ok: true };
      },
      async deleteMessage(payload) {
        deletedMessages.push(payload);
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 2,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    sessionCompactor: {
      async compact(meta) {
        return {
          session: meta,
          activeBrief: "# Active brief\n\nSentinel: SENTINEL_FOX\n",
          exchangeLogEntries: 1,
        };
      },
    },
    runTask,
  });

  await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "What sentinel did we agree on?",
    message: {
      message_id: 99,
      message_thread_id: 144,
    },
  });

  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, "stale-thread");
  assert.equal(runCalls[1].sessionThreadId, "replacement-thread");
  assert.doesNotMatch(runCalls[1].prompt, /Context:/u);
  assert.match(runCalls[1].baseInstructions, /Context:/u);
  assert.match(
    runCalls[1].baseInstructions,
    /Telegram topic 144 \(-1001234567890:144\)/u,
  );
  assert.match(runCalls[1].prompt, /What sentinel did we agree on\?/u);

  const meta = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.equal(meta.codex_thread_id, "replacement-thread");
  assert.equal(meta.last_run_status, "interrupted");
  assert.match(meta.last_agent_reply, /continuity metadata was preserved/u);

  const exchangeLog = await sessionStore.loadExchangeLog(resumedSession);
  assert.equal(exchangeLog.length, 2);
  assert.equal(exchangeLog.at(-1).status, "interrupted");
  assert.equal(exchangeLog.at(-1).user_prompt, "What sentinel did we agree on?");
  assert.match(exchangeLog.at(-1).assistant_reply, /continuity metadata was preserved/u);

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
  assert.match(sentMessages.at(-1).text, /Could not finish the run|Не смог закончить run/u);
  assert.match(sentMessages.at(-1).text, /continuity metadata was preserved/u);
  assert.equal(sentMessages.at(-1).reply_to_message_id, 99);
  assert.equal(deletedMessages.length, 1);
});

test("CodexWorkerPool passes the stored rollout path into runTask for continuity-aware runs", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-path-pass-through-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 145,
    topicName: "Known rollout path",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_thread_id: "resume-thread",
    provider_session_id: "provider-session",
    codex_rollout_path: "/tmp/stored-rollout-path.jsonl",
  });

  const runCalls = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        return { message_id: payload.reply_to_message_id ?? 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      codexGatewayBackend: "app-server",
      codexEnableLegacyAppServer: true,
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ knownRolloutPath, onEvent }) => {
      runCalls.push({ knownRolloutPath });
      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent(
            {
              kind: "agent_message",
              text: "Продолжение дошло до конца.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Продолжение дошло до конца.",
              },
            },
          );
          return {
            exitCode: 0,
            signal: null,
            threadId: "resume-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  const started = await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "Продолжай с уже известным rollout path.",
    message: {
      message_id: 1001,
    },
  });
  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);
  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].knownRolloutPath, "/tmp/stored-rollout-path.jsonl");
});

test("CodexWorkerPool clears stale provider session metadata when a fresh thread starts without a new provider id yet", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-thread-switch-provider-clear-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 146,
    topicName: "Fresh thread without provider session",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });
  const resumedSession = await sessionStore.patch(session, {
    codex_thread_id: "stale-thread",
    provider_session_id: "stale-provider-session",
    codex_rollout_path: "/tmp/stale-rollout.jsonl",
    last_context_snapshot: {
      thread_id: "stale-thread",
      session_id: "stale-provider-session",
      rollout_path: "/tmp/stale-rollout.jsonl",
    },
  });

  const runCalls = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        return { message_id: payload.reply_to_message_id ?? 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ knownRolloutPath, providerSessionId, onRuntimeState, onEvent }) => {
      runCalls.push({ knownRolloutPath, providerSessionId });
      return {
        child: { kill() {} },
        finished: (async () => {
          await onRuntimeState({
            threadId: "fresh-thread",
          });
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "Fresh thread finished.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Fresh thread finished.",
              },
            },
          );
          return {
            exitCode: 0,
            signal: null,
            threadId: "fresh-thread",
            warnings: [],
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "Continue after a fresh thread switch.",
    message: {
      message_id: 101,
      message_thread_id: 146,
    },
  });

  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  const reloaded = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.deepEqual(runCalls, [
    {
      knownRolloutPath: null,
      providerSessionId: null,
    },
  ]);
  assert.equal(reloaded.codex_thread_id, "fresh-thread");
  assert.equal(reloaded.provider_session_id, null);
  assert.equal(reloaded.codex_rollout_path, null);
  assert.equal(reloaded.last_context_snapshot, null);
});

test("CodexWorkerPool clears legacy app-server metadata when exec-json runTask throws", async (t) => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-exec-json-throw-cleanup-"),
  );
  t.after(async () => {
    await fs.rm(sessionsRoot, { recursive: true, force: true });
  });
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 246,
    topicName: "Exec-json thrown cleanup",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });
  const staleSession = await sessionStore.patch(session, {
    codex_backend: "exec-json",
    last_run_backend: "exec-json",
    codex_thread_id: "stale-thread",
    codex_thread_model: "gpt-5.4",
    codex_thread_reasoning_effort: "medium",
    provider_session_id: "stale-provider-session",
    codex_rollout_path: "/tmp/stale-rollout.jsonl",
    last_context_snapshot: {
      thread_id: "stale-thread",
      session_id: "stale-provider-session",
      rollout_path: "/tmp/stale-rollout.jsonl",
    },
  });
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      codexGatewayBackend: "exec-json",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask() {
      throw new Error("spawn exploded before exec-json emitted state");
    },
  });

  await withSuppressedConsole("error", async () => {
    const started = await workerPool.startPromptRun({
      session: staleSession,
      prompt: "Trigger thrown exec-json failure.",
      message: {
        message_id: 246,
        message_thread_id: 246,
      },
    });
    assert.equal(started.ok, true);
    await waitFor(() => workerPool.getActiveRun(staleSession.session_key) === null);
  });

  const reloaded = await sessionStore.load(staleSession.chat_id, staleSession.topic_id);
  assert.equal(reloaded.last_run_status, "failed");
  assert.equal(reloaded.codex_backend, "exec-json");
  assert.equal(reloaded.last_run_backend, "exec-json");
  assert.equal(reloaded.codex_thread_id, null);
  assert.equal(reloaded.codex_thread_model, null);
  assert.equal(reloaded.codex_thread_reasoning_effort, null);
  assert.equal(reloaded.provider_session_id, null);
  assert.equal(reloaded.codex_rollout_path, null);
  assert.equal(reloaded.last_context_snapshot, null);
});

test("CodexWorkerPool suppresses stale final replies after a newer owner takes over", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-stale-final-suppression-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 147,
    topicName: "Stale final suppression",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const sentMessages = [];
  const deletedMessages = [];
  const deferred = createDeferred();
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage(payload) {
        deletedMessages.push(payload);
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    serviceGenerationId: "gen-old",
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent(
          {
            kind: "agent_message",
            text: "Stale final should stay hidden.",
            messagePhase: "final_answer",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Stale final should stay hidden.",
            },
          },
        );
        await deferred.promise;
        return {
          exitCode: 0,
          signal: null,
          threadId: "old-thread",
          warnings: [],
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Old prompt",
    message: {
      message_id: 1200,
      message_thread_id: 147,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) !== null);
  const activeRun = workerPool.getActiveRun(session.session_key);
  await sessionStore.patch(activeRun.session, {
    session_owner_generation_id: "gen-new",
    session_owner_mode: "active",
    last_run_status: "running",
    last_run_started_at: new Date(Date.parse(activeRun.startedAt) + 1000).toISOString(),
    last_user_prompt: "Newer prompt",
    last_agent_reply: "Newer reply",
  });

  await withSuppressedConsole("warn", async () => {
    deferred.resolve();
    await waitFor(() => workerPool.getActiveRun(session.session_key) === null);
  });

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.session_owner_generation_id, "gen-new");
  assert.equal(reloaded.spike_run_owner_generation_id, "gen-new");
  assert.equal(reloaded.last_run_status, "running");
  assert.equal(reloaded.last_user_prompt, "Newer prompt");
  assert.equal(reloaded.last_agent_reply, "Newer reply");
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
  assert.equal(deletedMessages.length, 1);

  const exchangeLog = await sessionStore.loadExchangeLog(session);
  assert.equal(exchangeLog.length, 0);
});



test("CodexWorkerPool keeps commentary progress visible even after later command and turn events", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 189,
    topicName: "Progress rewrite test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const sentMessages = [];
  const editedMessages = [];
  const chatActions = [];
  const deferred = createDeferred();
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: 1 };
      },
      async editMessageText(payload) {
        editedMessages.push(payload);
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
      async sendChatAction(payload) {
        chatActions.push(payload);
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent(
          {
            kind: "command",
            text: "Running command: rg --files src",
            command: "rg --files src",
          },
          {
            type: "item.started",
            item: {
              type: "command_execution",
              command: "rg --files src",
            },
          },
        );
        await deferred.promise;
        await onEvent(
          {
            kind: "agent_message",
            text: "Сначала быстро смотрю структуру.",
            messagePhase: "commentary",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Сначала быстро смотрю структуру.",
              phase: "commentary",
            },
          },
        );
        await onEvent(
          {
            kind: "command",
            text: "Completed command: rg --files src",
            command: "rg --files src",
            aggregatedOutput: "src/a.js\n",
          },
          {
            type: "item.completed",
            item: {
              type: "command_execution",
              command: "rg --files src",
              aggregated_output: "src/a.js\n",
              exit_code: 0,
            },
          },
        );
        await onEvent(
          {
            kind: "turn",
            text: "Codex turn completed",
            eventType: "turn.completed",
            turnId: "progress-turn",
          },
          {
            type: "turn.completed",
            turn_id: "progress-turn",
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "progress-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "show progress",
    message: {
      message_id: 19,
      message_thread_id: 189,
    },
  });

  await sleep(80);
  assert.equal(editedMessages.length, 0);

  deferred.resolve();
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
  assert.equal(
    editedMessages.some(
      (payload) =>
        /Сначала быстро смотрю структуру/u.test(payload.text) &&
        !/Completed command: rg --files src/u.test(payload.text) &&
        !/src\/a\.js/u.test(payload.text) &&
        /\n\n\.{3}$/u.test(payload.text),
    ),
    true,
  );
  assert.equal(
    chatActions.some((payload) => payload.action === "typing"),
    true,
  );
});



test("CodexWorkerPool steers an active run through the live controller without starting a second turn", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 202,
    topicName: "Steer queue",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const finishGate = createDeferred();
  const runCalls = [];
  const steerCalls = [];
  const sentMessages = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ prompt, baseInstructions, sessionThreadId, onEvent }) => {
      runCalls.push({ prompt, baseInstructions, sessionThreadId });
      return {
        child: { kill() {} },
        steer({ input }) {
          steerCalls.push(input);
          return Promise.resolve({
            ok: true,
            reason: "steered",
            inputCount: input.length,
          });
        },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: steer-thread",
              threadId: "steer-thread",
            },
            {
              type: "thread.started",
              thread_id: "steer-thread",
            },
          );
          await onEvent(
            {
              kind: "turn",
              eventType: "turn.started",
              text: "Codex turn started",
              threadId: "steer-thread",
              turnId: "turn-live",
            },
            {
              type: "turn.started",
              turn_id: "turn-live",
            },
          );
          await finishGate.promise;
          await onEvent(
            {
              kind: "agent_message",
              text: "Учёл live steer.",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Учёл live steer.",
              },
            },
          );
          await onEvent(
            {
              kind: "turn",
              eventType: "turn.completed",
              text: "Codex turn completed",
              threadId: "steer-thread",
              turnId: "turn-live",
            },
            {
              type: "turn.completed",
              turn_id: "turn-live",
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "steer-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "Сделай основную задачу.",
    message: {
      message_id: 500,
      message_thread_id: 202,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(session.session_key) !== null);
  await waitFor(
    () => workerPool.getActiveRun(session.session_key)?.state.activeTurnId === "turn-live",
  );

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "И ещё учти этот follow-up.",
    message: {
      message_id: 501,
      message_thread_id: 202,
    },
    attachments: [
      {
        file_path: "/tmp/steer-note.txt",
        is_image: false,
        mime_type: "text/plain",
        size_bytes: 42,
      },
    ],
  });

  assert.equal(steered.ok, true);
  assert.equal(steered.reason, "steered");
  assert.equal(steerCalls.length, 1);
  assert.equal(runCalls.length, 1);
  assert.equal(steerCalls[0][0].type, "text");
  assert.match(steerCalls[0][0].text, /И ещё учти этот follow-up\./u);
  assert.match(steerCalls[0][0].text, /К сообщению приложены вложения из Telegram/u);
  assert.doesNotMatch(steerCalls[0][0].text, /Context:/u);

  finishGate.resolve();

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.doesNotMatch(runCalls[0].prompt, /Context:/u);
  assert.match(runCalls[0].baseInstructions, /Context:/u);
  assert.match(runCalls[0].prompt, /Сделай основную задачу\./u);
  assert.equal(sentMessages.at(-1).text, "Учёл live steer.");
  assert.equal(sentMessages.at(-1).reply_to_message_id, 501);
});

test("CodexWorkerPool recovers exec-json live steer after the interrupted child exits with code 1", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 203,
    topicName: "Exec steer recovery",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const firstAttemptFinished = createDeferred();
  const runCalls = [];
  const steerCalls = [];
  const sentMessages = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      codexGatewayBackend: "exec-json",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ prompt, baseInstructions, sessionThreadId, onEvent }) => {
      runCalls.push({ prompt, baseInstructions, sessionThreadId });
      const attempt = runCalls.length;
      const child = { kill() {} };
      if (attempt === 1) {
        return {
          child,
          steer({ input }) {
            steerCalls.push(input);
            firstAttemptFinished.resolve();
            return Promise.resolve({ ok: true, reason: "steered" });
          },
          finished: (async () => {
            await onEvent(
              {
                kind: "thread",
                eventType: "thread.started",
                text: "Codex thread started: steer-thread",
                threadId: "steer-thread",
              },
              {
                type: "thread.started",
                thread_id: "steer-thread",
              },
            );
            await onEvent(
              {
                kind: "turn",
                eventType: "turn.started",
                text: "Codex turn started",
                threadId: "steer-thread",
                turnId: "turn-live",
              },
              {
                type: "turn.started",
                turn_id: "turn-live",
              },
            );
            await firstAttemptFinished.promise;
            return {
              backend: "exec-json",
              ok: false,
              exitCode: 1,
              signal: null,
              interrupted: true,
              interruptReason: "upstream",
              preserveContinuity: true,
              threadId: "steer-thread",
              warnings: [],
              resumeReplacement: null,
              abortReason: "interrupted",
            };
          })(),
        };
      }

      if (attempt === 2) {
        return {
          child,
          finished: (async () => {
            await onEvent(
              {
                kind: "agent_message",
                text: "Готово с учётом live steer.",
              },
              {
                type: "item.completed",
                item: {
                  type: "agent_message",
                  text: "Готово с учётом live steer.",
                },
              },
            );
            await onEvent(
              {
                kind: "turn",
                eventType: "turn.completed",
                text: "Codex turn completed",
                threadId: "steer-thread",
                turnId: "turn-live-2",
              },
              {
                type: "turn.completed",
                turn_id: "turn-live-2",
              },
            );

            return {
              backend: "exec-json",
              ok: true,
              exitCode: 0,
              signal: null,
              threadId: "steer-thread",
              warnings: [],
              resumeReplacement: null,
              abortReason: null,
            };
          })(),
        };
      }

      throw new Error(`unexpected extra run attempt #${attempt}`);
    },
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "Сделай основную задачу.",
    message: {
      message_id: 600,
      message_thread_id: 203,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(session.session_key) !== null);
  await waitFor(
    () => workerPool.getActiveRun(session.session_key)?.state.activeTurnId === "turn-live",
  );

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "Ещё проверь удалённые хосты.",
    message: {
      message_id: 601,
      message_thread_id: 203,
    },
  });

  assert.equal(steered.ok, true);
  assert.equal(steered.reason, "steered");
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(steerCalls.length, 1);
  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[1].sessionThreadId, "steer-thread");
  assert.match(runCalls[1].prompt, /Сделай основную задачу\./u);
  assert.match(runCalls[1].prompt, /Ещё проверь удалённые хосты\./u);
  assert.equal(sentMessages.at(-1).text, "Готово с учётом live steer.");
  assert.equal(sentMessages.at(-1).reply_to_message_id, 601);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "steer-thread");
  assert.doesNotMatch(reloaded.last_agent_reply, /stream ended before turn\.completed/u);
});



test("CodexWorkerPool restarts exec-json live steer even if the old child exits cleanly", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-clean-steer-restart-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 205,
    topicName: "Exec clean steer restart",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const steerAccepted = createDeferred();
  const runCalls = [];
  const steerCalls = [];
  const sentMessages = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      codexGatewayBackend: "exec-json",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ prompt, sessionThreadId, onEvent }) => {
      runCalls.push({ prompt, sessionThreadId });
      const attempt = runCalls.length;
      const child = { kill() {} };
      if (attempt === 1) {
        return {
          child,
          steer({ input }) {
            steerCalls.push(input);
            steerAccepted.resolve();
            return Promise.resolve({ ok: true, reason: "steered" });
          },
          finished: (async () => {
            await onEvent({
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: clean-steer-thread",
              threadId: "clean-steer-thread",
            });
            await steerAccepted.promise;
            await onEvent({
              kind: "agent_message",
              eventType: "turn.completed",
              text: "Stale answer before steer was applied.",
              messagePhase: "final_answer",
            });
            return {
              backend: "exec-json",
              ok: true,
              exitCode: 0,
              signal: null,
              threadId: "clean-steer-thread",
              warnings: [],
              resumeReplacement: null,
              abortReason: null,
            };
          })(),
        };
      }

      return {
        child,
        finished: (async () => {
          await onEvent({
            kind: "agent_message",
            eventType: "turn.completed",
            text: "Fresh answer after live steer.",
            messagePhase: "final_answer",
          });
          return {
            backend: "exec-json",
            ok: true,
            exitCode: 0,
            signal: null,
            threadId: "clean-steer-thread",
            warnings: [],
            resumeReplacement: null,
            abortReason: null,
          };
        })(),
      };
    },
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "Original task.",
    message: {
      message_id: 800,
      message_thread_id: 205,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(session.session_key)?.controller);

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "Apply this follow-up before final.",
    message: {
      message_id: 801,
      message_thread_id: 205,
    },
  });

  assert.equal(steered.ok, true);
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(steerCalls.length, 1);
  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[1].sessionThreadId, "clean-steer-thread");
  assert.match(runCalls[1].prompt, /Original task\./u);
  assert.match(runCalls[1].prompt, /Apply this follow-up before final\./u);
  assert.equal(sentMessages.at(-1).text, "Fresh answer after live steer.");
  assert.equal(sentMessages.at(-1).reply_to_message_id, 801);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.last_agent_reply, "Fresh answer after live steer.");
});

test("CodexWorkerPool shutdown waits for interrupted runs to finish teardown", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 204,
    topicName: "Shutdown test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const deferred = createDeferred();
  const killSignals = [];
  const serviceState = {
    acceptedPrompts: 0,
    lastPromptAt: null,
    activeRunCount: 0,
  };
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState,
    runTask: () => ({
      child: {
        kill(signal) {
          killSignals.push(signal);
          if (signal === "SIGINT") {
            setTimeout(() => {
              deferred.resolve({
                exitCode: null,
                signal: "SIGINT",
                threadId: "shutdown-thread",
                warnings: [],
                resumeReplacement: null,
              });
            }, 20);
          }
        },
      },
      finished: deferred.promise,
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "shutdown me",
    message: {
      message_id: 21,
      message_thread_id: 204,
    },
  });

  await waitFor(() => serviceState.activeRunCount === 1);

  let settled = false;
  const shutdownPromise = workerPool.shutdown().then(() => {
    settled = true;
  });

  await sleep(5);
  assert.equal(settled, false);

  await shutdownPromise;

  assert.deepEqual(killSignals, ["SIGINT"]);
  assert.equal(serviceState.activeRunCount, 0);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "interrupted");
  assert.equal(reloaded.codex_thread_id, "shutdown-thread");
});

test("CodexWorkerPool interrupt falls back to SIGINT immediately when native interrupt is not ready", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 2041,
    topicName: "Interrupt fallback test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const deferred = createDeferred();
  const killSignals = [];
  const serviceState = {
    acceptedPrompts: 0,
    lastPromptAt: null,
    activeRunCount: 0,
  };
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState,
    runTask: () => ({
      child: {
        kill(signal) {
          killSignals.push(signal);
        },
      },
      steer() {
        return Promise.resolve({ ok: false });
      },
      interrupt() {
        return Promise.resolve(false);
      },
      finished: deferred.promise,
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "interrupt me",
    message: {
      message_id: 31,
      message_thread_id: 2041,
    },
  });

  await waitFor(() => serviceState.activeRunCount === 1);
  assert.equal(workerPool.interrupt(session.session_key), true);
  await waitFor(() => killSignals.length > 0);
  assert.deepEqual(killSignals, ["SIGINT"]);

  deferred.resolve({
    exitCode: null,
    signal: "SIGINT",
    threadId: "interrupt-thread",
    warnings: [],
    resumeReplacement: null,
  });
  await waitFor(() => serviceState.activeRunCount === 0);
});

test("CodexWorkerPool shutdown can drain an active run before sending interrupts", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 205,
    topicName: "Shutdown drain test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const deferred = createDeferred();
  const killSignals = [];
  const serviceState = {
    acceptedPrompts: 0,
    lastPromptAt: null,
    activeRunCount: 0,
  };
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState,
    runTask: ({ onEvent }) => ({
      child: {
        kill(signal) {
          killSignals.push(signal);
        },
      },
      finished: (async () => {
        await deferred.promise;
        await onEvent(
          {
            kind: "agent_message",
            text: "Drained cleanly.",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Drained cleanly.",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "drained-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "drain me",
    message: {
      message_id: 22,
      message_thread_id: 205,
    },
  });

  await waitFor(() => serviceState.activeRunCount === 1);

  let settled = false;
  const shutdownPromise = workerPool.shutdown({
    drainTimeoutMs: 200,
    interruptActiveRuns: true,
  }).then(() => {
    settled = true;
  });

  await sleep(20);
  assert.equal(settled, false);
  assert.deepEqual(killSignals, []);

  deferred.resolve();

  await shutdownPromise;

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "drained-thread");
  assert.equal(reloaded.last_agent_reply, "Drained cleanly.");
  assert.deepEqual(killSignals, []);
});

test("CodexWorkerPool hard shutdown stays bounded even if a lifecycle promise never settles", async () => {
  const serviceState = {
    acceptedPrompts: 0,
    lastPromptAt: null,
    activeRunCount: 1,
  };
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
      async editMessageText() {
        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore: {
      async patch(session) {
        return session;
      },
      async appendExchangeLogEntry(session) {
        return { session };
      },
    },
    serviceState,
  });

  const lifecycle = createDeferred();
  const sessionKey = "-1001234567890:2051";
  workerPool.activeRuns.set(sessionKey, {
    sessionKey,
    session: {
      session_key: sessionKey,
      ui_language: "rus",
    },
    child: null,
    controller: null,
    lifecyclePromise: lifecycle.promise,
    exchangePrompt: "pending",
    includeTopicContext: true,
    state: {
      status: "starting",
      interruptRequested: false,
      latestSummary: null,
      latestSummaryKind: null,
      progress: {
        queueUpdate() {},
      },
    },
    startedAt: new Date().toISOString(),
    progressMessageId: null,
    progressTimer: null,
    runtimeProfileInputs: {},
  });

  let settled = false;
  const shutdownPromise = workerPool.shutdown({
    drainTimeoutMs: 50,
    interruptActiveRuns: true,
  }).then(() => {
    settled = true;
  });

  await sleep(200);

  assert.equal(settled, true);
  assert.equal(workerPool.activeRuns.get(sessionKey)?.state.interruptRequested, true);

  lifecycle.resolve();
  workerPool.activeRuns.clear();
  await shutdownPromise;
});
