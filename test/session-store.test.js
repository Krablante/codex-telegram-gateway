import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionStore } from "../src/session-manager/session-store.js";

function buildBinding() {
  return {
    repo_root: "/home/bloob/atlas",
    cwd: "/home/bloob/atlas",
    branch: "main",
    worktree_path: "/home/bloob/atlas",
  };
}

test("SessionStore creates and updates session meta", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const created = await store.ensure({
    chatId: -1003577434463,
    topicId: 55,
    topicName: "Slice 3 test",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  assert.equal(created.session_key, "-1003577434463:55");
  assert.equal(created.topic_name, "Slice 3 test");
  assert.equal(created.ui_language, "rus");

  const loaded = await store.load("-1003577434463", "55");
  assert.equal(loaded.session_key, "-1003577434463:55");
  const topicContextText = await fs.readFile(
    store.getTopicContextPath("-1003577434463", "55"),
    "utf8",
  );
  assert.match(topicContextText, /topic_id: 55/u);
  assert.match(topicContextText, /topic_name: Slice 3 test/u);
  assert.match(
    topicContextText,
    /This Telegram topic is the current conversation/u,
  );

  const touched = await store.touchCommand(loaded, "status");
  assert.equal(touched.last_command_name, "status");
  assert.ok(touched.last_command_at);
});

test("SessionStore tracks exchange log, artifacts, purge stubs, and reactivation", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const created = await store.ensure({
    chatId: -1003577434463,
    topicId: 77,
    topicName: "Slice 5 test",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
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
  });

  const parked = await store.park(localized, "test/park");
  assert.equal(parked.lifecycle_state, "parked");
  assert.equal(parked.parked_reason, "test/park");

  const purged = await store.purge(parked, "test/purge");
  assert.equal(purged.lifecycle_state, "purged");
  await assert.rejects(
    fs.access(store.getExchangeLogPath(created.chat_id, created.topic_id)),
  );
  await assert.rejects(
    fs.access(path.join(store.getArtifactsDir(created.chat_id, created.topic_id), artifact.artifact.file_name)),
  );

  const reactivated = await store.ensure({
    chatId: -1003577434463,
    topicId: 77,
    createdVia: "topic/reactivate",
    workspaceBinding: buildBinding(),
    reactivate: true,
  });
  assert.equal(reactivated.lifecycle_state, "active");
  assert.equal(reactivated.last_command_name, null);
  assert.equal(reactivated.artifact_count, 0);
  assert.equal(reactivated.purged_at, null);
  assert.equal(reactivated.ui_language, "eng");
  assert.ok(reactivated.reactivated_at);
  assert.equal(reactivated.lifecycle_reactivated_reason, "topic/reactivate");
});

test("SessionStore loads compact state from active brief and exchange log", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const created = await store.ensure({
    chatId: -1003577434463,
    topicId: 88,
    topicName: "Compact state test",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  const emptyCompactState = await store.loadCompactState(created);
  assert.equal(emptyCompactState.activeBrief, "");
  assert.deepEqual(emptyCompactState.exchangeLog, []);

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

test("SessionStore strips legacy memory files on request", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const created = await store.ensure({
    chatId: -1003577434463,
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
    chatId: -1003577434463,
    topicId: 99,
    topicName: "Valid session",
    createdVia: "command/new",
    workspaceBinding: buildBinding(),
  });

  const corruptDir = store.getSessionDir("-1003577434463", "100");
  await fs.mkdir(corruptDir, { recursive: true });
  await fs.writeFile(path.join(corruptDir, "meta.json"), "{", "utf8");

  assert.equal(await store.load("-1003577434463", "100"), null);
  const quarantined = await fs.readdir(corruptDir);
  assert.equal(
    quarantined.some((entry) => entry.startsWith("meta.json.corrupt-")),
    true,
  );

  const sessions = await store.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session_key, valid.session_key);
});

test("SessionStore quarantines malformed exchange logs instead of treating them as empty history", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const store = new SessionStore(sessionsRoot);

  const created = await store.ensure({
    chatId: -1003577434463,
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
