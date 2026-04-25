import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexWorkerPool } from "../src/pty-worker/worker-pool.js";
import { SessionStore } from "../src/session-manager/session-store.js";
import {
  waitFor,
} from "../test-support/worker-pool-fixtures.js";
import { mkdtempForTest } from "../test-support/tmp.js";

function resolveRsyncLocalPathForTest(filePath) {
  if (process.platform !== "win32") {
    return filePath;
  }

  const drivePath = String(filePath || "").match(/^\/([a-z])(?:\/(.*))?$/iu);
  if (!drivePath) {
    return String(filePath || "").replace(/\//gu, "\\");
  }

  const [, drive, rest = ""] = drivePath;
  return `${drive.toUpperCase()}:\\${rest.replace(/\//gu, "\\")}`;
}

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
            text: "Файл [`test.js`](/srv/codex-workspace/test.js) удален. Проверил `SIGTERM`.",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Файл [`test.js`](/srv/codex-workspace/test.js) удален. Проверил `SIGTERM`.",
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
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 1881,
    topicName: "Directive delivery",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  });
  const filePath = path.join(
    sessionStore.getSessionDir(session.chat_id, session.topic_id),
    "report.txt",
  );
  await fs.writeFile(filePath, "report\n", "utf8");

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
    runTask: ({ prompt, baseInstructions, onEvent }) => {
      runCalls.push({ prompt, baseInstructions });
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
  assert.equal(runCalls[0].prompt, "Скинь файл в этот топик");
  assert.match(runCalls[0].baseInstructions, /Context:/u);
  assert.match(runCalls[0].baseInstructions, /Telegram topic 1881 \(-1001234567890:1881\)/u);
  assert.match(runCalls[0].baseInstructions, /topic context file: .*telegram-topic-context\.md/u);
  assert.match(
    runCalls[0].baseInstructions,
    /read the topic context file only when you need extra routing, delivery, or continuity details/u,
  );
  assert.doesNotMatch(runCalls[0].prompt, /```telegram-file/u);
  assert.doesNotMatch(runCalls[0].prompt, /File delivery:/u);
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

test("CodexWorkerPool builds remote host-aware topic context for bound topics", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 18815,
    topicName: "Directive remote context",
    createdVia: "command/new",
    executionHostId: "worker-b",
    executionHostLabel: "worker-b",
    workspaceBinding: {
      workspace_root: "/srv/codex-workspace",
      repo_root: "/srv/codex-workspace/codex-telegram-gateway",
      cwd: "/srv/codex-workspace/work/public/demo",
      branch: "main",
      worktree_path: "/srv/codex-workspace/work/public/demo",
    },
  });

  const runCalls = [];
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
      currentHostId: "controller",
      maxParallelSessions: 1,
    },
    hostRegistryService: {
      async resolveSessionExecution() {
        return {
          ok: true,
          hostId: "worker-b",
          hostLabel: "worker-b",
          host: {
            host_id: "worker-b",
            workspace_root: "/home/worker-b/workspace",
            worker_runtime_root:
              "/home/worker-b/workspace/state/codex-telegram-gateway",
          },
        };
      },
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    runTask: ({ prompt, baseInstructions, onEvent }) => {
      runCalls.push({ prompt, baseInstructions });
      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent(
            { kind: "agent_message", text: "Готово." },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "Готово.",
              },
            },
          );

          return {
            exitCode: 0,
            signal: null,
            threadId: "remote-context-thread",
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
      message_id: 711,
      message_thread_id: 18815,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].prompt, "Скинь файл в этот топик");
  assert.match(runCalls[0].baseInstructions, /workspace cwd: \/home\/worker-b\/workspace\/work\/public\/demo/u);
  assert.match(runCalls[0].baseInstructions, /bound host: worker-b/u);
  assert.match(
    runCalls[0].baseInstructions,
    /allowed telegram-file send roots: \/home\/worker-b\/workspace\/work\/public\/demo/u,
  );
  assert.doesNotMatch(
    runCalls[0].baseInstructions,
    /\/home\/worker-b\/workspace\/state\/codex-telegram-gateway/u,
  );
  assert.doesNotMatch(runCalls[0].baseInstructions, /allowed telegram-file send roots: .*\/tmp/u);
  assert.match(
    runCalls[0].baseInstructions,
    /topic context file stays on the Telegram control-plane host for this remote run/u,
  );
  assert.doesNotMatch(runCalls[0].baseInstructions, /topic context file: .*telegram-topic-context\.md/u);
});

test("CodexWorkerPool delivers remote telegram-file directives through private staging", {
  skip: process.platform === "win32"
    ? "remote rsync staging fixture is POSIX-only"
    : false,
}, async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const localRemoteWorkspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-remote-workspace-"),
  );
  const remoteWorkspaceRoot = "/home/worker-a/workspace";
  const remoteWorktree = path.posix.join(remoteWorkspaceRoot, "work", "public", "demo");
  const remoteFilePath = path.posix.join(remoteWorktree, "remote report.txt");
  const localRemoteWorktree = path.join(
    localRemoteWorkspaceRoot,
    "work",
    "public",
    "demo",
  );
  const localRemoteFilePath = path.join(localRemoteWorktree, "remote report.txt");
  await fs.mkdir(localRemoteWorktree, { recursive: true });
  await fs.writeFile(localRemoteFilePath, "remote report\n", "utf8");

  try {
    const sessionStore = new SessionStore(sessionsRoot);
    const session = await sessionStore.ensure({
      chatId: -1001234567890,
      topicId: 18816,
      topicName: "Directive remote file",
      createdVia: "command/new",
      executionHostId: "worker-a",
      executionHostLabel: "worker-a",
      workspaceBinding: {
        workspace_root: "/workspace",
        repo_root: "/workspace/codex-telegram-gateway",
        cwd: "/workspace/work/public/demo",
        branch: "main",
        worktree_path: "/workspace/work/public/demo",
      },
    });

    const sentMessages = [];
    const sentDocuments = [];
    let deliveredContent = null;
    const workerPool = new CodexWorkerPool({
      api: {
        async sendMessage(payload) {
          sentMessages.push(payload);
          return { message_id: sentMessages.length };
        },
        async sendDocument(payload) {
          deliveredContent = await fs.readFile(payload.document.filePath, "utf8");
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
        currentHostId: "controller",
        hostExecFileImpl(command, args, _options, callback) {
          if (command !== "rsync") {
            callback(new Error(`unexpected command: ${command}`), "", "");
            return;
          }

          const localDestination = resolveRsyncLocalPathForTest(args.at(-1));
          fs.mkdir(path.dirname(localDestination), { recursive: true })
            .then(() => fs.writeFile(localDestination, "remote report\n", "utf8"))
            .then(() => callback(null, "", ""))
            .catch((error) => callback(error, "", ""));
        },
        hostSshConnectTimeoutSecs: 1,
        maxParallelSessions: 1,
      },
      hostRegistryService: {
        async getHost(hostId) {
          assert.equal(hostId, "worker-a");
          return {
            host_id: "worker-a",
            ssh_target: "worker-a",
            workspace_root: remoteWorkspaceRoot,
            worker_runtime_root: path.posix.join(remoteWorkspaceRoot, "state"),
          };
        },
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
            `path: ${remoteFilePath}`,
            "filename: remote-report.txt",
            "```",
          ].join("\n");
          await onEvent(
            { kind: "agent_message", text },
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
            threadId: "remote-file-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      }),
    });

    await workerPool.startPromptRun({
      session,
      prompt: "Скинь удаленный файл",
      message: {
        message_id: 712,
        message_thread_id: 18816,
      },
    });
    await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

    assert.equal(sentDocuments.length, 1);
    assert.equal(sentDocuments[0].document.fileName, "remote-report.txt");
    assert.equal(deliveredContent, "remote report\n");
    assert.equal(sentMessages.at(-1).text, "Отправил файл: remote-report.txt.");
  } finally {
    await fs.rm(localRemoteWorkspaceRoot, { recursive: true, force: true });
    await fs.rm(sessionsRoot, { recursive: true, force: true });
  }
});

test("CodexWorkerPool sends telegram-file directives from a symlinked worktree path", async (t) => {
  const sessionsRoot = await mkdtempForTest(t, "codex-telegram-gateway-sessions-");
  const workspaceParent = await mkdtempForTest(t, "codex-telegram-gateway-worktree-");
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
