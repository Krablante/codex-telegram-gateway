import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionStore } from "../src/session-manager/session-store.js";
import { writeTextAtomicIfChanged } from "../src/state/file-utils.js";

function buildBinding() {
  return {
    repo_root: "/srv/codex-workspace",
    cwd: "/srv/codex-workspace",
    branch: "main",
    worktree_path: "/srv/codex-workspace",
  };
}

test("SessionStore creates and updates session meta", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const created = await store.ensure({
    chatId: -1001234567890,
    topicId: 55,
    topicName: "Slice 3 test",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
    executionHostId: "worker-a",
    executionHostLabel: "worker-a",
  });

  assert.equal(created.session_key, "-1001234567890:55");
  assert.equal(created.topic_name, "Slice 3 test");
  assert.equal(created.execution_host_id, "worker-a");
  assert.equal(created.execution_host_label, "worker-a");
  assert.equal(created.ui_language, "rus");
  assert.equal(created.spike_model_override, null);
  assert.equal(created.spike_reasoning_effort_override, null);

  const loaded = await store.load("-1001234567890", "55");
  assert.equal(loaded.session_key, "-1001234567890:55");
  assert.equal(loaded.spike_model_override, null);
  const topicContextText = await fs.readFile(
    store.getTopicContextPath("-1001234567890", "55"),
    "utf8",
  );
  assert.match(topicContextText, /topic_id: 55/u);
  assert.match(topicContextText, /topic_name: Slice 3 test/u);
  assert.match(topicContextText, /execution_host_id: worker-a/u);
  assert.match(
    topicContextText,
    /This Telegram topic is the current conversation/u,
  );

  const touched = await store.touchCommand(loaded, "status");
  assert.equal(touched.last_command_name, "status");
  assert.ok(touched.last_command_at);
});

test("SessionStore tracks exchange log, artifacts, purge stubs, and reactivates purged sessions as fresh metadata", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const created = await store.ensure({
    chatId: -1001234567890,
    topicId: 77,
    topicName: "Slice 5 test",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
    executionHostId: "worker-a",
    executionHostLabel: "worker-a",
  });

  const exchangeLogResult = await store.appendExchangeLogEntry(created, {
    created_at: "2026-03-24T00:10:00.000Z",
    status: "completed",
    user_prompt: "hello",
    assistant_reply: "world",
  });
  const exchangeLogText = await fs.readFile(
    store.getExchangeLogPath(created.chat_id, created.topic_id),
    "utf8",
  );
  assert.equal(exchangeLogResult.exchangeLogEntries, 1);
  assert.match(exchangeLogText, /"user_prompt":"hello"/u);

  const artifact = await store.writeArtifact(created, {
    kind: "diff",
    content: "diff content",
  });
  assert.equal(artifact.artifact.kind, "diff");
  await fs.access(artifact.filePath);

  const localized = await store.patch(created, {
    ui_language: "eng",
    codex_thread_id: "old-thread",
    provider_session_id: "old-provider",
    codex_rollout_path: "/tmp/old-rollout.jsonl",
    last_context_snapshot: {
      thread_id: "old-thread",
      session_id: "old-provider",
      rollout_path: "/tmp/old-rollout.jsonl",
    },
  });

  const parked = await store.park(localized, "test/park");
  assert.equal(parked.lifecycle_state, "parked");
  assert.equal(parked.parked_reason, "test/park");

  const purged = await store.purge(parked, "test/purge");
  assert.equal(purged.lifecycle_state, "purged");
  await store.patch(purged, {
    pending_prompt_attachments: [{
      file_id: "prompt-file-after-purge",
      file_unique_id: "prompt-file-unique",
      file_name: "prompt.txt",
    }],
    pending_prompt_attachments_expires_at: "2026-04-05T19:00:00.000Z",
    pending_queue_attachments: [{
      file_id: "queue-file-after-purge",
      file_unique_id: "queue-file-unique",
      file_name: "queue.txt",
    }],
    pending_queue_attachments_expires_at: "2026-04-05T19:05:00.000Z",
  });
  await assert.rejects(
    fs.access(store.getExchangeLogPath(created.chat_id, created.topic_id)),
  );
  await assert.rejects(
    fs.access(path.join(store.getArtifactsDir(created.chat_id, created.topic_id), artifact.artifact.file_name)),
  );

  const reloadedPurged = await store.ensure({
    chatId: -1001234567890,
    topicId: 77,
    createdVia: "topic/reactivate",
    workspaceBinding: buildBinding(),
    reactivate: true,
  });
  assert.equal(reloadedPurged.lifecycle_state, "active");
  assert.equal(reloadedPurged.last_command_name, null);
  assert.equal(reloadedPurged.artifact_count, 0);
  assert.equal(reloadedPurged.purged_at, null);
  assert.equal(reloadedPurged.ui_language, "eng");
  assert.ok(reloadedPurged.reactivated_at);
  assert.equal(reloadedPurged.execution_host_id, "worker-a");
  assert.equal(reloadedPurged.execution_host_label, "worker-a");
  assert.deepEqual(reloadedPurged.workspace_binding, buildBinding());
  assert.equal(reloadedPurged.codex_thread_id, null);
  assert.equal(reloadedPurged.provider_session_id, null);
  assert.equal(reloadedPurged.codex_rollout_path, null);
  assert.equal(reloadedPurged.last_context_snapshot, null);
  assert.deepEqual(reloadedPurged.pending_prompt_attachments, [{
    file_id: "prompt-file-after-purge",
    file_unique_id: "prompt-file-unique",
    file_name: "prompt.txt",
  }]);
  assert.equal(
    reloadedPurged.pending_prompt_attachments_expires_at,
    "2026-04-05T19:00:00.000Z",
  );
  assert.deepEqual(reloadedPurged.pending_queue_attachments, [{
    file_id: "queue-file-after-purge",
    file_unique_id: "queue-file-unique",
    file_name: "queue.txt",
  }]);
  assert.equal(
    reloadedPurged.pending_queue_attachments_expires_at,
    "2026-04-05T19:05:00.000Z",
  );
});

test("writeTextAtomicIfChanged skips identical rewrites and reports whether it wrote", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-file-utils-"),
  );
  const filePath = path.join(tempRoot, "topic-context.txt");

  assert.equal(await writeTextAtomicIfChanged(filePath, "same text\n"), true);
  assert.equal(await writeTextAtomicIfChanged(filePath, "same text\n"), false);
  assert.equal(await writeTextAtomicIfChanged(filePath, "updated text\n"), true);
  assert.equal(await fs.readFile(filePath, "utf8"), "updated text\n");
  if (process.platform !== "win32") {
    const stats = await fs.stat(filePath);
    assert.equal(stats.mode & 0o777, 0o600);
  }
});

test("SessionStore preserves original parked retention when the same park reason repeats", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const created = await store.ensure({
    chatId: -1001234567890,
    topicId: 78,
    topicName: "Idempotent park",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  const first = await store.park(created, "telegram/topic-unavailable", {
    purge_after: "2026-04-18T01:00:00.000Z",
  });
  const second = await store.park(first, "telegram/topic-unavailable", {
    purge_after: "2026-04-19T01:00:00.000Z",
  });

  assert.equal(second.lifecycle_state, "parked");
  assert.equal(second.parked_reason, "telegram/topic-unavailable");
  assert.equal(second.parked_at, first.parked_at);
  assert.equal(second.purge_after, "2026-04-18T01:00:00.000Z");
});

test("SessionStore loads compact state from active brief and exchange log", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const created = await store.ensure({
    chatId: -1001234567890,
    topicId: 88,
    topicName: "Compact state test",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  const emptyCompactState = await store.loadCompactState(created);
  assert.equal(emptyCompactState.activeBrief, "");
  assert.deepEqual(emptyCompactState.exchangeLog, []);
  assert.deepEqual(emptyCompactState.progressNotes, []);

  await store.writeSessionText(created, "active-brief.md", "# Active brief\nsentinel\n");
  await store.appendExchangeLogEntry(created, {
    created_at: "2026-03-24T00:11:00.000Z",
    status: "completed",
    user_prompt: "remember sentinel",
    assistant_reply: "SENTINEL_FOX",
  });

  const compactState = await store.loadCompactState(created);
  assert.match(compactState.activeBrief, /sentinel/u);
  assert.equal(compactState.exchangeLog[0].user_prompt, "remember sentinel");
  assert.equal(compactState.exchangeLog[0].assistant_reply, "SENTINEL_FOX");
});

test("SessionStore appends and loads bounded natural-language progress notes", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const created = await store.ensure({
    chatId: -1001234567890,
    topicId: 89,
    topicName: "Progress notes",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  const appended = await store.appendProgressNoteEntry(created, {
    created_at: "2026-04-24T12:00:00.000Z",
    run_started_at: "2026-04-24T11:59:00.000Z",
    thread_id: "thread-notes",
    source: "agent_message",
    event_type: "item.completed",
    text: "Сверяю текущий diff и закрываю blocker по exec-json.",
  });
  assert.equal(appended.entry.session_key, created.session_key);

  await store.appendProgressNoteEntry(created, { text: "  " });
  const notesText = await fs.readFile(
    store.getProgressNotesPath(created.chat_id, created.topic_id),
    "utf8",
  );
  assert.match(notesText, /exec-json/u);

  const loaded = await store.loadProgressNotes(created);
  assert.equal(loaded.length, 1);
  assert.equal(
    loaded[0].text,
    "Сверяю текущий diff и закрываю blocker по exec-json.",
  );

  const reloadedMeta = await store.load(created.chat_id, created.topic_id);
  assert.equal(reloadedMeta.exchange_log_entries, 0);
});

test("SessionStore preserves cache-only model overrides across reload", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  let session = await store.ensure({
    chatId: -1001234567890,
    topicId: 90,
    topicName: "Model persistence",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });
  session = await store.patch(session, {
    spike_model_override: "gpt-5.9-preview",
  });

  const reloaded = await store.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.spike_model_override, "gpt-5.9-preview");
});

test("SessionStore mirrors legacy spike run ownership into normalized session owner fields", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  let session = await store.ensure({
    chatId: -1001234567890,
    topicId: 91,
    topicName: "Ownership normalization",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  session = await store.patch(session, {
    last_run_status: "running",
    spike_run_owner_generation_id: " gen-old ",
  });

  assert.equal(session.session_owner_generation_id, "gen-old");
  assert.equal(session.session_owner_mode, "active");
  assert.ok(session.session_owner_claimed_at);
  assert.equal(session.spike_run_owner_generation_id, "gen-old");

  const reloaded = await store.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.session_owner_generation_id, "gen-old");
  assert.equal(reloaded.session_owner_mode, "active");
  assert.equal(reloaded.spike_run_owner_generation_id, "gen-old");
});

test("SessionStore supports explicit session owner claims and clears mirrored ownership fields", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  let session = await store.ensure({
    chatId: -1001234567890,
    topicId: 92,
    topicName: "Ownership claim API",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  session = await store.claimSessionOwner(session, {
    generationId: " gen-next ",
    mode: "RETIRING",
    claimedAt: "2026-04-05T00:00:00.000Z",
  });
  assert.equal(session.session_owner_generation_id, "gen-next");
  assert.equal(session.session_owner_mode, "retiring");
  assert.equal(session.session_owner_claimed_at, "2026-04-05T00:00:00.000Z");
  assert.equal(session.spike_run_owner_generation_id, "gen-next");

  session = await store.clearSessionOwner(session);
  assert.equal(session.session_owner_generation_id, null);
  assert.equal(session.session_owner_mode, null);
  assert.equal(session.session_owner_claimed_at, null);
  assert.equal(session.spike_run_owner_generation_id, null);
});

test("SessionStore strips legacy memory files on request", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const created = await store.ensure({
    chatId: -1001234567890,
    topicId: 89,
    topicName: "Legacy cleanup",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  await store.writeSessionText(created, "raw-log.ndjson", "{\"type\":\"run.started\"}\n");
  await store.writeSessionJson(created, "recent-window.json", {
    schema_version: 1,
    entries: [{ kind: "run", text: "old" }],
  });
  await store.writeSessionJson(created, "artifact-store.json", {
    schema_version: 1,
    entries: [{ kind: "diff", file_name: "old.diff" }],
  });
  await store.writeSessionJson(created, "task-ledger.json", {
    schema_version: 1,
    runs: [],
  });
  await store.writeSessionJson(created, "pinned-facts.json", {
    schema_version: 1,
    facts: [],
  });

  await store.removeLegacyMemoryFiles(created);

  await assert.rejects(fs.access(path.join(store.getSessionDir(created.chat_id, created.topic_id), "raw-log.ndjson")));
  await assert.rejects(fs.access(path.join(store.getSessionDir(created.chat_id, created.topic_id), "recent-window.json")));
  await assert.rejects(fs.access(path.join(store.getSessionDir(created.chat_id, created.topic_id), "artifact-store.json")));
  await assert.rejects(fs.access(path.join(store.getSessionDir(created.chat_id, created.topic_id), "task-ledger.json")));
  await assert.rejects(fs.access(path.join(store.getSessionDir(created.chat_id, created.topic_id), "pinned-facts.json")));
});

test("SessionStore skips malformed meta files and quarantines them", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const valid = await store.ensure({
    chatId: -1001234567890,
    topicId: 99,
    topicName: "Valid session",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  const corruptDir = store.getSessionDir("-1001234567890", "100");
  await fs.mkdir(corruptDir, { recursive: true });
  await fs.writeFile(path.join(corruptDir, "meta.json"), "{", "utf8");

  assert.equal(await store.load("-1001234567890", "100"), null);
  const quarantined = await fs.readdir(corruptDir);
  assert.equal(
    quarantined.some((entry) => entry.startsWith("meta.json.corrupt-")),
    true,
  );

  const sessions = await store.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session_key, valid.session_key);
});

test("SessionStore listSessionsWithFile only loads sessions that have the requested file", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const queued = await store.ensure({
    chatId: -1001234567890,
    topicId: 100,
    topicName: "Queued session",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });
  await store.writeSessionJson(queued, "spike-prompt-queue.json", {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    items: [
      {
        schema_version: 1,
        created_at: new Date().toISOString(),
        raw_prompt: "queued",
        prompt: "queued",
        attachments: [],
        reply_to_message_id: null,
      },
    ],
  });

  await store.ensure({
    chatId: -1001234567890,
    topicId: 101,
    topicName: "Idle session",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  const corruptDir = store.getSessionDir("-1001234567890", "102");
  await fs.mkdir(corruptDir, { recursive: true });
  await fs.writeFile(path.join(corruptDir, "meta.json"), "{", "utf8");
  await fs.writeFile(
    path.join(corruptDir, "spike-prompt-queue.json"),
    "{\"schema_version\":1,\"items\":[]}",
    "utf8",
  );

  const sessions = await store.listSessionsWithFile("spike-prompt-queue.json");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session_key, queued.session_key);
});

test("SessionStore ensure fails closed after quarantining corrupt meta instead of recreating a fresh session", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);
  const corruptDir = store.getSessionDir("-1001234567890", "101");
  await fs.mkdir(corruptDir, { recursive: true });
  await fs.writeFile(path.join(corruptDir, "meta.json"), "{", "utf8");

  await assert.rejects(
    store.ensure({
      chatId: -1001234567890,
      topicId: 101,
      topicName: "Corrupt session",
      createdVia: "command/new",
      workspaceBinding: buildBinding(),
    }),
    /Corrupt session meta quarantined/u,
  );

  const filesAfterEnsure = await fs.readdir(corruptDir);
  assert.equal(filesAfterEnsure.includes("meta.json"), false);
  assert.equal(
    filesAfterEnsure.some((entry) => entry.startsWith("meta.json.corrupt-")),
    true,
  );
  assert.equal(await store.load("-1001234567890", "101"), null);
});

test("SessionStore keeps fail-closed behavior after listSessions quarantines a corrupt meta", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);
  const corruptDir = store.getSessionDir("-1001234567890", "102");
  await fs.mkdir(corruptDir, { recursive: true });
  await fs.writeFile(path.join(corruptDir, "meta.json"), "{", "utf8");

  assert.deepEqual(await store.listSessions(), []);
  await assert.rejects(
    store.ensure({
      chatId: -1001234567890,
      topicId: 102,
      topicName: "Corrupt after scan",
      createdVia: "command/new",
      workspaceBinding: buildBinding(),
    }),
    /Corrupt session meta quarantined/u,
  );
});

test("SessionStore quarantines malformed exchange logs instead of treating them as empty history", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const created = await store.ensure({
    chatId: -1001234567890,
    topicId: 111,
    topicName: "Corrupt exchange log",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  const exchangeLogPath = store.getExchangeLogPath(created.chat_id, created.topic_id);
  await fs.writeFile(exchangeLogPath, "{\n", "utf8");

  await assert.rejects(
    store.loadExchangeLog(created),
    /Malformed exchange log/u,
  );
  const filesAfterLoad = await fs.readdir(
    store.getSessionDir(created.chat_id, created.topic_id),
  );
  assert.equal(filesAfterLoad.includes("exchange-log.jsonl"), false);
  assert.equal(
    filesAfterLoad.some((entry) => entry.startsWith("exchange-log.jsonl.corrupt-")),
    true,
  );
});

test("SessionStore serializes concurrent meta patches across writers", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const storeA = new SessionStore(sessionsRoot);
  const storeB = new SessionStore(sessionsRoot);

  const created = await storeA.ensure({
    chatId: -1001234567890,
    topicId: 120,
    topicName: "Concurrent patch test",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  let patchFinished = false;
  const slowWriter = storeA.withMetaLock(
    created.chat_id,
    created.topic_id,
    async () => {
      const current = await storeA.load(created.chat_id, created.topic_id);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await storeA.saveUnlocked({
        ...current,
        last_command_name: "status-locked",
        last_command_at: "2026-04-01T18:11:00.000Z",
      });
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 10));
  const concurrentPatch = storeB.patch(created, {
    prompt_suffix_enabled: true,
    prompt_suffix_text: "suffix-locked",
  }).then(() => {
    patchFinished = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    patchFinished,
    false,
    "concurrent patch should wait for the existing meta lock",
  );

  await Promise.all([slowWriter, concurrentPatch]);

  const loaded = await storeA.load(created.chat_id, created.topic_id);
  assert.equal(loaded.last_command_name, "status-locked");
  assert.equal(
    loaded.last_command_at,
    "2026-04-01T18:11:00.000Z",
  );
  assert.equal(loaded.prompt_suffix_enabled, true);
  assert.equal(loaded.prompt_suffix_text, "suffix-locked");
});

test("SessionStore patchWithCurrent computes each patch from the latest locked state", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const storeA = new SessionStore(sessionsRoot);
  const storeB = new SessionStore(sessionsRoot);

  let session = await storeA.ensure({
    chatId: -1001234567890,
    topicId: 121,
    topicName: "Current patch test",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });
  session = await storeA.patch(session, {
    exchange_log_entries: 0,
  });

  let releaseFirstPatch;
  let firstPatchEntered;
  const firstPatchEnteredPromise = new Promise((resolve) => {
    firstPatchEntered = resolve;
  });
  const releaseFirstPatchPromise = new Promise((resolve) => {
    releaseFirstPatch = resolve;
  });

  const firstPatch = storeA.patchWithCurrent(session, async (current) => {
    firstPatchEntered();
    await releaseFirstPatchPromise;
    return {
      exchange_log_entries: current.exchange_log_entries + 1,
      last_user_prompt: "Upload the latest logs.",
    };
  });

  await firstPatchEnteredPromise;
  let secondFinished = false;
  const secondPatch = storeB.patchWithCurrent(session, (current) => ({
    exchange_log_entries: current.exchange_log_entries + 1,
    last_command_name: "Need fresh logs",
  })).then(() => {
    secondFinished = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    secondFinished,
    false,
    "second patchWithCurrent should wait for the existing meta lock",
  );

  releaseFirstPatch();
  await Promise.all([firstPatch, secondPatch]);

  const loaded = await storeA.load(session.chat_id, session.topic_id);
  assert.equal(loaded.exchange_log_entries, 2);
  assert.equal(loaded.last_user_prompt, "Upload the latest logs.");
  assert.equal(loaded.last_command_name, "Need fresh logs");
});

test("SessionStore writeArtifact preserves artifact_count across concurrent writers", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-artifact-race-"),
  );
  const storeA = new SessionStore(sessionsRoot);
  const storeB = new SessionStore(sessionsRoot);

  const session = await storeA.ensure({
    chatId: -1001234567890,
    topicId: 122,
    topicName: "Artifact race test",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  const originalPatchWithCurrent = storeA.patchWithCurrent.bind(storeA);
  let firstPatchHeld = false;
  let enteredFirstPatch;
  const firstPatchEnteredPromise = new Promise((resolve) => {
    enteredFirstPatch = resolve;
  });
  let releaseFirstPatch;
  const releaseFirstPatchPromise = new Promise((resolve) => {
    releaseFirstPatch = resolve;
  });

  storeA.patchWithCurrent = async (meta, patch) => {
    if (firstPatchHeld) {
      return originalPatchWithCurrent(meta, patch);
    }

    firstPatchHeld = true;
    return originalPatchWithCurrent(meta, async (current) => {
      enteredFirstPatch();
      await releaseFirstPatchPromise;
      return typeof patch === "function"
        ? patch(current)
        : patch;
    });
  };

  try {
    const firstWrite = storeA.writeArtifact(session, {
      kind: "diff",
      content: "diff-a",
    });
    await firstPatchEnteredPromise;

    const secondWrite = storeB.writeArtifact(session, {
      kind: "summary",
      content: "summary-b",
    });

    releaseFirstPatch();
    const [firstArtifact, secondArtifact] = await Promise.all([
      firstWrite,
      secondWrite,
    ]);

    const loaded = await storeA.load(session.chat_id, session.topic_id);
    assert.equal(loaded.artifact_count, 2);
    assert.match(
      loaded.last_artifact.kind,
      /^(diff|summary)$/u,
    );
    await fs.access(firstArtifact.filePath);
    await fs.access(secondArtifact.filePath);
  } finally {
    storeA.patchWithCurrent = originalPatchWithCurrent;
  }
});
