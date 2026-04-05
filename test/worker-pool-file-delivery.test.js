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

test("CodexWorkerPool normalizes markdown-heavy agent replies before Telegram delivery", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 188,
    topicName: "Telegram format test",
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
            text: "Файл [`test.js`](/workspace/test.js) удален. Проверил `SIGTERM`.",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Файл [`test.js`](/workspace/test.js) удален. Проверил `SIGTERM`.",
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
    "Файл <code>test.js</code> удален. Проверил <code>SIGTERM</code>.",
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
    chatId: -1001234567890,
    topicId: 1881,
    topicName: "Directive delivery",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
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
  assert.match(
    runCalls[0],
    /Read topic_context_file only if you need routing or file-send details/u,
  );
  assert.match(runCalls[0], /Скинь файл в этот топик/u);
  assert.doesNotMatch(runCalls[0], /```telegram-file/u);
  assert.doesNotMatch(runCalls[0], /File delivery:/u);
  assert.equal(sentDocuments.length, 1);
  assert.equal(sentDocuments[0].chat_id, -1001234567890);
  assert.equal(sentDocuments[0].message_thread_id, 1881);
  assert.equal(sentDocuments[0].caption, "Server report");
  assert.equal(sentDocuments[0].document.filePath, await fs.realpath(filePath));
  assert.equal(sentDocuments[0].document.fileName, "report.txt");
  assert.equal(sentMessages.at(-1).text, "Отправил файл: report.txt.");

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_agent_reply, "Отправил файл: report.txt.");
});

test("CodexWorkerPool sends telegram-file directives from a symlinked worktree path", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const workspaceParent = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-worktree-"),
  );
  const realWorkspaceRoot = path.join(workspaceParent, "real-worktree");
  const linkedWorkspaceRoot = path.join(workspaceParent, "linked-worktree");
  await fs.mkdir(realWorkspaceRoot, { recursive: true });
  await fs.symlink(
    realWorkspaceRoot,
    linkedWorkspaceRoot,
    process.platform === "win32" ? "junction" : "dir",
  );
  const filePath = path.join(linkedWorkspaceRoot, "report.txt");
  await fs.writeFile(filePath, "report\n", "utf8");

  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 1881,
    topicName: "Directive delivery",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: linkedWorkspaceRoot,
      cwd: linkedWorkspaceRoot,
      branch: "main",
      worktree_path: linkedWorkspaceRoot,
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
          threadId: "directive-symlink-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
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

  assert.equal(sentDocuments.length, 1);
  assert.equal(sentDocuments[0].document.fileName, "report.txt");
  assert.equal(sentMessages.at(-1).text, "Отправил файл: report.txt.");
});

test("CodexWorkerPool keeps telegram-file syntax visible when it is only an example", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 1882,
    topicName: "Directive example",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
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
  assert.match(sentMessages.at(-1).text, /<pre><code class="language-telegram-file">/u);
  assert.match(sentMessages.at(-1).text, /path: \/tmp\/example\.txt/u);
});

test("CodexWorkerPool rejects telegram-file paths outside allowed delivery roots", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 1883,
    topicName: "Directive failure",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });

  const outsideFilePath = process.execPath;
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
          `path: ${outsideFilePath}`,
          `filename: ${path.basename(outsideFilePath)}`,
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

