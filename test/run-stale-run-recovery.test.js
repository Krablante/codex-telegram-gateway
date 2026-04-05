import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  recoverStaleRunningSessions,
  STALE_RUN_RECOVERY_TEXT,
} from "../src/cli/run-stale-run-recovery.js";
import { SpikeFinalEventStore } from "../src/session-manager/spike-final-event-store.js";
import { SessionStore } from "../src/session-manager/session-store.js";

function createSessionStore(root) {
  return new SessionStore(path.join(root, "sessions"));
}

async function createRunningSession(sessionStore, {
  chatId = -1001234567890,
  topicId = 77,
  ownerGenerationId = "stale-generation",
  lastAgentReply = null,
} = {}) {
  const session = await sessionStore.ensure({
    chatId,
    topicId,
    topicName: "Windows recovery",
    createdVia: "command/new",
    workspaceBinding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  });

  return sessionStore.patch(session, {
    codex_thread_id: "thread-stale-123",
    codex_rollout_path: "/tmp/stale-rollout.jsonl",
    last_context_snapshot: {
      rolloutPath: "/tmp/stale-rollout.jsonl",
      threadId: "thread-stale-123",
    },
    last_agent_reply: lastAgentReply,
    last_run_started_at: "2026-04-05T18:00:00.000Z",
    last_run_status: "running",
    spike_run_owner_generation_id: ownerGenerationId,
  });
}

test("recoverStaleRunningSessions marks dead-owner running sessions as failed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctg-stale-run-recovery-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const sessionStore = createSessionStore(root);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const session = await createRunningSession(sessionStore, {});
  const recovered = await recoverStaleRunningSessions({
    generationStore: {
      async loadGeneration(generationId) {
        return { generation_id: generationId };
      },
      async isGenerationRecordVerifiablyLive() {
        return false;
      },
    },
    now: () => "2026-04-05T18:10:00.000Z",
    sessionStore,
    spikeFinalEventStore,
  });

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  const exchangeLog = await sessionStore.loadExchangeLog(reloaded);
  const spikeFinalEvent = await spikeFinalEventStore.load(reloaded);
  assert.equal(recovered.length, 1);
  assert.equal(reloaded.last_run_status, "failed");
  assert.equal(reloaded.last_run_finished_at, "2026-04-05T18:10:00.000Z");
  assert.equal(reloaded.session_owner_generation_id, null);
  assert.equal(reloaded.session_owner_mode, null);
  assert.equal(reloaded.spike_run_owner_generation_id, null);
  assert.equal(reloaded.codex_thread_id, null);
  assert.equal(reloaded.codex_rollout_path, null);
  assert.equal(reloaded.last_context_snapshot, null);
  assert.equal(reloaded.last_agent_reply, STALE_RUN_RECOVERY_TEXT);
  assert.equal(reloaded.exchange_log_entries, 1);
  assert.equal(exchangeLog.length, 1);
  assert.equal(exchangeLog[0].status, "failed");
  assert.equal(exchangeLog[0].assistant_reply, STALE_RUN_RECOVERY_TEXT);
  assert.equal(spikeFinalEvent.status, "failed");
  assert.equal(spikeFinalEvent.exchange_log_entries, 1);
  assert.equal(spikeFinalEvent.finished_at, "2026-04-05T18:10:00.000Z");
  assert.equal(spikeFinalEvent.final_reply_text, STALE_RUN_RECOVERY_TEXT);
  assert.equal(spikeFinalEvent.thread_id, null);
});

test("recoverStaleRunningSessions keeps live-owned running sessions untouched", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctg-stale-run-recovery-live-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const sessionStore = createSessionStore(root);
  const session = await createRunningSession(sessionStore, {
    ownerGenerationId: "live-generation",
    lastAgentReply: "existing reply",
  });
  const recovered = await recoverStaleRunningSessions({
    generationStore: {
      async loadGeneration(generationId) {
        return { generation_id: generationId };
      },
      async isGenerationRecordVerifiablyLive() {
        return true;
      },
    },
    sessionStore,
  });

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(recovered.length, 0);
  assert.equal(reloaded.last_run_status, "running");
  assert.equal(reloaded.session_owner_generation_id, "live-generation");
  assert.equal(reloaded.codex_thread_id, "thread-stale-123");
  assert.equal(reloaded.codex_rollout_path, "/tmp/stale-rollout.jsonl");
  assert.equal(reloaded.last_agent_reply, "existing reply");
});
