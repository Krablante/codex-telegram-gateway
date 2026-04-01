import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexWorkerPool } from "../src/pty-worker/worker-pool.js";
import { SessionStore } from "../src/session-manager/session-store.js";

const LIVE_TESTS_ENABLED = process.env.CODEX_LIVE_TESTS === "1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) {
      return value;
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

function buildParallelPrompt(token, sleepSecs = 3) {
  return [
    `Run exactly this shell command first: sh -lc 'sleep ${sleepSecs}; pwd'`,
    `After the command finishes, reply ONLY with ${token}.`,
    "Do not add any extra text.",
  ].join(" ");
}

function buildSteerablePrompt(baseToken, sleepSecs = 4) {
  return [
    `Run exactly this shell command first: sh -lc 'sleep ${sleepSecs}; pwd'`,
    `After the command finishes, reply ONLY with ${baseToken}.`,
    "If a later user message tells you to append another token, obey it and keep the final answer to a single line.",
    "Do not add any extra text.",
  ].join(" ");
}

function buildMockApi(sentMessages) {
  return {
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
  };
}

async function createSession(sessionStore, topicId, topicName) {
  return sessionStore.ensure({
    chatId: -1003577434463,
    topicId,
    topicName,
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  });
}

test(
  "live worker pool supports concurrent app-server runs across sessions",
  { timeout: 180000, skip: !LIVE_TESTS_ENABLED, concurrency: false },
  async () => {
    const sessionsRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "codex-telegram-gateway-live-sessions-"),
    );
    const sessionStore = new SessionStore(sessionsRoot);
    const sentMessages = [];
    const serviceState = {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    };
    const workerPool = new CodexWorkerPool({
      api: buildMockApi(sentMessages),
      config: {
        codexBinPath: "codex",
        maxParallelSessions: 3,
      },
      sessionStore,
      serviceState,
    });

    try {
      const stamp = Date.now();
      const sessionA = await createSession(sessionStore, 4101, "Live Parallel A");
      const sessionB = await createSession(sessionStore, 4102, "Live Parallel B");
      const sessionC = await createSession(sessionStore, 4103, "Live Parallel C");
      const tokenA = `LIVE_PAR_A_${stamp}`;
      const tokenB = `LIVE_PAR_B_${stamp}`;
      const tokenC = `LIVE_PAR_C_${stamp}`;

      const startA = workerPool.startPromptRun({
        session: sessionA,
        prompt: buildParallelPrompt(tokenA),
        message: {
          message_id: 1101,
          message_thread_id: 4101,
        },
      });
      const startB = workerPool.startPromptRun({
        session: sessionB,
        prompt: buildParallelPrompt(tokenB),
        message: {
          message_id: 1102,
          message_thread_id: 4102,
        },
      });
      const startC = workerPool.startPromptRun({
        session: sessionC,
        prompt: buildParallelPrompt(tokenC),
        message: {
          message_id: 1103,
          message_thread_id: 4103,
        },
      });

      await Promise.all([startA, startB, startC]);
      await waitFor(
        () => serviceState.activeRunCount >= 3,
        60000,
        "three concurrent live runs",
      );
      const [metaA, metaB, metaC] = await waitFor(async () => {
        const nextMetaA = await sessionStore.load(sessionA.chat_id, sessionA.topic_id);
        const nextMetaB = await sessionStore.load(sessionB.chat_id, sessionB.topic_id);
        const nextMetaC = await sessionStore.load(sessionC.chat_id, sessionC.topic_id);
        if (
          nextMetaA?.last_run_status !== "completed" ||
          nextMetaB?.last_run_status !== "completed" ||
          nextMetaC?.last_run_status !== "completed"
        ) {
          return null;
        }

        return [nextMetaA, nextMetaB, nextMetaC];
      }, 180000, "parallel live worker pool completion");
      const threadIds = new Set([
        metaA.codex_thread_id,
        metaB.codex_thread_id,
        metaC.codex_thread_id,
      ]);

      assert.equal(metaA.last_run_status, "completed");
      assert.equal(metaB.last_run_status, "completed");
      assert.equal(metaC.last_run_status, "completed");
      assert.match(metaA.last_agent_reply, new RegExp(tokenA, "u"));
      assert.match(metaB.last_agent_reply, new RegExp(tokenB, "u"));
      assert.match(metaC.last_agent_reply, new RegExp(tokenC, "u"));
      assert.equal(threadIds.size, 3);
    } finally {
      await workerPool.shutdown();
      await fs.rm(sessionsRoot, {
        recursive: true,
        force: true,
      });
    }
  },
);

test(
  "live worker pool steers a running session through the app-server transport",
  { timeout: 180000, skip: !LIVE_TESTS_ENABLED, concurrency: false },
  async () => {
    const sessionsRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "codex-telegram-gateway-live-steer-"),
    );
    const sessionStore = new SessionStore(sessionsRoot);
    const sentMessages = [];
    const serviceState = {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    };
    const workerPool = new CodexWorkerPool({
      api: buildMockApi(sentMessages),
      config: {
        codexBinPath: "codex",
        maxParallelSessions: 1,
      },
      sessionStore,
      serviceState,
    });

    try {
      const stamp = Date.now();
      const baseToken = `LIVE_STEER_BASE_${stamp}`;
      const steerToken = `LIVE_STEER_EXTRA_${stamp}`;
      const session = await createSession(sessionStore, 4201, "Live Steer");

      const started = await workerPool.startPromptRun({
        session,
        prompt: buildSteerablePrompt(baseToken),
        message: {
          message_id: 1201,
          message_thread_id: 4201,
        },
      });

      assert.equal(started.ok, true);
      await waitFor(
        () => workerPool.getActiveRun(session.session_key) !== null,
        60000,
        "live steer run to start",
      );

      await sleep(1000);
      const steered = await workerPool.steerActiveRun({
        session,
        rawPrompt: `Append token ${steerToken}. Final answer must be exactly: ${baseToken} ${steerToken}`,
        message: {
          message_id: 1202,
          message_thread_id: 4201,
        },
      });

      assert.equal(steered.ok, true);
      await waitFor(
        () => workerPool.getActiveRun(session.session_key) === null,
        180000,
        "live steer completion",
      );

      const meta = await sessionStore.load(session.chat_id, session.topic_id);
      assert.equal(meta.last_run_status, "completed");
      assert.match(meta.last_agent_reply, new RegExp(baseToken, "u"));
      assert.match(meta.last_agent_reply, new RegExp(steerToken, "u"));
      assert.equal(sentMessages.at(-1)?.reply_to_message_id, 1202);
    } finally {
      await workerPool.shutdown();
      await fs.rm(sessionsRoot, {
        recursive: true,
        force: true,
      });
    }
  },
);
