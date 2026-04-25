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
  lastUserPrompt = "Fix the gateway continuity.",
  ownerGenerationId = "stale-generation",
  lastAgentReply = null,
  backend = "app-server",
  providerSessionId = "provider-session-stale-123",
  rolloutPath = "/tmp/stale-rollout.jsonl",
  threadId = "thread-stale-123",
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
    codex_backend: backend,
    last_run_backend: backend,
    provider_session_id: providerSessionId,
    codex_thread_id: threadId,
    codex_rollout_path: rolloutPath,
    last_context_snapshot: {
      sessionId: providerSessionId,
      rolloutPath,
      threadId,
    },
    last_agent_reply: lastAgentReply,
    last_user_prompt: lastUserPrompt,
    last_run_started_at: "2026-04-05T18:00:00.000Z",
    last_run_status: "running",
    spike_run_owner_generation_id: ownerGenerationId,
  });
}

test("recoverStaleRunningSessions keeps recoverable dead-owner runs resumable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctg-stale-run-recovery-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const sessionStore = createSessionStore(root);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const session = await createRunningSession(sessionStore, {});
  const recovered = await recoverStaleRunningSessions({
    codexGatewayBackend: "app-server",
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
  assert.equal(reloaded.last_run_status, "interrupted");
  assert.equal(reloaded.last_run_finished_at, "2026-04-05T18:10:00.000Z");
  assert.equal(reloaded.session_owner_generation_id, null);
  assert.equal(reloaded.session_owner_mode, null);
  assert.equal(reloaded.spike_run_owner_generation_id, null);
  assert.equal(reloaded.provider_session_id, "provider-session-stale-123");
  assert.equal(reloaded.codex_thread_id, "thread-stale-123");
  assert.equal(reloaded.codex_rollout_path, "/tmp/stale-rollout.jsonl");
  assert.deepEqual(reloaded.last_context_snapshot, {
    sessionId: "provider-session-stale-123",
    rolloutPath: "/tmp/stale-rollout.jsonl",
    threadId: "thread-stale-123",
  });
  assert.equal(reloaded.last_agent_reply, null);
  assert.equal(reloaded.exchange_log_entries, 0);
  assert.equal(exchangeLog.length, 0);
  assert.equal(spikeFinalEvent.status, "interrupted");
  assert.equal(spikeFinalEvent.exchange_log_entries, 0);
  assert.equal(spikeFinalEvent.finished_at, "2026-04-05T18:10:00.000Z");
  assert.equal(spikeFinalEvent.final_reply_text, null);
  assert.equal(spikeFinalEvent.thread_id, "thread-stale-123");
});

test("recoverStaleRunningSessions clears legacy rollout metadata for exec-json dead-owner runs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctg-stale-exec-json-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const sessionStore = createSessionStore(root);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const session = await createRunningSession(sessionStore, {
    backend: "exec-json",
    providerSessionId: "stale-app-server-provider",
    rolloutPath: "/tmp/stale-app-server-rollout.jsonl",
    threadId: "exec-json-thread-123",
  });
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
  assert.equal(reloaded.last_run_status, "interrupted");
  assert.equal(reloaded.codex_thread_id, "exec-json-thread-123");
  assert.equal(reloaded.provider_session_id, null);
  assert.equal(reloaded.codex_rollout_path, null);
  assert.equal(reloaded.last_context_snapshot, null);
  assert.equal(reloaded.last_agent_reply, null);
  assert.equal(exchangeLog.length, 0);
  assert.equal(spikeFinalEvent.status, "interrupted");
  assert.equal(spikeFinalEvent.final_reply_text, null);
  assert.equal(spikeFinalEvent.thread_id, "exec-json-thread-123");
});

test("recoverStaleRunningSessions does not treat legacy snapshot thread as exec-json continuity", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctg-stale-exec-json-snapshot-only-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const sessionStore = createSessionStore(root);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const session = await createRunningSession(sessionStore, {
    backend: "exec-json",
    providerSessionId: "old-app-server-provider",
    rolloutPath: "/tmp/old-app-server-rollout.jsonl",
    threadId: null,
  });
  await sessionStore.patch(session, {
    last_context_snapshot: {
      sessionId: "old-app-server-provider",
      rolloutPath: "/tmp/old-app-server-rollout.jsonl",
      threadId: "snapshot-only-thread",
    },
  });

  const recovered = await recoverStaleRunningSessions({
    codexGatewayBackend: "exec-json",
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
  assert.equal(reloaded.codex_backend, "exec-json");
  assert.equal(reloaded.last_run_backend, "exec-json");
  assert.equal(reloaded.codex_thread_id, null);
  assert.equal(reloaded.provider_session_id, null);
  assert.equal(reloaded.codex_rollout_path, null);
  assert.equal(reloaded.last_context_snapshot, null);
  assert.equal(reloaded.last_agent_reply, STALE_RUN_RECOVERY_TEXT);
  assert.equal(exchangeLog.length, 1);
  assert.equal(exchangeLog[0].status, "failed");
  assert.equal(exchangeLog[0].assistant_reply, STALE_RUN_RECOVERY_TEXT);
  assert.equal(spikeFinalEvent.status, "failed");
  assert.equal(spikeFinalEvent.final_reply_text, STALE_RUN_RECOVERY_TEXT);
  assert.equal(spikeFinalEvent.thread_id, null);
});

test("recoverStaleRunningSessions completes exec-json runs from mirrored JSONL", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctg-stale-exec-json-final-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const sessionStore = createSessionStore(root);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const session = await createRunningSession(sessionStore, {
    backend: "exec-json",
    lastUserPrompt: "Continue after crash.",
    providerSessionId: "old-provider",
    rolloutPath: "/tmp/old-rollout.jsonl",
    threadId: null,
  });
  const runLogPath = sessionStore.getExecJsonRunLogPath(session.chat_id, session.topic_id);
  await fs.mkdir(path.dirname(runLogPath), { recursive: true });
  await fs.writeFile(
    runLogPath,
    `${JSON.stringify({
      type: "thread.started",
      thread_id: "exec-json-recovered-thread",
    })}\n${JSON.stringify({
      type: "turn.started",
    })}\n${JSON.stringify({
      type: "item.completed",
      item: {
        id: "msg-1",
        type: "agent_message",
        text: "Recovered final answer from exec-json mirror.",
      },
    })}\n${JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 100,
        cached_input_tokens: 10,
        output_tokens: 20,
      },
    })}\n`,
    "utf8",
  );

  const recovered = await recoverStaleRunningSessions({
    codexGatewayBackend: "exec-json",
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
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_backend, "exec-json");
  assert.equal(reloaded.last_run_backend, "exec-json");
  assert.equal(reloaded.codex_thread_id, "exec-json-recovered-thread");
  assert.equal(reloaded.provider_session_id, null);
  assert.equal(reloaded.codex_rollout_path, null);
  assert.equal(reloaded.last_context_snapshot, null);
  assert.equal(
    reloaded.last_agent_reply,
    "Recovered final answer from exec-json mirror.",
  );
  assert.equal(exchangeLog.length, 1);
  assert.equal(exchangeLog[0].status, "completed");
  assert.equal(exchangeLog[0].user_prompt, "Continue after crash.");
  assert.equal(
    exchangeLog[0].assistant_reply,
    "Recovered final answer from exec-json mirror.",
  );
  assert.equal(spikeFinalEvent.status, "completed");
  assert.equal(
    spikeFinalEvent.final_reply_text,
    "Recovered final answer from exec-json mirror.",
  );
  assert.equal(spikeFinalEvent.thread_id, "exec-json-recovered-thread");
});

test("recoverStaleRunningSessions ignores stale app-server metadata when current backend is exec-json", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctg-stale-run-current-exec-json-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const sessionStore = createSessionStore(root);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const session = await createRunningSession(sessionStore, {
    backend: "app-server",
    providerSessionId: "old-provider-from-fallback",
    rolloutPath: "/tmp/old-app-server-rollout.jsonl",
    threadId: "thread-from-current-exec-json-session",
  });
  const recovered = await recoverStaleRunningSessions({
    codexGatewayBackend: "exec-json",
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
  const spikeFinalEvent = await spikeFinalEventStore.load(reloaded);

  assert.equal(recovered.length, 1);
  assert.equal(reloaded.last_run_status, "interrupted");
  assert.equal(reloaded.codex_thread_id, "thread-from-current-exec-json-session");
  assert.equal(reloaded.provider_session_id, null);
  assert.equal(reloaded.codex_rollout_path, null);
  assert.equal(reloaded.last_context_snapshot, null);
  assert.equal(spikeFinalEvent.status, "interrupted");
  assert.equal(spikeFinalEvent.thread_id, "thread-from-current-exec-json-session");
});

test("recoverStaleRunningSessions does not replay the previous run reply for interrupted stale recovery", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctg-stale-run-recovery-old-final-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const sessionStore = createSessionStore(root);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const session = await createRunningSession(sessionStore, {
    lastAgentReply: "OLD FINAL FROM PREVIOUS RUN",
  });
  await recoverStaleRunningSessions({
    codexGatewayBackend: "app-server",
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
  const spikeFinalEvent = await spikeFinalEventStore.load(reloaded);

  assert.equal(reloaded.last_run_status, "interrupted");
  assert.equal(reloaded.last_agent_reply, null);
  assert.equal(spikeFinalEvent.status, "interrupted");
  assert.equal(spikeFinalEvent.final_reply_text, null);
});

test("recoverStaleRunningSessions completes dead-owner runs when rollout already has the final answer", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctg-stale-run-complete-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const codexSessionsRoot = path.join(root, "codex-sessions");
  const rolloutDir = path.join(codexSessionsRoot, "2026", "04", "18");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-provider-session-stale-123.jsonl",
  );
  await fs.writeFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-04-05T18:09:57.900Z",
      type: "session_meta",
      payload: {
        id: "provider-session-stale-123",
      },
    })}\n${JSON.stringify({
      timestamp: "2026-04-05T18:09:58.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        model_context_window: 200000,
      },
    })}\n${JSON.stringify({
      timestamp: "2026-04-05T18:09:58.500Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 100,
            output_tokens: 240,
            reasoning_output_tokens: 80,
            total_tokens: 1540,
          },
          model_context_window: 200000,
        },
      },
    })}\n${JSON.stringify({
      timestamp: "2026-04-05T18:09:58.700Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        phase: "commentary",
        message: "Checking the live continuity path.",
      },
    })}\n${JSON.stringify({
      timestamp: "2026-04-05T18:09:59.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-stale-123",
        last_agent_message: "The recovered run had already finished cleanly.",
      },
    })}\n`,
    "utf8",
  );

  const sessionStore = createSessionStore(root);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const session = await createRunningSession(sessionStore, {
    lastUserPrompt: "Audit the continuity path.",
    rolloutPath: null,
  });
  const recovered = await recoverStaleRunningSessions({
    codexGatewayBackend: "app-server",
    codexSessionsRoot,
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
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.last_run_finished_at, "2026-04-05T18:10:00.000Z");
  assert.equal(reloaded.session_owner_generation_id, null);
  assert.equal(reloaded.spike_run_owner_generation_id, null);
  assert.equal(reloaded.provider_session_id, "provider-session-stale-123");
  assert.equal(reloaded.codex_thread_id, "thread-stale-123");
  assert.equal(reloaded.codex_rollout_path, rolloutPath);
  assert.equal(
    reloaded.last_agent_reply,
    "The recovered run had already finished cleanly.",
  );
  assert.equal(reloaded.exchange_log_entries, 1);
  assert.deepEqual(reloaded.last_context_snapshot, {
    captured_at: "2026-04-05T18:09:58.500Z",
    session_id: "provider-session-stale-123",
    thread_id: "thread-stale-123",
    model_context_window: 200000,
    last_token_usage: {
      input_tokens: 1200,
      cached_input_tokens: 100,
      output_tokens: 240,
      reasoning_tokens: 80,
      total_tokens: 1540,
    },
    rollout_path: rolloutPath,
  });
  assert.equal(exchangeLog.length, 1);
  assert.equal(exchangeLog[0].status, "completed");
  assert.equal(exchangeLog[0].user_prompt, "Audit the continuity path.");
  assert.equal(
    exchangeLog[0].assistant_reply,
    "The recovered run had already finished cleanly.",
  );
  assert.equal(spikeFinalEvent.status, "completed");
  assert.equal(
    spikeFinalEvent.final_reply_text,
    "The recovered run had already finished cleanly.",
  );
  assert.equal(spikeFinalEvent.thread_id, "thread-stale-123");
});

test("recoverStaleRunningSessions ignores old terminal rollout records before a newer task_started", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctg-stale-run-old-terminal-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const codexSessionsRoot = path.join(root, "codex-sessions");
  const rolloutDir = path.join(codexSessionsRoot, "2026", "04", "18");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-provider-session-stale-123.jsonl",
  );
  await fs.writeFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-04-05T18:09:50.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "old-turn",
        last_agent_message: "OLD FINAL FROM EARLIER TURN",
      },
    })}\n${JSON.stringify({
      timestamp: "2026-04-05T18:09:58.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: "new-turn",
        model_context_window: 200000,
      },
    })}\n`,
    "utf8",
  );

  const sessionStore = createSessionStore(root);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const session = await createRunningSession(sessionStore, {
    lastAgentReply: "OLD FINAL FROM PREVIOUS RUN",
    rolloutPath: null,
  });
  await recoverStaleRunningSessions({
    codexGatewayBackend: "app-server",
    codexSessionsRoot,
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
  const spikeFinalEvent = await spikeFinalEventStore.load(reloaded);

  assert.equal(reloaded.last_run_status, "interrupted");
  assert.equal(reloaded.last_agent_reply, null);
  assert.equal(spikeFinalEvent.final_reply_text, null);
});

test("recoverStaleRunningSessions accepts an unterminated task_complete line at EOF", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ctg-stale-run-tail-final-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const codexSessionsRoot = path.join(root, "codex-sessions");
  const rolloutDir = path.join(codexSessionsRoot, "2026", "04", "18");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-provider-session-stale-123.jsonl",
  );
  await fs.writeFile(
    rolloutPath,
    JSON.stringify({
      timestamp: "2026-04-05T18:09:59.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-stale-123",
        last_agent_message: "Recovered from unterminated EOF final.",
      },
    }),
    "utf8",
  );

  const sessionStore = createSessionStore(root);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const session = await createRunningSession(sessionStore, {
    lastUserPrompt: "Audit the continuity path.",
    rolloutPath: null,
  });
  await recoverStaleRunningSessions({
    codexGatewayBackend: "app-server",
    codexSessionsRoot,
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
  const spikeFinalEvent = await spikeFinalEventStore.load(reloaded);

  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.last_agent_reply, "Recovered from unterminated EOF final.");
  assert.equal(
    spikeFinalEvent.final_reply_text,
    "Recovered from unterminated EOF final.",
  );
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
