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

test("CodexWorkerPool resumes the stored thread after an interrupted run", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  let session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 2054,
    topicName: "Interrupted continuation",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });
  session = await sessionStore.patch(session, {
    codex_thread_id: "interrupted-thread",
    last_run_status: "interrupted",
    last_user_prompt: "Old prompt",
    last_agent_reply: "Остановлено.",
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
    runTask: ({ prompt, sessionThreadId, onEvent }) => {
      runCalls.push({ prompt, sessionThreadId });
      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent(
            {
              kind: "agent_message",
              text: "Resumed cleanly.",
              messagePhase: "final_answer",
              isPrimaryThreadEvent: true,
            },
            null,
          );
          return {
            exitCode: 0,
            signal: null,
            threadId: "fresh-after-interrupt",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });

  await workerPool.startPromptRun({
    session,
    prompt: "Resume now with the new plan.",
    message: {
      message_id: 44,
      message_thread_id: 2054,
    },
  });

  await waitFor(() => workerPool.getActiveRun(session.session_key) === null);

  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].sessionThreadId, "interrupted-thread");
  assert.match(runCalls[0].prompt, /Resume now with the new plan\./u);

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, "fresh-after-interrupt");
  assert.equal(reloaded.last_agent_reply, "Resumed cleanly.");
});

test("CodexWorkerPool calls onRunTerminated after the run slot is released", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-worker-pool-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 492,
    topicName: "Termination hook test",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });

  const hookCalls = [];
  let workerPool = null;
  workerPool = new CodexWorkerPool({
    api: {
      async sendMessage(payload) {
        return { message_id: payload.reply_to_message_id ?? 1 };
      },
      async editMessageText() {
        return true;
      },
      async deleteMessage() {
        return true;
      },
      async sendChatAction() {
        return true;
      },
    },
    config: {
      maxParallelSessions: 4,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
      codexConfigPath: "/tmp/codex-telegram-gateway-tests-missing-config.toml",
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      activeRunCount: 0,
      lastPromptAt: null,
    },
    onRunTerminated: async ({ session: currentSession, status }) => {
      hookCalls.push({
        sessionKey: currentSession.session_key,
        status,
        activeRun: workerPool.getActiveRun(currentSession.session_key),
      });
    },
    runTask: ({ onEvent }) => ({
      child: null,
      finished: (async () => {
        await onEvent(
          {
            kind: "agent_message",
            text: "Готово.",
            messagePhase: "final_answer",
            threadId: "hook-thread",
            isPrimaryThreadEvent: true,
          },
          {
            method: "item/completed",
            params: {
              threadId: "hook-thread",
              item: {
                type: "agentMessage",
                text: "Готово.",
                phase: "final_answer",
              },
            },
          },
        );

        return {
          exitCode: 0,
          signal: null,
          threadId: "hook-thread",
          warnings: [],
          resumeReplacement: null,
        };
      })(),
    }),
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "Run the termination hook test.",
    message: {
      chat: { id: -1003577434463 },
      message_id: 7001,
      message_thread_id: 492,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(() => hookCalls.length === 1);
  assert.deepEqual(hookCalls, [
    {
      sessionKey: session.session_key,
      status: "completed",
      activeRun: null,
    },
  ]);
});
