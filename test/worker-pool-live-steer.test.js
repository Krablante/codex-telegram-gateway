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

test("CodexWorkerPool buffers live steer input while the run is still starting and flushes it into the same run", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 203,
    topicName: "Steer buffer",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

  const progressGate = createDeferred();
  const finishGate = createDeferred();
  const steerCalls = [];
  const sentMessages = [];
  let firstSend = true;
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        if (firstSend) {
          firstSend = false;
          await progressGate.promise;
        }
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      steer({ input }) {
        steerCalls.push(input);
        return Promise.resolve({
          ok: true,
          reason: "steer-buffered",
          inputCount: input.length,
        });
      },
      finished: (async () => {
        await onEvent(
          {
            kind: "thread",
            eventType: "thread.started",
            text: "Codex thread started: buffered-thread",
            threadId: "buffered-thread",
          },
          {
            type: "thread.started",
            thread_id: "buffered-thread",
          },
        );
        await finishGate.promise;
        await onEvent(
          {
            kind: "agent_message",
            text: "Учёл буферизованное steer.",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Учёл буферизованное steer.",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "buffered-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const startPromise = workerPool.startPromptRun({
    session,
    prompt: "Стартуй основную задачу.",
    message: {
      message_id: 600,
      message_thread_id: 203,
    },
  });

  const buffered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "И ещё это не забудь.",
    message: {
      message_id: 601,
      message_thread_id: 203,
    },
  });

  assert.equal(buffered.ok, true);
  assert.equal(buffered.reason, "steer-buffered");

  progressGate.resolve();

  const started = await startPromise;
  assert.equal(started.ok, true);
  await waitFor(() => steerCalls.length === 1);
  assert.equal(steerCalls[0][0].type, "text");
  assert.match(steerCalls[0][0].text, /И ещё это не забудь\./u);

  finishGate.resolve();
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(sentMessages.at(-1).text, "Учёл буферизованное steer.");
  assert.equal(sentMessages.at(-1).reply_to_message_id, 601);
});

test("CodexWorkerPool restarts the run after an upstream interrupt that happens after accepted live steer", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-live-steer-restart-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 2033,
    topicName: "Live steer restart",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

  const sentMessages = [];
  const runCalls = [];
  const steerCalls = [];
  const firstAttemptFinished = createDeferred();
  const restartImagePath = "/tmp/live-steer-restart.png";
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
    runTask: ({ prompt, imagePaths, sessionThreadId, onEvent }) => {
      runCalls.push({ prompt, imagePaths, sessionThreadId });
      const child = { kill() {} };
      if (runCalls.length === 1) {
        return {
          child,
          steer({ input }) {
            steerCalls.push(input);
            return Promise.resolve({
              ok: true,
              reason: "steered",
            });
          },
          finished: firstAttemptFinished.promise,
        };
      }

      return {
        child,
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: aborted-thread",
              threadId: "aborted-thread",
            },
            {
              type: "thread.started",
              thread_id: "aborted-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "Учёл follow-up и продолжил run.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Учёл follow-up и продолжил run.",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "aborted-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Проверь тему и не умирай.",
    message: {
      message_id: 700,
      message_thread_id: 2033,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key)?.controller);

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "И ещё учти follow-up после live steer.",
    message: {
      message_id: 701,
      message_thread_id: 2033,
    },
    attachments: [
      {
        file_path: restartImagePath,
        is_image: true,
        mime_type: "image/png",
        size_bytes: 1234,
      },
    ],
  });
  assert.equal(steered.ok, true);
  assert.equal(steerCalls.length, 1);
  assert.equal(steerCalls[0][1].type, "localImage");
  assert.equal(steerCalls[0][1].path, restartImagePath);

  firstAttemptFinished.resolve({
    exitCode: null,
    signal: "SIGINT",
    threadId: "aborted-thread",
    warnings: [],
    interrupted: true,
    interruptReason: "upstream",
    abortReason: "interrupted",
    resumeReplacement: null,
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[1].sessionThreadId, "aborted-thread");
  assert.match(runCalls[1].prompt, /И ещё учти follow-up после live steer\./u);
  assert.deepEqual(runCalls[1].imagePaths, [restartImagePath]);

  const finalReply = sentMessages.at(-1)?.text || "";
  assert.equal(finalReply, "Учёл follow-up и продолжил run.");
  assert.equal(sentMessages.at(-1)?.reply_to_message_id, 701);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "aborted-thread");
  assert.equal(reloaded.last_agent_reply, "Учёл follow-up и продолжил run.");
});

test("CodexWorkerPool restarts a normal run after an upstream interrupt before the final answer", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-upstream-restart-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 2034,
    topicName: "Upstream restart",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

  const sentMessages = [];
  const runCalls = [];
  const runtimeEvents = [];
  const firstAttemptFinished = createDeferred();
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
    runtimeObserver: {
      appendEvent(type, details) {
        runtimeEvents.push({ type, details });
        return Promise.resolve();
      },
    },
    runTask: ({ prompt, imagePaths, sessionThreadId, onEvent }) => {
      runCalls.push({ prompt, imagePaths, sessionThreadId });
      const child = { kill() {} };
      if (runCalls.length === 1) {
        return {
          child,
          finished: firstAttemptFinished.promise,
        };
      }

      return {
        child,
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: aborted-upstream-thread",
              threadId: "aborted-upstream-thread",
            },
            {
              type: "thread.started",
              thread_id: "aborted-upstream-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "Продолжил после upstream abort.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Продолжил после upstream abort.",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "aborted-upstream-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Поищи ещё мусоры на новом устройстве.",
    message: {
      message_id: 702,
      message_thread_id: 2034,
    },
  });

  firstAttemptFinished.resolve({
    exitCode: null,
    signal: "SIGINT",
    threadId: "aborted-upstream-thread",
    warnings: [],
    interrupted: true,
    interruptReason: "upstream",
    abortReason: "interrupted",
    resumeReplacement: null,
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[1].sessionThreadId, "aborted-upstream-thread");
  assert.match(runCalls[1].prompt, /Поищи ещё мусоры на новом устройстве\./u);
  assert.deepEqual(runCalls[1].imagePaths, []);
  assert.deepEqual(runtimeEvents.map((event) => event.type), [
    "run.started",
    "run.attempt",
    "run.recovery",
    "run.attempt",
    "run.finished",
  ]);
  assert.equal(runtimeEvents[1].details.final_answer_seen, false);
  assert.equal(runtimeEvents[2].details.recovery_kind, "upstream-restart");
  assert.equal(runtimeEvents[2].details.same_thread_resume, true);
  assert.equal(runtimeEvents[3].details.requested_thread_id, "aborted-upstream-thread");
  assert.equal(runtimeEvents[3].details.final_answer_seen, true);
  assert.equal(runtimeEvents[4].details.status, "completed");
  assert.equal(runtimeEvents[4].details.thread_id, "aborted-upstream-thread");

  const finalReply = sentMessages.at(-1)?.text || "";
  assert.equal(finalReply, "Продолжил после upstream abort.");

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "aborted-upstream-thread");
  assert.equal(reloaded.last_agent_reply, "Продолжил после upstream abort.");
});

test("CodexWorkerPool survives two upstream interrupts before a later same-thread retry succeeds", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-upstream-restart-twice-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 2035,
    topicName: "Upstream restart twice",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

  const sentMessages = [];
  const runCalls = [];
  const runtimeEvents = [];
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
    runtimeObserver: {
      appendEvent(type, details) {
        runtimeEvents.push({ type, details });
        return Promise.resolve();
      },
    },
    runTask: ({ prompt, imagePaths, sessionThreadId, onEvent }) => {
      runCalls.push({ prompt, imagePaths, sessionThreadId });
      const attempt = runCalls.length;
      const child = { kill() {} };
      if (attempt < 3) {
        return {
          child,
          finished: Promise.resolve({
            exitCode: null,
            signal: "SIGINT",
            threadId: "sticky-upstream-thread",
            warnings: [],
            interrupted: true,
            interruptReason: "upstream",
            abortReason: "interrupted",
            resumeReplacement: null,
          }),
        };
      }

      return {
        child,
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: sticky-upstream-thread",
              threadId: "sticky-upstream-thread",
            },
            {
              type: "thread.started",
              thread_id: "sticky-upstream-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "Пережил двойной upstream abort.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Пережил двойной upstream abort.",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "sticky-upstream-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Добей после двух upstream abort подряд.",
    message: {
      message_id: 703,
      message_thread_id: 2035,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  assert.equal(runCalls.length, 3);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.equal(runCalls[1].sessionThreadId, "sticky-upstream-thread");
  assert.equal(runCalls[2].sessionThreadId, "sticky-upstream-thread");
  assert.deepEqual(runtimeEvents.map((event) => event.type), [
    "run.started",
    "run.attempt",
    "run.recovery",
    "run.attempt",
    "run.recovery",
    "run.attempt",
    "run.finished",
  ]);
  assert.equal(runtimeEvents[1].details.attempt, 1);
  assert.equal(runtimeEvents[2].details.attempt, 1);
  assert.equal(runtimeEvents[3].details.attempt, 2);
  assert.equal(runtimeEvents[4].details.attempt, 2);
  assert.equal(runtimeEvents[5].details.attempt, 3);
  assert.equal(runtimeEvents[3].details.requested_thread_id, "sticky-upstream-thread");
  assert.equal(runtimeEvents[5].details.requested_thread_id, "sticky-upstream-thread");
  assert.equal(runtimeEvents[6].details.status, "completed");
  assert.equal(runtimeEvents[6].details.thread_id, "sticky-upstream-thread");

  const finalReply = sentMessages.at(-1)?.text || "";
  assert.equal(finalReply, "Пережил двойной upstream abort.");

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "sticky-upstream-thread");
});

test("CodexWorkerPool clears stale continuity hints before a fresh rebuild without a prior thread", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-fresh-rebuild-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 20355,
    topicName: "Fresh rebuild",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });
  const continuitySeed = await sessionStore.patch(session, {
    provider_session_id: "stale-provider-session",
    codex_rollout_path: "/tmp/stale-rollout.jsonl",
    last_context_snapshot: {
      thread_id: "stale-thread",
      session_id: "stale-provider-session",
    },
  });

  const runCalls = [];
  const firstAttemptFinished = createDeferred();
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
    runTask: ({ sessionThreadId, skipThreadHistoryLookup, onEvent }) => {
      runCalls.push({ sessionThreadId, skipThreadHistoryLookup });
      const child = { kill() {} };
      if (runCalls.length === 1) {
        return {
          child,
          finished: firstAttemptFinished.promise,
        };
      }

      return {
        child,
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: fresh-rebuild-thread",
              threadId: "fresh-rebuild-thread",
            },
            {
              type: "thread.started",
              thread_id: "fresh-rebuild-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "Свежий rebuild дошёл до конца.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Свежий rebuild дошёл до конца.",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "fresh-rebuild-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session: continuitySeed,
    prompt: "Сделай fresh rebuild без старого thread id.",
    message: {
      message_id: 703,
      message_thread_id: 20355,
    },
  });

  firstAttemptFinished.resolve({
    exitCode: null,
    signal: "SIGINT",
    threadId: null,
    warnings: [],
    interrupted: true,
    interruptReason: "upstream",
    abortReason: "interrupted",
    resumeReplacement: null,
  });

  await waitFor(() => workerPool.getActiveRun(continuitySeed.session_key) === null, 5000);

  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, "stale-thread");
  assert.equal(runCalls[1].sessionThreadId, null);
  assert.equal(runCalls[1].skipThreadHistoryLookup, true);

  const reloaded = await sessionStore.load(continuitySeed.chat_id, continuitySeed.topic_id);
  assert.equal(reloaded.codex_thread_id, "fresh-rebuild-thread");
  assert.equal(reloaded.provider_session_id, null);
  assert.equal(reloaded.codex_rollout_path, null);
  assert.equal(reloaded.last_agent_reply, "Свежий rebuild дошёл до конца.");
});

test("CodexWorkerPool keeps a captured final answer when upstream aborts after the final message", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-upstream-final-answer-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 2036,
    topicName: "Upstream final answer",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

  const sentMessages = [];
  const runtimeEvents = [];
  let attemptCount = 0;
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
    runtimeObserver: {
      appendEvent(type, details) {
        runtimeEvents.push({ type, details });
        return Promise.resolve();
      },
    },
    runTask: ({ onEvent }) => {
      attemptCount += 1;
      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              eventType: "thread.started",
              text: "Codex thread started: interrupted-after-final-thread",
              threadId: "interrupted-after-final-thread",
            },
            {
              type: "thread.started",
              thread_id: "interrupted-after-final-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              eventType: "item.completed",
              text: "Финальный ответ уже был.",
              messagePhase: "final_answer",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Финальный ответ уже был.",
              },
            },
          );

          return {
            exitCode: null,
            signal: "SIGINT",
            threadId: "interrupted-after-final-thread",
            warnings: [],
            interrupted: true,
            interruptReason: "upstream",
            abortReason: "interrupted",
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Сохрани финальный ответ даже если upstream умрёт потом.",
    message: {
      message_id: 704,
      message_thread_id: 2036,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  assert.equal(attemptCount, 1);
  assert.deepEqual(runtimeEvents.map((event) => event.type), [
    "run.started",
    "run.attempt",
    "run.finished",
  ]);
  assert.equal(runtimeEvents[1].details.final_answer_seen, true);
  assert.equal(runtimeEvents[2].details.status, "completed");

  const finalReply = sentMessages.at(-1)?.text || "";
  assert.equal(finalReply, "Финальный ответ уже был.");

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "interrupted-after-final-thread");
});

test("CodexWorkerPool keeps pending live steer buffered when flush fails", async () => {
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
      patch(session) {
        return Promise.resolve(session);
      },
    },
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });

  workerPool.pendingLiveSteers.set("session-1", {
    input: [{ type: "text", text: "follow-up" }],
    exchangePrompt: "follow-up",
    replyToMessageId: 123,
  });

  const flushed = await workerPool.flushPendingLiveSteer("session-1", {
    controller: {
      steer() {
        return Promise.resolve({
          ok: false,
          reason: "transport-recovering",
        });
      },
    },
    exchangePrompt: "base",
    state: {
      replyToMessageId: null,
    },
  });

  assert.equal(flushed, false);
  assert.deepEqual(workerPool.pendingLiveSteers.get("session-1"), {
    input: [{ type: "text", text: "follow-up" }],
    exchangePrompt: "follow-up",
    replyToMessageId: 123,
  });
});

test("CodexWorkerPool retries buffered live steer flush across a transient transport recovery", async () => {
  const steerCalls = [];
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
      patch(session) {
        return Promise.resolve(session);
      },
    },
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });

  workerPool.pendingLiveSteers.set("session-1", {
    input: [{ type: "text", text: "follow-up" }],
    exchangePrompt: "follow-up",
    replyToMessageId: 123,
  });

  const run = {
    controller: {
      steer({ input }) {
        steerCalls.push(input);
        if (steerCalls.length === 1) {
          return Promise.resolve({
            ok: false,
            reason: "transport-recovering",
          });
        }

        return Promise.resolve({
          ok: true,
          reason: "steered",
        });
      },
    },
    exchangePrompt: "base",
    state: {
      finalizing: false,
      replyToMessageId: null,
    },
  };
  workerPool.activeRuns.set("session-1", run);

  const flushed = await workerPool.flushPendingLiveSteer("session-1", run);

  assert.equal(flushed, true);
  assert.equal(steerCalls.length, 2);
  assert.equal(workerPool.pendingLiveSteers.has("session-1"), false);
  assert.equal(run.exchangePrompt, "base\n\nfollow-up");
  assert.equal(run.state.replyToMessageId, 123);
});

test("CodexWorkerPool refuses to buffer live steer after the run is already finalizing", async () => {
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
      patch(session) {
        return Promise.resolve(session);
      },
    },
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });

  const session = {
    session_key: "session-2",
  };
  workerPool.activeRuns.set("session-2", {
    controller: null,
    state: {
      finalizing: true,
    },
  });

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "late follow-up",
    message: {
      message_id: 55,
    },
  });

  assert.equal(steered.ok, false);
  assert.equal(steered.reason, "finalizing");
  assert.equal(workerPool.pendingLiveSteers.has("session-2"), false);
});

test("CodexWorkerPool retries transient live steer failures while the run is still active", async () => {
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
      patch(session) {
        return Promise.resolve(session);
      },
    },
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });

  const session = {
    session_key: "session-3",
    ui_language: "rus",
  };
  const steerCalls = [];
  const run = {
    exchangePrompt: "base",
    controller: {
      async steer({ input }) {
        steerCalls.push(input);
        if (steerCalls.length < 3) {
          return { ok: false, reason: "steer-failed" };
        }
        return {
          ok: true,
          reason: "steered",
          inputCount: input.length,
        };
      },
    },
    state: {
      finalizing: false,
      replyToMessageId: null,
    },
  };
  workerPool.activeRuns.set(session.session_key, run);

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt: "Повтори steer после временного сбоя.",
    message: {
      message_id: 321,
    },
  });

  assert.equal(steered.ok, true);
  assert.equal(steered.reason, "steered");
  assert.equal(steerCalls.length, 3);
  assert.match(run.exchangePrompt, /Повтори steer после временного сбоя\./u);
  assert.equal(run.state.replyToMessageId, 321);
});

test("CodexWorkerPool keeps root thread state when foreign subagent events arrive", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 2032,
    topicName: "Foreign thread isolation",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent(
          {
            kind: "thread",
            eventType: "thread.started",
            text: "Codex thread started: root-thread",
            threadId: "root-thread",
            isPrimaryThreadEvent: true,
          },
          {
            method: "thread/started",
            params: {
              threadId: "root-thread",
            },
          },
        );
        await onEvent(
          {
            kind: "turn",
            eventType: "turn.started",
            text: "Codex turn started",
            threadId: "root-thread",
            turnId: "root-turn",
            isPrimaryThreadEvent: true,
          },
          {
            method: "turn/started",
            params: {
              threadId: "root-thread",
              turn: { id: "root-turn" },
            },
          },
        );
        await onEvent(
          {
            kind: "thread",
            eventType: "thread.started",
            text: "Codex thread started: foreign-thread",
            threadId: "foreign-thread",
            isPrimaryThreadEvent: false,
          },
          {
            method: "thread/started",
            params: {
              threadId: "foreign-thread",
            },
          },
        );
        await onEvent(
          {
            kind: "turn",
            eventType: "turn.started",
            text: "Codex turn started",
            threadId: "foreign-thread",
            turnId: "foreign-turn",
            isPrimaryThreadEvent: false,
          },
          {
            method: "turn/started",
            params: {
              threadId: "foreign-thread",
              turn: { id: "foreign-turn" },
            },
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            text: "Подсказка от сабагента.",
            messagePhase: "commentary",
            threadId: "foreign-thread",
            isPrimaryThreadEvent: false,
          },
          {
            method: "item/completed",
            params: {
              threadId: "foreign-thread",
              item: {
                type: "agentMessage",
                text: "Подсказка от сабагента.",
                phase: "commentary",
              },
            },
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            text: "Неправильный финал сабагента.",
            messagePhase: "final_answer",
            threadId: "foreign-thread",
            isPrimaryThreadEvent: false,
          },
          {
            method: "item/completed",
            params: {
              threadId: "foreign-thread",
              item: {
                type: "agentMessage",
                text: "Неправильный финал сабагента.",
                phase: "final_answer",
              },
            },
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            text: "Корневой финал.",
            messagePhase: "final_answer",
            threadId: "root-thread",
            isPrimaryThreadEvent: true,
          },
          {
            method: "item/completed",
            params: {
              threadId: "root-thread",
              item: {
                type: "agentMessage",
                text: "Корневой финал.",
                phase: "final_answer",
              },
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "root-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "Проверь foreign thread isolation.",
    message: {
      message_id: 610,
      message_thread_id: 2032,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.codex_thread_id, "root-thread");
  assert.equal(reloaded.last_agent_reply, "Корневой финал.");
  assert.equal(sentMessages.at(-1).text, "Корневой финал.");
});

test("CodexWorkerPool does not let late live events clobber a completed run back to running", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 2031,
    topicName: "Late event race",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent(
          {
            kind: "agent_message",
            text: "BASE_REPLY",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "BASE_REPLY",
            },
          },
        );

        setTimeout(() => {
          void onEvent(
            {
              kind: "agent_message",
              text: "LATE_REPLY",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "LATE_REPLY",
              },
            },
          );
        }, 0);

        return {
          exitCode: 0,
          signal: null,
          threadId: "late-event-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  workerPool.deliverRunDocuments = async (nextSession) => {
    await sleep(20);
    return {
      successes: [],
      failures: [],
      parked: false,
      session: nextSession,
    };
  };

  await workerPool.startPromptRun({
    session,
    prompt: "Проверь late event race.",
    message: {
      message_id: 602,
      message_thread_id: 2031,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 5000);

  const meta = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(meta.last_run_status, "completed");
  assert.equal(
    ["BASE_REPLY", "LATE_REPLY"].includes(meta.last_agent_reply),
    true,
  );
  assert.doesNotMatch(meta.last_agent_reply, /Не смог закончить run\./u);

  const exchangeLog = await sessionStore.loadExchangeLog(meta);
  assert.equal(exchangeLog.at(-1).status, "completed");
  assert.equal(exchangeLog.at(-1).assistant_reply, meta.last_agent_reply);
  assert.equal(sentMessages.at(-1).text, meta.last_agent_reply);
});

test("CodexWorkerPool surfaces non-interrupt run failures instead of interrupted text", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 203,
    topicName: "Failure reply",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

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
    runTask: () => ({
      child: { kill() {} },
      finished: Promise.resolve({
        exitCode: 2,
        signal: null,
        threadId: "failed-thread",
        warnings: ["error: unexpected argument '--session-source' found"],
        resumeReplacement: null,
      }),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Проверка ошибки.",
    message: {
      message_id: 602,
      message_thread_id: 203,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  const finalReply = sentMessages.at(-1)?.text || "";
  assert.match(finalReply, /Не смог закончить run\./u);
  assert.match(finalReply, /unexpected argument '--session-source'/u);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "failed");
  assert.match(reloaded.last_agent_reply, /Не смог закончить run\./u);
});

test("CodexWorkerPool keeps repeated upstream SIGINT runs as interrupted after two automatic restarts", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 2032,
    topicName: "Upstream interrupt reply",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

  const sentMessages = [];
  let attemptCount = 0;
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
    runTask: () => {
      attemptCount += 1;
      return {
        child: { kill() {} },
        finished: Promise.resolve({
          exitCode: null,
          signal: "SIGINT",
          threadId: `upstream-interrupted-thread-${attemptCount}`,
          warnings: [],
          interrupted: true,
          interruptReason: "upstream",
          abortReason: "interrupted",
          resumeReplacement: null,
        }),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Проверь neutral interrupt.",
    message: {
      message_id: 603,
      message_thread_id: 2032,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(attemptCount, 3);
  const finalReply = sentMessages.at(-1)?.text || "";
  assert.doesNotMatch(finalReply, /Не смог закончить run\./u);
  assert.match(finalReply, /Выполнение run было прервано до финального ответа\./u);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "interrupted");
  assert.equal(reloaded.codex_thread_id, "upstream-interrupted-thread-3");
  assert.match(reloaded.last_agent_reply, /Выполнение run было прервано до финального ответа\./u);
});

test("CodexWorkerPool localizes failure replies to English when the session UI language is ENG", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 2031,
    topicName: "English failure",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });
  session = await sessionStore.patch(session, {
    ui_language: "eng",
  });

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
    runTask: () => ({
      child: { kill() {} },
      finished: Promise.resolve({
        exitCode: 2,
        signal: null,
        threadId: "failed-thread-eng",
        warnings: ["boom"],
        resumeReplacement: null,
      }),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Check the failure path.",
    message: {
      message_id: 603,
      message_thread_id: 2031,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  const finalReply = sentMessages.at(-1)?.text || "";
  assert.match(finalReply, /Could not finish the run\./u);
  assert.match(finalReply, /Error: boom/u);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "failed");
  assert.match(reloaded.last_agent_reply, /Could not finish the run\./u);
});

test("CodexWorkerPool treats a starting run as busy before progress delivery completes", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 204,
    topicName: "Starting busy guard",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

  const progressDeferred = createDeferred();
  let runStarted = false;
  const sentMessages = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        if (payload.text === "...") {
          await progressDeferred.promise;
        }

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
    runTask: ({ onEvent }) => {
      runStarted = true;
      return {
        child: {
          kill() {},
        },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              text: "Codex thread started: guard-thread",
              threadId: "guard-thread",
            },
            {
              type: "thread.started",
              thread_id: "guard-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              text: "guard complete",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "guard complete",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "guard-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  const firstStart = workerPool.startPromptRun({
    session,
    prompt: "guard-first",
    message: {
      message_thread_id: 204,
    },
  });

  await waitFor(() => sentMessages.some((payload) => payload.text === "..."));
  const secondStart = await workerPool.startPromptRun({
    session,
    prompt: "guard-second",
    message: {
      message_thread_id: 204,
    },
  });

  assert.deepEqual(secondStart, { ok: false, reason: "busy" });
  assert.equal(runStarted, false);

  progressDeferred.resolve();
  await firstStart;
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(runStarted, true);
});

test("CodexWorkerPool shutdown waits for a reserved start to become interruptible", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 205,
    topicName: "Shutdown reserved start",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

  const progressDeferred = createDeferred();
  const runDeferred = createDeferred();
  const sentMessages = [];
  let runStarted = false;
  let killSignals = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        if (payload.text === "...") {
          await progressDeferred.promise;
        }

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
    runTask: () => {
      runStarted = true;
      return {
        child: {
          kill(signal) {
            killSignals.push(signal);
            runDeferred.resolve({
              exitCode: null,
              signal,
              threadId: null,
              warnings: [],
              resumeReplacement: null,
            });
          },
        },
        finished: runDeferred.promise,
      };
    },
  });

  const startPromise = workerPool.startPromptRun({
    session,
    prompt: "guard-shutdown",
    message: {
      message_thread_id: 205,
    },
  });

  await waitFor(() => sentMessages.some((payload) => payload.text === "..."));
  const shutdownPromise = workerPool.shutdown();
  let shutdownFinished = false;
  shutdownPromise.then(() => {
    shutdownFinished = true;
  });

  await sleep(30);
  assert.equal(shutdownFinished, false);
  assert.equal(runStarted, false);

  progressDeferred.resolve();
  await shutdownPromise;
  await startPromise;

  assert.equal(runStarted, false);
  assert.deepEqual(killSignals, []);
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "interrupted");
});

test("CodexWorkerPool does not interrupt runs that already finished finalization work", async () => {
  const workerPool = new CodexWorkerPool({
    api: {},
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore: {},
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });

  workerPool.activeRuns.set("finished-session", {
    state: {
      status: "completed",
      interruptRequested: false,
      progress: { queueUpdate() {} },
    },
    child: {
      kill() {
        throw new Error("should not kill a completed run");
      },
    },
  });

  assert.equal(workerPool.interrupt("finished-session"), false);
});

test("CodexWorkerPool keeps a completed final answer even if interrupt lands late", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 2041,
    topicName: "Late interrupt",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

  const deferred = createDeferred();
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
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent(
          {
            kind: "agent_message",
            text: "Готовый финальный ответ.",
            messagePhase: "final_answer",
            isPrimaryThreadEvent: true,
          },
          null,
        );
        deferred.resolve();
        await sleep(20);
        return {
          exitCode: 0,
          signal: null,
          threadId: "late-interrupt-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "late-interrupt",
    message: {
      message_id: 31,
      message_thread_id: 2041,
    },
  });

  await deferred.promise;
  assert.equal(workerPool.interrupt(session.session_key), true);
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.last_agent_reply, "Готовый финальный ответ.");
  assert.equal(sentMessages.at(-1).text, "Готовый финальный ответ.");
});
