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

test("CodexWorkerPool passes resolved Spike model and reasoning into runTask", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 177,
    topicName: "Runtime profile test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });
  session = await sessionStore.patch(session, {
    spike_model_override: "gpt-5.4-mini",
    spike_reasoning_effort_override: "high",
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
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    globalCodexSettingsStore: {
      async load() {
        return {
          spike_model: "gpt-5.2",
          spike_reasoning_effort: "low",
          omni_model: null,
          omni_reasoning_effort: null,
        };
      },
    },
    runTask({ model, reasoningEffort, onEvent }) {
      runCalls.push({ model, reasoningEffort });
      return {
        child: {
          kill() {},
        },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              text: "thread started",
              threadId: "runtime-thread",
            },
            {
              type: "thread.started",
              thread_id: "runtime-thread",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              text: "runtime ok",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "runtime ok",
              },
            },
          );
          return {
            exitCode: 0,
            signal: null,
            threadId: "runtime-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Check runtime profile.",
    message: {
      message_id: 44,
      message_thread_id: 177,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.deepEqual(runCalls, [
    {
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
    },
  ]);
});

test("CodexWorkerPool clears the active run slot when startup persistence fails", async () => {
  const deleteCalls = [];
  const session = {
    session_key: "-1003577434463:1701",
    chat_id: "-1003577434463",
    topic_id: "1701",
    ui_language: "rus",
    workspace_binding: {
      cwd: "/home/bloob/atlas",
    },
  };
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
      async deleteMessage(payload) {
        deleteCalls.push(payload);
        return true;
      },
    },
    config: {
      codexBinPath: "codex",
      maxParallelSessions: 1,
    },
    sessionStore: {
      async patch() {
        throw new Error("session meta write failed");
      },
    },
    serviceState,
    runTask() {
      throw new Error("runTask should not start when startup persistence fails");
    },
  });

  await assert.rejects(
    workerPool.startPromptRun({
      session,
      prompt: "Проверь cleanup раннего старта.",
      message: {
        message_id: 91,
        message_thread_id: 1701,
      },
    }),
    /session meta write failed/u,
  );

  assert.equal(workerPool.getActiveRun(session.session_key), null);
  assert.equal(workerPool.getActiveOrStartingRunCount(), 0);
  assert.deepEqual(workerPool.canStart(session.session_key), { ok: true });
  assert.equal(serviceState.activeRunCount, 0);
  assert.equal(deleteCalls.length, 1);

  await workerPool.shutdown();
});

test("CodexWorkerPool launches Codex with a reasoning level supported by the resolved model", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const codexConfigRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-config-"),
  );
  const codexConfigPath = path.join(codexConfigRoot, "config.toml");
  await fs.writeFile(codexConfigPath, 'model = "gpt-5.4"\n', "utf8");
  await fs.writeFile(
    path.join(codexConfigRoot, "models_cache.json"),
    `${JSON.stringify({
      models: [
        {
          slug: "gpt-5.4",
          display_name: "GPT-5.4",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
            { effort: "xhigh" },
          ],
        },
        {
          slug: "gpt-5.1-codex-mini",
          display_name: "GPT-5.1-Codex-Mini",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "medium" },
            { effort: "high" },
          ],
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 178,
    topicName: "Runtime profile compatibility",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });
  session = await sessionStore.patch(session, {
    spike_model_override: "gpt-5.1-codex-mini",
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
      codexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "high",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
    globalCodexSettingsStore: {
      async load() {
        return {
          spike_model: null,
          spike_reasoning_effort: "xhigh",
          omni_model: null,
          omni_reasoning_effort: null,
        };
      },
    },
    runTask({ model, reasoningEffort, onEvent }) {
      runCalls.push({ model, reasoningEffort });
      return {
        child: {
          kill() {},
        },
        finished: (async () => {
          await onEvent(
            {
              kind: "thread",
              text: "thread started",
              threadId: "runtime-thread-2",
            },
            {
              type: "thread.started",
              thread_id: "runtime-thread-2",
            },
          );
          await onEvent(
            {
              kind: "agent_message",
              text: "runtime ok",
            },
            {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "runtime ok",
              },
            },
          );
          return {
            exitCode: 0,
            signal: null,
            threadId: "runtime-thread-2",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Check runtime profile compatibility.",
    message: {
      message_id: 45,
      message_thread_id: 178,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.deepEqual(runCalls, [
    {
      model: "gpt-5.1-codex-mini",
      reasoningEffort: "high",
    },
  ]);
});

test("CodexWorkerPool bootstraps a fresh run from active brief after compaction", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 244,
    topicName: "Fresh brief bootstrap test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });
  const compactedSession = await sessionStore.patch(session, {
    last_compacted_at: "2026-04-01T15:30:00.000Z",
    last_compaction_reason: "command/compact",
    exchange_log_entries: 4,
    last_user_prompt: "Please continue the compact work on the Telegram gateway.",
    last_agent_reply: "I fixed the stale thread reset and we can continue.",
    last_run_status: "completed",
  });
  await sessionStore.writeSessionText(
    compactedSession,
    "active-brief.md",
    [
      "# Active brief",
      "",
      "updated_from_reason: command/compact",
      "session_key: -1003577434463:244",
      "topic_name: Fresh brief bootstrap test",
      "cwd: /home/bloob/atlas",
      "",
      "## Workspace context",
      "- repo_root: /home/bloob/atlas",
      "- focus: codex-telegram-gateway compact flow",
      "",
      "## Current state",
      "- Manual compact just refreshed the recovery brief.",
      "",
      "## Open work",
      "- Make the next fresh run continue cleanly from this brief.",
      "",
      "## Latest exchange",
      "- User wants stronger continuity after /compact.",
    ].join("\n"),
  );

  const sentMessages = [];
  const editedMessages = [];
  const deletedMessages = [];
  const runCalls = [];
  const runTask = ({ prompt, sessionThreadId, onEvent }) => {
    runCalls.push({ prompt, sessionThreadId });
    return {
      child: { kill() {} },
      finished: (async () => {
        await onEvent(
          {
            kind: "thread",
            text: "Codex thread started: fresh-brief-thread",
            threadId: "fresh-brief-thread",
          },
          {
            type: "thread.started",
            thread_id: "fresh-brief-thread",
          },
        );
        await onEvent(
          {
            kind: "agent_message",
            text: "Continued from the refreshed brief.",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Continued from the refreshed brief.",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "fresh-brief-thread",
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
    sessionCompactor: null,
    runTask,
  });

  await workerPool.startPromptRun({
    session: compactedSession,
    prompt: "Continue the compact improvements.",
    message: {
      message_id: 199,
      message_thread_id: 244,
    },
  });

  await waitFor(() => workerPool.getActiveRun(compactedSession.session_key) === null);

  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].sessionThreadId, null);
  assert.match(runCalls[0].prompt, /Telegram topic routing context:/u);
  assert.match(
    runCalls[0].prompt,
    /This Telegram topic has no live Codex thread, but it does have a stored active brief\./u,
  );
  assert.match(runCalls[0].prompt, /last_compaction_reason: command\/compact/u);
  assert.match(runCalls[0].prompt, /exchange_log_entries: 4/u);
  assert.match(runCalls[0].prompt, /## Active brief/u);
  assert.match(runCalls[0].prompt, /focus: codex-telegram-gateway compact flow/u);
  assert.match(runCalls[0].prompt, /## Latest user request/u);
  assert.match(runCalls[0].prompt, /Continue the compact improvements\./u);

  const meta = await sessionStore.load(compactedSession.chat_id, compactedSession.topic_id);
  assert.equal(meta.codex_thread_id, "fresh-brief-thread");
  assert.equal(meta.last_run_status, "completed");
  assert.equal(meta.last_agent_reply, "Continued from the refreshed brief.");

  assert.equal(sentMessages.length, 2);
  assert.equal(sentMessages[0].text, "...");
  assert.equal(sentMessages.at(-1).text, "Continued from the refreshed brief.");
  assert.equal(deletedMessages.length, 1);
  assert.ok(editedMessages.length >= 0);
});

test("CodexWorkerPool does not reply to internal Omni handoff message ids", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 2441,
    topicName: "Internal Omni handoff reply test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });
  session = await sessionStore.patch(session, {
    auto_mode: {
      enabled: true,
      phase: "running",
      omni_bot_id: "8603043042",
      spike_bot_id: "8537834861",
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
            text: "Omni handoff completed.",
          },
          {
            type: "item.completed",
            item: {
              type: "agent_message",
              text: "Omni handoff completed.",
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "omni-handoff-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  await workerPool.startPromptRun({
    session,
    prompt: "continue the auto task",
    message: {
      message_id: 9001,
      message_thread_id: 2441,
      is_internal_omni_handoff: true,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(sentMessages[0].text, "...");
  assert.equal(sentMessages.at(-1).text, "Omni handoff completed.");
  assert.equal("reply_to_message_id" in sentMessages.at(-1), false);
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

