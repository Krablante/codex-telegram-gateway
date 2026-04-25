import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexWorkerPool } from "../src/pty-worker/worker-pool.js";
import { SessionStore } from "../src/session-manager/session-store.js";
import { SpikeFinalEventStore } from "../src/session-manager/spike-final-event-store.js";
import { TelegramProgressMessage } from "../src/transport/progress-message.js";
import { withSuppressedConsole } from "../test-support/console-fixtures.js";
import {
  createDeferred,
  sleep,
  waitFor,
} from "../test-support/worker-pool-fixtures.js";

const INITIAL_PROGRESS_TEXT = "...";

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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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

  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
  assert.equal(sentMessages.at(-1)?.text, "FINAL_ONLY");
});

test("CodexWorkerPool keeps long silent runs on a bare spinner instead of synthetic thoughts", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 18902,
    topicName: "Silent liveness progress test",
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
      async sendChatAction() {
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
      finished: (async () => {
        await finishGate.promise;
        return {
          exitCode: 0,
          signal: null,
          threadId: "silent-progress-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "show liveness",
    message: {
      message_id: 1902,
      message_thread_id: 18902,
    },
  });

  const run = workerPool.getActiveRun(session.session_key);
  assert.ok(run);
  run.state.startedAtMs -= 20_000;

  await sleep(1100);
  await workerPool.sendTypingAction(run);
  await sleep(50);

  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
  assert.equal(editedMessages.length, 0);

  finishGate.resolve();
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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

  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const sentMessages = [];
  let finalReplyAttempts = 0;
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        if (payload.text === INITIAL_PROGRESS_TEXT) {
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
  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
  assert.equal(sentMessages.at(-1).text, "done");
});

test("CodexWorkerPool retries the final reply after a transient transport hiccup", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 1911,
    topicName: "Final reply transient retry test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const sentMessages = [];
  let finalReplyAttempts = 0;
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        if (payload.text === INITIAL_PROGRESS_TEXT) {
          sentMessages.push(payload);
          return { message_id: 1 };
        }

        finalReplyAttempts += 1;
        if (finalReplyAttempts === 1) {
          const error = new Error("Telegram API sendMessage failed");
          error.cause = { code: "ECONNRESET" };
          throw error;
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
          threadId: "reply-transient-retry-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "retry on transient delivery hiccup",
    message: {
      message_id: 221,
      message_thread_id: 1911,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);

  assert.equal(finalReplyAttempts, 2);
  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
  assert.equal(sentMessages.at(-1).text, "done");
});

test("CodexWorkerPool keeps the final answer in the progress bubble when transient final delivery never recovers", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  let session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 1912,
    topicName: "Final reply progress fallback test",
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
  const deletedMessages = [];
  let finalReplyAttempts = 0;
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        if (payload.text === INITIAL_PROGRESS_TEXT) {
          sentMessages.push(payload);
          return { message_id: 1 };
        }

        finalReplyAttempts += 1;
        const error = new Error("fetch failed");
        error.cause = { code: "UND_ERR_SOCKET" };
        throw error;
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
          threadId: "reply-progress-fallback-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "keep final answer visible through progress fallback",
    message: {
      message_id: 222,
      message_thread_id: 1912,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  const spikeFinalEvent = await spikeFinalEventStore.load(reloaded);

  assert.equal(finalReplyAttempts, 3);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(sentMessages.length, 1);
  assert.equal(deletedMessages.length, 0);
  assert.equal(editedMessages.at(-1)?.text, "done");
  assert.deepEqual(spikeFinalEvent.telegram_message_ids, ["1"]);
});

test("CodexWorkerPool keeps a long final answer visible in the progress bubble when chunked delivery fails transiently", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  let session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 1913,
    topicName: "Chunked progress fallback",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });
  let finalReplyAttempts = 0;
  const longReply = "x".repeat(5000);
  const sentMessages = [];
  const editedMessages = [];
  const deletedMessages = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        if (payload.text === INITIAL_PROGRESS_TEXT) {
          sentMessages.push(payload);
          return { message_id: 1 };
        }

        finalReplyAttempts += 1;
        const error = new Error("fetch failed");
        error.cause = { code: "UND_ERR_SOCKET" };
        throw error;
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
            text: longReply,
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: longReply,
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "reply-progress-fallback-long-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "keep the long final answer visible through progress fallback",
    message: {
      message_id: 223,
      message_thread_id: 1913,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  const spikeFinalEvent = await spikeFinalEventStore.load(reloaded);

  assert.equal(finalReplyAttempts, 3);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(sentMessages.length, 1);
  assert.equal(deletedMessages.length, 0);
  assert.match(editedMessages.at(-1)?.text || "", /\[truncated\]$/u);
  assert.deepEqual(spikeFinalEvent.telegram_message_ids, ["1"]);
});

test("CodexWorkerPool keeps the progress-bubble final visible if later Spike final persistence fails", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 19121,
    topicName: "Final reply progress persistence failure test",
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
  const deletedMessages = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        if (payload.text === INITIAL_PROGRESS_TEXT) {
          sentMessages.push(payload);
          return { message_id: 1 };
        }

        const error = new Error("fetch failed");
        error.cause = { code: "UND_ERR_SOCKET" };
        throw error;
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
          threadId: "reply-progress-persist-failure-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });
  workerPool.emitSpikeFinalEvent = async () => {
    throw new Error("spike final persistence failed");
  };

  await withSuppressedConsole("error", async () => {
    await workerPool.startPromptRun({
      session,
      prompt: "keep final answer visible even if spike final persistence fails",
      message: {
        message_id: 2221,
        message_thread_id: 19121,
      },
    });
    await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(deletedMessages.length, 0);
  assert.equal(editedMessages.at(-1)?.text, "done");
});

test("CodexWorkerPool preserves already-delivered final chunks in Spike metadata when a later chunk fails", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  let session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 1913,
    topicName: "Final reply partial delivery metadata test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });
  const sentMessages = [];
  let finalReplyAttempts = 0;
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const workerPool = new CodexWorkerPool({
      api: {
        async sendMessage(payload) {
          if (payload.text === INITIAL_PROGRESS_TEXT) {
            sentMessages.push(payload);
            return { message_id: 1 };
          }

          finalReplyAttempts += 1;
          if (finalReplyAttempts === 1) {
            sentMessages.push(payload);
            return { message_id: 2 };
          }

          throw new Error("Telegram API sendMessage failed: Bad Gateway");
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
      runTask: ({ onEvent }) => ({
        child: { kill() {} },
        finished: (async () => {
          await onEvent(
            {
              kind: "agent_message",
              text: `start ${"x".repeat(5000)}`,
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: `start ${"x".repeat(5000)}`,
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "reply-partial-metadata-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      }),
    });

    await workerPool.startPromptRun({
      session,
      prompt: "preserve partial final delivery metadata",
      message: {
        message_id: 223,
        message_thread_id: 1913,
      },
    });

    await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);

    const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
    const spikeFinalEvent = await spikeFinalEventStore.load(reloaded);

    assert.equal(finalReplyAttempts, 2);
    assert.equal(sentMessages.length, 2);
    assert.deepEqual(spikeFinalEvent.telegram_message_ids, ["2"]);
  } finally {
    console.error = originalConsoleError;
  }
});

test("CodexWorkerPool parks the session when final reply delivery discovers an unavailable topic", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 1914,
    topicName: "Final reply parked topic test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        if (payload.text === INITIAL_PROGRESS_TEXT) {
          return { message_id: 1 };
        }

        throw new Error("Telegram API sendMessage failed: Bad Request: message thread not found");
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
    sessionLifecycleManager: {
      async handleTransportError(currentSession, error) {
        if (!/message thread not found/u.test(error.message)) {
          return { handled: false };
        }

        const parked = await sessionStore.park(
          currentSession,
          "telegram/topic-unavailable",
        );
        return {
          handled: true,
          parked: true,
          session: parked,
        };
      },
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
          threadId: "reply-parked-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "park session on final delivery topic loss",
    message: {
      message_id: 224,
      message_thread_id: 1914,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.lifecycle_state, "parked");
  assert.equal(reloaded.last_run_status, "completed");
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const sentMessages = [];
  let finalReplyAttempts = 0;
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        if (payload.text === INITIAL_PROGRESS_TEXT) {
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
  assert.equal(sentMessages[0].text, INITIAL_PROGRESS_TEXT);
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const sentMessages = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        if (payload.text === INITIAL_PROGRESS_TEXT) {
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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

test("CodexWorkerPool dismisses a partially delivered progress bubble when startup fails before the run exists", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-progress-leak-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 196,
    topicName: "Initial progress partial failure test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });

  const deletedMessages = [];
  const originalSendInitial = TelegramProgressMessage.prototype.sendInitial;
  TelegramProgressMessage.prototype.sendInitial = async function sendInitialAndFail() {
    this.messageId = 77;
    throw new Error("Telegram API sendMessage failed: chat write forbidden");
  };

  try {
    const workerPool = new CodexWorkerPool({
      api: {
        async sendMessage() {
          throw new Error("sendMessage should not be called directly");
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
    });

    await assert.rejects(
      workerPool.startPromptRun({
        session,
        prompt: "fail before run exists",
        message: {
          message_id: 26,
          message_thread_id: 196,
        },
      }),
      /chat write forbidden/u,
    );
  } finally {
    TelegramProgressMessage.prototype.sendInitial = originalSendInitial;
  }

  assert.equal(deletedMessages.length, 1);
  assert.equal(deletedMessages[0].message_id, 77);
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
          if (payload.text === INITIAL_PROGRESS_TEXT) {
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

test("CodexWorkerPool treats a zero-exit run without a final answer as failure instead of synthetic success", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 194,
    topicName: "Missing final answer",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
    spikeFinalEventStore,
    runTask: () => ({
      child: { kill() {} },
      finished: Promise.resolve({
        exitCode: 0,
        signal: null,
        threadId: "missing-final-answer-thread",
        warnings: [],
        resumeReplacement: null,
      }),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "simulate a zero-exit run without a final answer",
    message: {
      message_id: 24,
      message_thread_id: 194,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "failed");
  assert.match(reloaded.last_agent_reply, /Не смог закончить run/u);
  assert.equal(sentMessages.at(-1)?.text, reloaded.last_agent_reply);
  assert.doesNotMatch(reloaded.last_agent_reply, /^Готово\.$/u);
});

test("CodexWorkerPool does not complete exec-json failures from a premature final candidate", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 195,
    topicName: "Exec premature final",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
      codexGatewayBackend: "exec-json",
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
        await onEvent({
          kind: "agent_message",
          eventType: "item.completed",
          text: "premature final candidate",
          messagePhase: "final_answer",
        });
        return {
          backend: "exec-json",
          ok: false,
          exitCode: 1,
          signal: null,
          threadId: "exec-premature-final-thread",
          warnings: ["Codex exec stream ended before turn.completed"],
          resumeReplacement: null,
          preserveContinuity: true,
          abortReason: "exec_stream_incomplete",
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "simulate exec-json failure after an agent message",
    message: {
      message_id: 24,
      message_thread_id: 195,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  const exchangeLog = await sessionStore.loadExchangeLog(reloaded);
  assert.equal(reloaded.last_run_status, "failed");
  assert.match(reloaded.last_agent_reply, /Не смог закончить run/u);
  assert.doesNotMatch(reloaded.last_agent_reply, /premature final candidate/u);
  assert.equal(reloaded.codex_thread_id, "exec-premature-final-thread");
  assert.equal(exchangeLog.at(-1)?.status, "failed");
  assert.equal(sentMessages.at(-1)?.text, reloaded.last_agent_reply);
});

test("CodexWorkerPool retries transient model-capacity failures before surfacing a run failure", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 196,
    topicName: "Model capacity retry test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });
  const sentMessages = [];
  let runTaskCalls = 0;
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
      upstreamModelCapacityRetryDelaysMs: [0],
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ onEvent }) => {
      runTaskCalls += 1;
      if (runTaskCalls === 1) {
        return {
          child: { kill() {} },
          finished: Promise.reject(
            new Error("Selected model is at capacity. Please try a different model."),
          ),
        };
      }

      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent({
            kind: "thread",
            eventType: "thread.started",
            text: "Codex thread started: capacity-retry-thread",
            threadId: "capacity-retry-thread",
          });
          await onEvent({
            kind: "agent_message",
            text: "Recovered after model capacity retry.",
            messagePhase: "final_answer",
          });
          return {
            exitCode: 0,
            signal: null,
            threadId: "capacity-retry-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "retry after model capacity",
    message: {
      message_id: 24,
      message_thread_id: 196,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null, 4000);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(runTaskCalls, 2);
  assert.equal(reloaded.last_run_status, "completed");
  assert.match(reloaded.last_agent_reply, /Recovered after model capacity retry/u);
  assert.doesNotMatch(sentMessages.at(-1)?.text || "", /Selected model is at capacity/u);
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        if (payload.text === INITIAL_PROGRESS_TEXT) {
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

test("CodexWorkerPool persists late Spike final events without legacy auto gating", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 194,
    topicName: "Late final event test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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

  const result = await workerPool.emitSpikeFinalEvent(
    {
      session,
      state: {
        status: "completed",
        finalAgentMessage: "finished after the late final",
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
  assert.equal(result.status, "completed");
  assert.equal(spikeFinalEvent.status, "completed");
  assert.equal(spikeFinalEvent.final_reply_text, "finished after the late final");
  assert.deepEqual(spikeFinalEvent.telegram_message_ids, ["501"]);
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });
  session.prompt_suffix_enabled = true;
  session.prompt_suffix_text = "TOPIC\nAnswer briefly in this topic.";

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
    globalPromptSuffixStore: {
      async load() {
        return {
          prompt_suffix_enabled: true,
          prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
        };
      },
    },
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ prompt, imagePaths, baseInstructions }) => {
      runCalls.push({ prompt, imagePaths, baseInstructions });
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
  assert.doesNotMatch(runCalls[0].prompt, /Context:/u);
  assert.doesNotMatch(runCalls[0].prompt, /Work Style:/u);
  assert.match(runCalls[0].baseInstructions, /Context:/u);
  assert.match(
    runCalls[0].baseInstructions,
    /\n\nWork Style:\nTOPIC\nAnswer briefly in this topic\./u,
  );
  assert.match(runCalls[0].baseInstructions, /Telegram topic 189 \(-1001234567890:189\)/u);
  assert.match(runCalls[0].baseInstructions, /topic context file: .*telegram-topic-context\.md/u);
  assert.match(runCalls[0].prompt, /К сообщению приложены вложения из Telegram/u);
  assert.match(runCalls[0].prompt, /image: \/tmp\/test-photo\.jpg/u);
  assert.match(runCalls[0].prompt, /file: \/tmp\/test-doc\.txt/u);
  assert.match(runCalls[0].prompt, /\n\nПосмотри вложения$/u);
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });
  const sessionB = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 202,
    topicName: "Parallel B",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });
  const sessionC = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 203,
    topicName: "Parallel C",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
