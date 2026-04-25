import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import { CodexWorkerPool } from "../src/pty-worker/worker-pool.js";
import { SessionStore } from "../src/session-manager/session-store.js";

const LIVE_ENABLED = process.env.CODEX_LIVE_TESTS === "1";
const LIVE_TIMEOUT_MS = Number.parseInt(
  process.env.CODEX_WORKER_POOL_LIVE_TIMEOUT_MS || "180000",
  10,
);

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

function buildMockApi(sentMessages) {
  return {
    async sendMessage(payload) {
      sentMessages.push(payload);
      return { message_id: sentMessages.length };
    },
    async editMessageText(payload) {
      sentMessages.push({ ...payload, edited: true });
      return { ok: true };
    },
    async deleteMessage() {
      return true;
    },
  };
}

test("live worker pool default exec-json run returns a final reply", {
  skip: LIVE_ENABLED ? false : "set CODEX_LIVE_TESTS=1 to run live worker-pool exec-json smoke",
  timeout: LIVE_TIMEOUT_MS + 5000,
}, async (t) => {
  const config = await loadRuntimeConfig();
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-live-exec-worker-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const sentMessages = [];
  const workerPool = new CodexWorkerPool({
    api: buildMockApi(sentMessages),
    config: {
      ...config,
      codexGatewayBackend: "exec-json",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState: {
      acceptedPrompts: 0,
      lastPromptAt: null,
      activeRunCount: 0,
    },
  });
  t.after(async () => {
    await workerPool.shutdown({
      drainTimeoutMs: 1000,
      interruptActiveRuns: true,
    }).catch(() => null);
    await fs.rm(sessionsRoot, { recursive: true, force: true });
  });

  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 4301,
    topicName: "Live Exec Worker",
    createdVia: "test/live-exec-worker",
    workspaceBinding: {
      repo_root: config.workspaceRoot || process.cwd(),
      cwd: config.workspaceRoot || process.cwd(),
      branch: "main",
      worktree_path: config.workspaceRoot || process.cwd(),
    },
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: "Reply with exactly WORKER_EXEC_JSON_SMOKE_OK and nothing else.",
    message: {
      message_id: 4301,
      message_thread_id: 4301,
    },
  });

  assert.equal(started.ok, true);
  await waitFor(
    () => workerPool.getActiveRun(session.session_key) === null,
    LIVE_TIMEOUT_MS,
    "worker-pool exec-json live run",
  );

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_backend, "exec-json");
  assert.equal(reloaded.last_run_status, "completed");
  assert.ok(reloaded.codex_thread_id, "worker pool should persist exec-json thread id");
  assert.match(reloaded.last_agent_reply || "", /WORKER_EXEC_JSON_SMOKE_OK/u);
  assert.equal(
    sentMessages.some((payload) => /WORKER_EXEC_JSON_SMOKE_OK/u.test(payload.text || "")),
    true,
  );
});
