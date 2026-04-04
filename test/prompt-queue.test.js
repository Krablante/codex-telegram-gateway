import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SpikePromptQueueStore,
  drainPendingSpikePromptQueue,
  summarizeQueuedPrompt,
} from "../src/session-manager/prompt-queue.js";
import { SessionStore } from "../src/session-manager/session-store.js";

function buildBinding() {
  return {
    repo_root: "/workspace",
    cwd: "/workspace",
    branch: "main",
    worktree_path: "/workspace",
  };
}

async function ensureSession(sessionStore, topicId = 991) {
  return sessionStore.ensure({
    chatId: -1003577434463,
    topicId,
    topicName: "Prompt queue test",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
}

test("SpikePromptQueueStore enqueues, lists, and deletes queue items", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-prompt-queue-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new SpikePromptQueueStore(sessionStore);
  const session = await ensureSession(sessionStore);

  const first = await promptQueueStore.enqueue(session, {
    rawPrompt: "first queued prompt for verification",
    prompt: "first queued prompt for verification",
  });
  const second = await promptQueueStore.enqueue(session, {
    rawPrompt: "second queued prompt after that",
    prompt: "second queued prompt after that",
  });

  assert.equal(first.position, 1);
  assert.equal(second.position, 2);
  assert.equal(summarizeQueuedPrompt("alpha beta gamma delta epsilon zeta"), "alpha beta gamma delta epsilon...");

  const listed = await promptQueueStore.load(session);
  assert.equal(listed.length, 2);
  assert.equal(listed[0].raw_prompt, "first queued prompt for verification");

  const deleted = await promptQueueStore.deleteAt(session, 2);
  assert.equal(deleted.entry.raw_prompt, "second queued prompt after that");
  assert.equal(deleted.size, 1);

  const remaining = await promptQueueStore.load(session);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].raw_prompt, "first queued prompt for verification");
});

test("drainPendingSpikePromptQueue starts the head prompt and keeps the tail queued", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-prompt-queue-drain-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new SpikePromptQueueStore(sessionStore);
  const session = await ensureSession(sessionStore, 992);

  await promptQueueStore.enqueue(session, {
    rawPrompt: "head prompt",
    prompt: "head prompt",
    attachments: [{ file_path: "/tmp/a.txt", is_image: false }],
    replyToMessageId: 700,
  });
  await promptQueueStore.enqueue(session, {
    rawPrompt: "tail prompt",
    prompt: "tail prompt",
  });

  const started = [];
  const results = await drainPendingSpikePromptQueue({
    session,
    sessionStore,
    promptQueueStore,
    workerPool: {
      async startPromptRun(args) {
        started.push(args);
        return { ok: true };
      },
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].result.reason, "prompt-started");
  assert.equal(started.length, 1);
  assert.equal(started[0].prompt, "head prompt");
  assert.equal(started[0].rawPrompt, "head prompt");
  assert.equal(started[0].attachments.length, 1);
  assert.equal(started[0].message.message_id, 700);

  const remaining = await promptQueueStore.load(session);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].raw_prompt, "tail prompt");
});

test("drainPendingSpikePromptQueue keeps the head queued when the worker is still busy and starts it on retry", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-prompt-queue-busy-retry-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const promptQueueStore = new SpikePromptQueueStore(sessionStore);
  const session = await ensureSession(sessionStore, 993);

  await promptQueueStore.enqueue(session, {
    rawPrompt: "finish teardown, then run this next",
    prompt: "finish teardown, then run this next",
    replyToMessageId: 701,
  });

  const started = [];
  let busy = true;
  const workerPool = {
    async startPromptRun(args) {
      if (busy) {
        return { ok: false, reason: "busy" };
      }

      started.push(args);
      return { ok: true };
    },
  };

  const firstResults = await drainPendingSpikePromptQueue({
    session,
    sessionStore,
    promptQueueStore,
    workerPool,
  });
  assert.equal(firstResults.length, 1);
  assert.equal(firstResults[0].result.reason, "busy");

  const queuedAfterBusy = await promptQueueStore.load(session);
  assert.equal(queuedAfterBusy.length, 1);
  assert.equal(
    queuedAfterBusy[0].raw_prompt,
    "finish teardown, then run this next",
  );

  busy = false;
  const secondResults = await drainPendingSpikePromptQueue({
    session,
    sessionStore,
    promptQueueStore,
    workerPool,
  });
  assert.equal(secondResults.length, 1);
  assert.equal(secondResults[0].result.reason, "prompt-started");
  assert.equal(started.length, 1);
  assert.equal(started[0].prompt, "finish teardown, then run this next");
  assert.equal(started[0].message.message_id, 701);

  const queuedAfterRetry = await promptQueueStore.load(session);
  assert.equal(queuedAfterRetry.length, 0);
});
