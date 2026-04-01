import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexWorkerPool } from "../src/pty-worker/worker-pool.js";
import { SessionStore } from "../src/session-manager/session-store.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }

    await sleep(20);
  }

  throw new Error("Timed out waiting for worker-pool state");
}

test("CodexWorkerPool falls back to compact rebuild only after one resume retry", async () => {
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

    return {
      child,
      finished: (async () => {
        await onEvent(
          {
            kind: "thread",
            text: "Codex thread started: fresh-thread",
            threadId: "fresh-thread",
          },
          {
            type: "thread.started",
            thread_id: "fresh-thread",
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            text: "Recovered sentinel: SENTINEL_FOX",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Recovered sentinel: SENTINEL_FOX",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "fresh-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    };
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

  assert.equal(runCalls.length, 3);
  assert.equal(runCalls[0].sessionThreadId, "stale-thread");
  assert.equal(runCalls[1].sessionThreadId, "stale-thread");
  assert.equal(runCalls[2].sessionThreadId, null);
  assert.match(runCalls[1].prompt, /Telegram topic routing context:/u);
  assert.match(runCalls[1].prompt, /topic_id: 144/u);
  assert.match(runCalls[1].prompt, /What sentinel did we agree on\?/u);
  assert.match(
    runCalls[2].prompt,
    /The previous Codex thread for this Telegram topic could not be resumed\./u,
  );
  assert.match(runCalls[2].prompt, /session_key: -1003577434463:144/u);
  assert.match(runCalls[2].prompt, /previous_thread_id: stale-thread/u);
  assert.match(runCalls[2].prompt, /last_run_status: \w+/u);
  assert.match(runCalls[2].prompt, /## Active brief/u);
  assert.match(runCalls[2].prompt, /Sentinel: SENTINEL_FOX/u);
  assert.match(runCalls[2].prompt, /## Latest user request/u);
  assert.match(runCalls[2].prompt, /What sentinel did we agree on\?/u);
  assert.doesNotMatch(runCalls[2].prompt, /Pinned facts/u);

  const meta = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.equal(meta.codex_thread_id, "fresh-thread");
  assert.equal(meta.last_run_status, "completed");
  assert.equal(meta.last_agent_reply, "Recovered sentinel: SENTINEL_FOX");

  const exchangeLog = await sessionStore.loadExchangeLog(resumedSession);
  assert.equal(exchangeLog.length, 2);
  assert.equal(exchangeLog.at(-1).status, "completed");
  assert.equal(exchangeLog.at(-1).user_prompt, "What sentinel did we agree on?");
  assert.match(exchangeLog.at(-1).assistant_reply, /Recovered sentinel/u);

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].text, "...");
  assert.equal(sentMessages.at(-1).text, "Recovered sentinel: SENTINEL_FOX");
  assert.equal(sentMessages.at(-1).reply_to_message_id, 99);
  assert.equal(deletedMessages.length, 1);
});

test("CodexWorkerPool retries thread resume once before succeeding without compact rebuild", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 145,
    topicName: "Resume retry success test",
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
    last_user_prompt: "Remember sentinel SENTINEL_WOLF",
    last_agent_reply: "SENTINEL_WOLF",
    last_run_status: "completed",
  });
  await sessionStore.appendExchangeLogEntry(resumedSession, {
    created_at: "2026-03-22T12:00:00.000Z",
    status: "completed",
    user_prompt: "Remember sentinel SENTINEL_WOLF",
    assistant_reply: "SENTINEL_WOLF",
  });

  await sessionStore.writeSessionText(
    resumedSession,
    "active-brief.md",
    "# Active brief\n\nSentinel: SENTINEL_WOLF\n",
  );

  const sentMessages = [];
  const runCalls = [];
  const runTask = ({ prompt, sessionThreadId, onEvent }) => {
    runCalls.push({ prompt, sessionThreadId });
    const child = {
      kill() {},
    };

    if (runCalls.length === 1) {
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

    return {
      child,
      finished: (async () => {
        await onEvent(
          {
            kind: "thread",
            text: "Codex thread started: stale-thread",
            threadId: "stale-thread",
          },
          {
            type: "thread.started",
            thread_id: "stale-thread",
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            text: "Recovered sentinel after retry: SENTINEL_WOLF",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Recovered sentinel after retry: SENTINEL_WOLF",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "stale-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    };
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
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask,
  });

  await workerPool.startPromptRun({
    session: resumedSession,
    prompt: "What sentinel did we agree on after retry?",
    message: {
      message_id: 100,
      message_thread_id: 145,
    },
  });

  await waitFor(() => workerPool.getActiveRun(resumedSession.session_key) === null);

  assert.equal(runCalls.length, 2);
  assert.equal(runCalls[0].sessionThreadId, "stale-thread");
  assert.equal(runCalls[1].sessionThreadId, "stale-thread");
  assert.match(runCalls[1].prompt, /Telegram topic routing context:/u);
  assert.match(runCalls[1].prompt, /topic_id: 145/u);
  assert.match(
    runCalls[1].prompt,
    /What sentinel did we agree on after retry\?/u,
  );
  assert.doesNotMatch(runCalls[1].prompt, /Pinned facts/u);

  const meta = await sessionStore.load(resumedSession.chat_id, resumedSession.topic_id);
  assert.equal(meta.codex_thread_id, "stale-thread");
  assert.equal(meta.last_run_status, "completed");
  assert.equal(
    meta.last_agent_reply,
    "Recovered sentinel after retry: SENTINEL_WOLF",
  );

  const exchangeLog = await sessionStore.loadExchangeLog(resumedSession);
  assert.equal(exchangeLog.length, 2);
  assert.equal(
    exchangeLog.at(-1).assistant_reply,
    "Recovered sentinel after retry: SENTINEL_WOLF",
  );

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].text, "...");
  assert.equal(
    sentMessages.at(-1).text,
    "Recovered sentinel after retry: SENTINEL_WOLF",
  );
});

test("CodexWorkerPool normalizes markdown-heavy agent replies before Telegram delivery", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 188,
    topicName: "Telegram format test",
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
            kind: "turn",
            text: "Codex turn completed",
            usage: {
              input_tokens: 227200,
              cached_input_tokens: 180000,
              output_tokens: 1200,
              reasoning_tokens: 800,
            },
          },
          {
            type: "turn.completed",
            usage: {
              input_tokens: 227200,
              cached_input_tokens: 180000,
              output_tokens: 1200,
              reasoning_tokens: 800,
            },
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            text: "Файл [`test.js`](/home/bloob/atlas/test.js) удален. Проверил `SIGTERM`.",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Файл [`test.js`](/home/bloob/atlas/test.js) удален. Проверил `SIGTERM`.",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "format-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "delete test file",
    message: {
      message_id: 17,
      message_thread_id: 188,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(
    reloaded.last_agent_reply,
    "Файл test.js удален. Проверил SIGTERM.",
  );
  assert.deepEqual(reloaded.last_token_usage, {
    input_tokens: 227200,
    cached_input_tokens: 180000,
    output_tokens: 1200,
    reasoning_tokens: 800,
    total_tokens: 228400,
  });
  assert.equal(
    sentMessages.at(-1).text,
    "Файл test.js удален. Проверил SIGTERM.",
  );
});

test("CodexWorkerPool sends telegram-file directives into the current topic", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-artifacts-"),
  );
  const filePath = path.join(tempRoot, "report.txt");
  await fs.writeFile(filePath, "report\n", "utf8");

  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 1881,
    topicName: "Directive delivery",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

  const sentMessages = [];
  const sentDocuments = [];
  const runCalls = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async sendDocument(payload) {
        sentDocuments.push(payload);
        return { message_id: 900 + sentDocuments.length };
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
    runTask: ({ prompt, onEvent }) => {
      runCalls.push(prompt);
      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent(
            {
              kind: "agent_message",
              text: [
                "```telegram-file",
                "action: send",
                `path: ${filePath}`,
                "filename: report.txt",
                "caption: Server report",
                "```",
              ].join("\n"),
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: [
                  "```telegram-file",
                  "action: send",
                  `path: ${filePath}`,
                  "filename: report.txt",
                  "caption: Server report",
                  "```",
                ].join("\n"),
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "directive-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Скинь файл в этот топик",
    message: {
      message_id: 71,
      message_thread_id: 1881,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(runCalls.length, 1);
  assert.match(runCalls[0], /Telegram topic routing context:/u);
  assert.match(runCalls[0], /topic_id: 1881/u);
  assert.match(runCalls[0], /topic_context_file: .*telegram-topic-context\.md/u);
  assert.match(runCalls[0], /read topic_context_file/u);
  assert.match(runCalls[0], /Скинь файл в этот топик/u);
  assert.doesNotMatch(runCalls[0], /```telegram-file/u);
  assert.doesNotMatch(runCalls[0], /File delivery:/u);
  assert.equal(sentDocuments.length, 1);
  assert.equal(sentDocuments[0].chat_id, -1003577434463);
  assert.equal(sentDocuments[0].message_thread_id, 1881);
  assert.equal(sentDocuments[0].caption, "Server report");
  assert.equal(sentDocuments[0].document.filePath, filePath);
  assert.equal(sentDocuments[0].document.fileName, "report.txt");
  assert.equal(sentMessages.at(-1).text, "Отправил файл: report.txt.");

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_agent_reply, "Отправил файл: report.txt.");
});

test("CodexWorkerPool keeps telegram-file syntax visible when it is only an example", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 1882,
    topicName: "Directive example",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

  const sentMessages = [];
  const sentDocuments = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async sendDocument(payload) {
        sentDocuments.push(payload);
        return { message_id: 900 + sentDocuments.length };
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
        const text = [
          "Вот синтаксис:",
          "",
          "```telegram-file",
          "path: /tmp/example.txt",
          "filename: example.txt",
          "```",
        ].join("\n");
        await onEvent(
          {
            kind: "agent_message",
            text,
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text,
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "directive-example-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Покажи синтаксис блока",
    message: {
      message_id: 72,
      message_thread_id: 1882,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(sentDocuments.length, 0);
  assert.match(sentMessages.at(-1).text, /```telegram-file/u);
  assert.match(sentMessages.at(-1).text, /path: \/tmp\/example\.txt/u);
});

test("CodexWorkerPool rejects telegram-file paths outside allowed delivery roots", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 1883,
    topicName: "Directive failure",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

  const sentMessages = [];
  const sentDocuments = [];
  const workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async sendDocument(payload) {
        sentDocuments.push(payload);
        return { message_id: 900 + sentDocuments.length };
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
        const text = [
          "```telegram-file",
          "action: send",
          "path: /etc/hosts",
          "filename: hosts.txt",
          "```",
        ].join("\n");
        await onEvent(
          {
            kind: "agent_message",
            text,
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text,
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "directive-failure-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Скинь hosts",
    message: {
      message_id: 73,
      message_thread_id: 1883,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(sentDocuments.length, 0);
  assert.match(
    sentMessages.at(-1).text,
    /вне разрешённых зон доставки/u,
  );
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

test("CodexWorkerPool does not surface completed command output in progress without commentary", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 18901,
    topicName: "Command-only progress test",
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
    chatId: -1003577434463,
    topicId: 1891,
    topicName: "Agent message phase test",
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
    chatId: -1003577434463,
    topicId: 190,
    topicName: "Progress shell cleanup test",
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
  const deferred = createDeferred();
  const noisyTelegramCommand =
    `/bin/bash -lc "sleep 29 && node --input-type=module -e 'const payload = { chat_id: -1003577434463, message_thread_id: 1560, text: \\"Тест\\" }; const res = await fetch(\\"https://api.telegram.org/botTOKEN/sendMessage\\", { method: \\"POST\\" });'"`;
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
    chatId: -1003577434463,
    topicId: 191,
    topicName: "Final reply retry test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
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

test("CodexWorkerPool keeps running when the initial progress bubble cannot be sent", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 194,
    topicName: "Initial progress failure test",
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
    chatId: -1003577434463,
    topicId: 195,
    topicName: "Initial progress parked topic test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
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
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 192,
    topicName: "Final reply failure state test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
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

    assert.equal(reloaded.last_run_status, "completed");
    assert.equal(reloaded.last_agent_reply, "done");
    assert.equal(exchangeLog.length, 1);
    assert.equal(exchangeLog[0].status, "completed");
    assert.equal(sentMessages.length, 1);
    assert.equal(deletedMessages.length, 1);
  } finally {
    console.error = originalConsoleError;
  }
});

test("CodexWorkerPool passes image attachments to codex and file attachments via prompt context", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 189,
    topicName: "Attachment prompt test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
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
    chatId: -1003577434463,
    topicId: 201,
    topicName: "Parallel A",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });
  const sessionB = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 202,
    topicName: "Parallel B",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });
  const sessionC = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 203,
    topicName: "Parallel C",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
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
  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

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

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

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
            }, 20).unref();
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
});
