import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexWorkerPool } from "../src/pty-worker/worker-pool.js";
import { SessionStore } from "../src/session-manager/session-store.js";
import { SpikeFinalEventStore } from "../src/session-manager/spike-final-event-store.js";
import {
  createDeferred,
  sleep,
  waitFor,
} from "../test-support/worker-pool-fixtures.js";

test("CodexWorkerPool preserves continuity metadata when native resume stays unavailable after retry", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 144,
    topicName: "Resume fallback test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
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
  const runTask = ({ prompt, sessionThreadId, onEvent }) => {
    runCalls.push({ prompt, sessionThreadId });
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
  assert.match(runCalls[1].prompt, /Telegram topic routing context:/u);
  assert.match(runCalls[1].prompt, /topic_id: 144/u);
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
  assert.equal(sentMessages[0].text, "...");
  assert.match(sentMessages.at(-1).text, /Could not finish the run|Не смог закончить run/u);
  assert.match(sentMessages.at(-1).text, /continuity metadata was preserved/u);
  assert.equal(sentMessages.at(-1).reply_to_message_id, 99);
  assert.equal(deletedMessages.length, 1);
});



test("CodexWorkerPool keeps commentary progress visible even after later command and turn events", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 189,
    topicName: "Progress rewrite test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
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

  assert.equal(sentMessages[0].text, "...");
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
    chatId: -1003577434463,
    topicId: 202,
    topicName: "Steer queue",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
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
    runTask: ({ prompt, sessionThreadId, onEvent }) => {
      runCalls.push({ prompt, sessionThreadId });
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
  assert.doesNotMatch(steerCalls[0][0].text, /Telegram topic routing context:/u);

  finishGate.resolve();

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.match(runCalls[0].prompt, /Telegram topic routing context:/u);
  assert.match(runCalls[0].prompt, /Сделай основную задачу\./u);
  assert.equal(sentMessages.at(-1).text, "Учёл live steer.");
  assert.equal(sentMessages.at(-1).reply_to_message_id, 501);
});



test("CodexWorkerPool shutdown waits for interrupted runs to finish teardown", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 204,
    topicName: "Shutdown test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
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
    chatId: -1003577434463,
    topicId: 2041,
    topicName: "Interrupt fallback test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
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
    chatId: -1003577434463,
    topicId: 205,
    topicName: "Shutdown drain test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
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
      finished: deferred.promise,
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

  deferred.resolve({
    exitCode: 0,
    signal: null,
    threadId: "drained-thread",
    warnings: [],
    resumeReplacement: null,
  });

  await shutdownPromise;

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "drained-thread");
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
  const sessionKey = "-1003577434463:2051";
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
