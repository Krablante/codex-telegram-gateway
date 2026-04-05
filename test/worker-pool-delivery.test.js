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

test("CodexWorkerPool does not surface completed command output in progress without commentary", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 18901,
    topicName: "Command-only progress test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });

  const sentMessages = [];
  const editedMessages = [];
  const finishGate = createDeferred();
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
            kind: "command",
            text: "Completed command: rg --files src",
            command: "rg --files src",
            eventType: "item.completed",
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
        await finishGate.promise;
        await onEvent(
          {
            kind: "agent_message",
            text: "FINAL_ONLY",
            messagePhase: "final_answer",
          },
          {
            method: "item/completed",
            params: {
              item: {
                type: "agentMessage",
                text: "FINAL_ONLY",
                phase: "final_answer",
              },
              threadId: "command-only-thread",
              turnId: "command-only-turn",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "command-only-thread",
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
      message_id: 1901,
      message_thread_id: 18901,
    },
  });

  await sleep(1100);
  assert.equal(editedMessages.length, 0);

  finishGate.resolve();
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(sentMessages[0].text, "...");
  assert.equal(sentMessages.at(-1)?.text, "FINAL_ONLY");
});

test("CodexWorkerPool keeps commentary agent messages in progress and only final_answer becomes the final reply", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 1891,
    topicName: "Agent message phase test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });

  const sentMessages = [];
  const editedMessages = [];
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
            text: "Источник хаоса найден.",
            messagePhase: "commentary",
          },
          {
            method: "item/completed",
            params: {
              item: {
                type: "agentMessage",
                text: "Источник хаоса найден.",
                phase: "commentary",
              },
              threadId: "phase-thread",
              turnId: "phase-turn",
            },
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            text: "FINAL_REPORT",
            messagePhase: "final_answer",
          },
          {
            method: "item/completed",
            params: {
              item: {
                type: "agentMessage",
                text: "FINAL_REPORT",
                phase: "final_answer",
              },
              threadId: "phase-thread",
              turnId: "phase-turn",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "phase-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Сначала думай, потом дай итог.",
    message: {
      message_id: 191,
      message_thread_id: 1891,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  const meta = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(meta.last_run_status, "completed");
  assert.equal(meta.last_agent_reply, "FINAL_REPORT");
  assert.doesNotMatch(meta.last_agent_reply, /Источник хаоса найден\./u);
  assert.equal(
    editedMessages.some(
      (payload) =>
        /Источник хаоса найден\./u.test(payload.text) &&
        !/FINAL_REPORT/u.test(payload.text) &&
        /\n\n\.{3}$/u.test(payload.text),
    ),
    true,
  );
  assert.equal(sentMessages.at(-1)?.text, "FINAL_REPORT");
});

test("CodexWorkerPool never leaks noisy shell wrapper commands into progress", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 190,
    topicName: "Progress shell cleanup test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });

  const sentMessages = [];
  const editedMessages = [];
  const deferred = createDeferred();
  const noisyTelegramCommand =
    `/bin/bash -lc "sleep 29 && node --input-type=module -e 'const payload = { chat_id: -1001234567890, message_thread_id: 1560, text: \\"Тест\\" }; const res = await fetch(\\"https://api.telegram.org/botTOKEN/sendMessage\\", { method: \\"POST\\" });'"`;
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
            text: `Running command: ${noisyTelegramCommand}`,
            command: noisyTelegramCommand,
          },
          {
            type: "item.started",
            item: {
              type: "command_execution",
              command: noisyTelegramCommand,
            },
          },
        );
        await deferred.promise;
        await onEvent(
          {
            kind: "agent_message",
            text: "done",
            messagePhase: "commentary",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "done",
              phase: "commentary",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "progress-shell-cleanup-thread",
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
      message_id: 20,
      message_thread_id: 190,
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
        /done/u.test(payload.text) &&
        !/\/bin\/bash -lc/u.test(payload.text) &&
        !/api\.telegram\.org/u.test(payload.text) &&
        /\n\n\.{3}$/u.test(payload.text),
    ),
    true,
  );
});

test("CodexWorkerPool retries the final reply once after a Telegram rate limit", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 191,
    topicName: "Final reply retry test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });

  const sentMessages = [];
  let finalReplyAttempts = 0;
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        if (payload.text === "...") {
          sentMessages.push(payload);
          return { message_id: 1 };
        }

        finalReplyAttempts += 1;
        if (finalReplyAttempts === 1) {
          throw new Error("Telegram API sendMessage failed: Too Many Requests: retry after 0");
        }

        sentMessages.push(payload);
        return { message_id: sentMessages.length + 1 };
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
            text: "done",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "done",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "reply-retry-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "finish cleanly",
    message: {
      message_id: 22,
      message_thread_id: 191,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);

  assert.equal(finalReplyAttempts, 2);
  assert.equal(sentMessages[0].text, "...");
  assert.equal(sentMessages.at(-1).text, "done");
});

test("CodexWorkerPool falls back to a plain topic send when the reply target disappeared", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 1931,
    topicName: "Reply target fallback",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });

  const sentMessages = [];
  let finalReplyAttempts = 0;
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        if (payload.text === "...") {
          sentMessages.push(payload);
          return { message_id: 1 };
        }

        finalReplyAttempts += 1;
        if (finalReplyAttempts === 1) {
          assert.equal(payload.reply_to_message_id, 22);
          throw new Error(
            "Telegram API sendMessage failed: Bad Request: message to be replied not found",
          );
        }

        sentMessages.push(payload);
        return { message_id: sentMessages.length + 1 };
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
            text: "done",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "done",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "reply-target-fallback-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "finish with reply fallback",
    message: {
      message_id: 22,
      message_thread_id: 1931,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);

  assert.equal(finalReplyAttempts, 2);
  assert.equal(sentMessages[0].text, "...");
  assert.equal(sentMessages.at(-1).text, "done");
  assert.equal(sentMessages.at(-1).reply_to_message_id, undefined);
});

test("CodexWorkerPool keeps running when the initial progress bubble cannot be sent", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 194,
    topicName: "Initial progress failure test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });

  const sentMessages = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        if (payload.text === "...") {
          throw new Error("Telegram API sendMessage failed: Too Many Requests: retry after 0");
        }

        sentMessages.push(payload);
        return { message_id: 7 };
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
            text: "done",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "done",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "no-progress-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "finish even without bubble",
    message: {
      message_id: 24,
      message_thread_id: 194,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.last_progress_message_id, null);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "done");
});

test("CodexWorkerPool does not start when initial progress delivery parks the topic", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 195,
    topicName: "Initial progress parked topic test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });

  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage() {
        throw new Error("Telegram API sendMessage failed: Bad Request: message thread not found");
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
    sessionLifecycleManager: {
      async handleTransportError() {
        return {
          handled: true,
          parked: true,
        };
      },
    },
    runTask: () => {
      throw new Error("run should not start for parked topics");
    },
  });

  await assert.rejects(
    workerPool.startPromptRun({
      session,
      prompt: "do not start here",
      message: {
        message_id: 25,
        message_thread_id: 195,
      },
    }),
    /message thread not found/u,
  );

  assert.equal(workerPool.getActiveRun(session.session_key), null);
});

test("CodexWorkerPool keeps completed session state when final reply delivery fails", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  let session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 192,
    topicName: "Final reply failure state test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });
  session = await sessionStore.patch(session, {
    auto_mode: {
      enabled: true,
      phase: "running",
      omni_bot_id: "2234567890",
    },
  });

  const sentMessages = [];
  const deletedMessages = [];
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const workerPool = new CodexWorkerPool({
      api: {
        async sendMessage(payload) {
          if (payload.text === "...") {
            sentMessages.push(payload);
            return { message_id: 1 };
          }

          throw new Error("Telegram API sendMessage failed: Bad Gateway");
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
      spikeFinalEventStore,
      runTask: ({ onEvent }) => ({
        child: { kill() {} },
        finished: (async () => {
          await onEvent(
            {
              kind: "agent_message",
              text: "done",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "done",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "reply-failure-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      }),
    });

    await workerPool.startPromptRun({
      session,
      prompt: "finish even if delivery breaks",
      message: {
        message_id: 23,
        message_thread_id: 192,
      },
    });

    await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);

    const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
    const exchangeLog = await sessionStore.loadExchangeLog(reloaded);
    const spikeFinalEvent = await spikeFinalEventStore.load(reloaded);

    assert.equal(reloaded.last_run_status, "completed");
    assert.equal(reloaded.last_agent_reply, "done");
    assert.equal(exchangeLog.length, 1);
    assert.equal(exchangeLog[0].status, "completed");
    assert.equal(spikeFinalEvent.status, "completed");
    assert.equal(spikeFinalEvent.final_reply_text, "done");
    assert.equal(spikeFinalEvent.telegram_message_ids.length, 0);
    assert.equal(sentMessages.length, 1);
    assert.equal(deletedMessages.length, 1);
  } finally {
    console.error = originalConsoleError;
  }
});

test("CodexWorkerPool persists failure text into session state, exchange log, and Spike final events", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  let session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 193,
    topicName: "Failure persistence test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });
  session = await sessionStore.patch(session, {
    auto_mode: {
      enabled: true,
      phase: "running",
      omni_bot_id: "2234567890",
    },
  });

  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        if (payload.text === "...") {
          return { message_id: 1 };
        }

        return { message_id: 2 };
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
    spikeFinalEventStore,
    runTask: () => ({
      child: { kill() {} },
      finished: Promise.reject(new Error("runner exploded")),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "fail loudly",
    message: {
      message_id: 24,
      message_thread_id: 193,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  const exchangeLog = await sessionStore.loadExchangeLog(reloaded);
  const spikeFinalEvent = await spikeFinalEventStore.load(reloaded);

  assert.equal(reloaded.last_run_status, "failed");
  assert.match(reloaded.last_agent_reply, /runner exploded/u);
  assert.equal(exchangeLog.length, 1);
  assert.match(exchangeLog[0].assistant_reply, /runner exploded/u);
  assert.equal(spikeFinalEvent.status, "failed");
  assert.match(spikeFinalEvent.final_reply_text, /runner exploded/u);
});

test("CodexWorkerPool skips late Spike final events after auto mode is turned off", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  let session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 194,
    topicName: "Late final event off test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });
  session = await sessionStore.patch(session, {
    auto_mode: {
      enabled: true,
      phase: "running",
      omni_bot_id: "2234567890",
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
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    spikeFinalEventStore,
    runTask: () => ({
      child: { kill() {} },
      finished: Promise.resolve({
        exitCode: 0,
        signal: null,
        threadId: "late-final-thread",
        warnings: [],
        resumeReplacement: null,
      }),
    }),
  });

  await sessionStore.patch(session, {
    auto_mode: {
      enabled: false,
      phase: "off",
    },
  });

  const result = await workerPool.emitSpikeFinalEvent(
    {
      session,
      state: {
        status: "completed",
        finalAgentMessage: "finished after /auto off",
        replyToMessageId: 41,
        threadId: "late-final-thread",
      },
    },
    {
      finishedAt: "2026-04-01T19:05:00.000Z",
      deliveryResult: {
        messageIds: ["501"],
      },
    },
  );

  const spikeFinalEvent = await spikeFinalEventStore.load(session);
  assert.equal(result, null);
  assert.equal(spikeFinalEvent.status, null);
  assert.equal(spikeFinalEvent.exchange_log_entries, 0);
});

test("CodexWorkerPool passes image attachments to codex and file attachments via prompt context", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 189,
    topicName: "Attachment prompt test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });

  const runCalls = [];
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
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ prompt, imagePaths }) => {
      runCalls.push({ prompt, imagePaths });
      return {
        child: { kill() {} },
        finished: Promise.resolve({
          exitCode: 0,
          signal: null,
          threadId: "attachment-thread",
          warnings: [],
          resumeReplacement: null,
        }),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Посмотри вложения",
    message: {
      message_id: 18,
      message_thread_id: 189,
    },
    attachments: [
      {
        file_path: "/tmp/test-photo.jpg",
        is_image: true,
        mime_type: "image/jpeg",
        size_bytes: 1234,
      },
      {
        file_path: "/tmp/test-doc.txt",
        is_image: false,
        mime_type: "text/plain",
        size_bytes: 42,
      },
    ],
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(runCalls.length, 1);
  assert.deepEqual(runCalls[0].imagePaths, ["/tmp/test-photo.jpg"]);
  assert.match(runCalls[0].prompt, /Telegram topic routing context:/u);
  assert.match(runCalls[0].prompt, /topic_id: 189/u);
  assert.match(runCalls[0].prompt, /topic_context_file: .*telegram-topic-context\.md/u);
  assert.match(runCalls[0].prompt, /К сообщению приложены вложения из Telegram/u);
  assert.match(runCalls[0].prompt, /image: \/tmp\/test-photo\.jpg/u);
  assert.match(runCalls[0].prompt, /file: \/tmp\/test-doc\.txt/u);
  assert.match(runCalls[0].prompt, /Запрос пользователя:\nПосмотри вложения/u);
});

test("CodexWorkerPool runs different sessions in parallel and enforces busy and capacity limits", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const sessionA = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 201,
    topicName: "Parallel A",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });
  const sessionB = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 202,
    topicName: "Parallel B",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });
  const sessionC = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 203,
    topicName: "Parallel C",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });

  const sentMessages = [];
  const deferreds = new Map([
    [sessionA.session_key, createDeferred()],
    [sessionB.session_key, createDeferred()],
  ]);
  const promptToSessionKey = new Map([
    ["parallel-a", sessionA.session_key],
    ["parallel-b", sessionB.session_key],
  ]);
  const runCalls = [];
  const serviceState = {
    acceptedPrompts: 0,
    lastPromptAt: null,
    activeRunCount: 0,
  };

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
      maxParallelSessions: 2,
    },
    sessionStore,
    serviceState,
    runTask: ({ prompt, sessionThreadId, onEvent }) => {
      const sessionKey =
        [...promptToSessionKey.entries()].find(([needle]) => prompt.includes(needle))?.[1] ||
        null;
      runCalls.push({ sessionThreadId, prompt, sessionKey });
      const deferred = deferreds.get(sessionKey);

      return {
        child: {
          kill() {},
        },
        finished: (async () => {
          await deferred.promise;
          await onEvent(
            {
              kind: "thread",
              text: `Codex thread started: ${sessionKey}`,
              threadId: `${sessionKey}-thread`,
            },
            {
              type: "thread.started",
              thread_id: `${sessionKey}-thread`,
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              text: `done:${sessionKey}`,
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: `done:${sessionKey}`,
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: `${sessionKey}-thread`,
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  const startA = workerPool.startPromptRun({
    session: sessionA,
    prompt: "parallel-a",
    message: {
      message_thread_id: 201,
    },
  });
  const startB = workerPool.startPromptRun({
    session: sessionB,
    prompt: "parallel-b",
    message: {
      message_thread_id: 202,
    },
  });

  await waitFor(() => serviceState.activeRunCount === 2);

  const busyResult = await workerPool.startPromptRun({
    session: sessionA,
    prompt: "parallel-a-second",
    message: {
      message_thread_id: 201,
    },
  });
  const capacityResult = await workerPool.startPromptRun({
    session: sessionC,
    prompt: "parallel-c",
    message: {
      message_thread_id: 203,
    },
  });

  assert.deepEqual(await startA, {
    ok: true,
    progressMessageId: 1,
    threadId: null,
    sessionKey: sessionA.session_key,
    topicId: 201,
  });
  assert.deepEqual(await startB, {
    ok: true,
    progressMessageId: 2,
    threadId: null,
    sessionKey: sessionB.session_key,
    topicId: 202,
  });
  assert.deepEqual(busyResult, { ok: false, reason: "busy" });
  assert.deepEqual(capacityResult, { ok: false, reason: "capacity" });
  assert.equal(workerPool.getActiveRun(sessionA.session_key) !== null, true);
  assert.equal(workerPool.getActiveRun(sessionB.session_key) !== null, true);

  deferreds.get(sessionA.session_key).resolve();
  deferreds.get(sessionB.session_key).resolve();

  await waitFor(() => serviceState.activeRunCount === 0);

  const metaA = await sessionStore.load(sessionA.chat_id, sessionA.topic_id);
  const metaB = await sessionStore.load(sessionB.chat_id, sessionB.topic_id);
  assert.equal(metaA.last_run_status, "completed");
  assert.equal(metaB.last_run_status, "completed");
  assert.equal(metaA.last_agent_reply, `done:${sessionA.session_key}`);
  assert.equal(metaB.last_agent_reply, `done:${sessionB.session_key}`);
  assert.equal(runCalls.length, 2);
  assert.equal(
    sentMessages.some((payload) => payload.text === `done:${sessionA.session_key}`),
    true,
  );
  assert.equal(
    sentMessages.some((payload) => payload.text === `done:${sessionB.session_key}`),
    true,
  );
});


