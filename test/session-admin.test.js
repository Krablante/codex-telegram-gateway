import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RuntimeObserver } from "../src/runtime/runtime-observer.js";
import { SessionAdmin, buildSessionCounts } from "../src/session-manager/session-admin.js";
import { SessionStore } from "../src/session-manager/session-store.js";

function buildBinding() {
  return {
    repo_root: "/workspace",
    cwd: "/workspace",
    branch: "main",
    worktree_path: "/workspace",
  };
}

async function makeHarness() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-admin-"),
  );
  const sessionsRoot = path.join(root, "sessions");
  const logsDir = path.join(root, "logs");
  const sessionStore = new SessionStore(sessionsRoot);
  const runtimeObserver = new RuntimeObserver({
    logsDir,
    config: {
      envFilePath: "/state/runtime.env",
      repoRoot: "/repo",
      stateRoot: "/state",
      telegramForumChatId: "-1001234567890",
    },
    serviceState: {
      startedAt: null,
      botId: null,
      botUsername: null,
      handledUpdates: 0,
      ignoredUpdates: 0,
      handledCommands: 0,
      acceptedPrompts: 0,
      pollErrors: 0,
      knownSessions: 0,
      activeRunCount: 0,
      lastUpdateId: null,
      lastCommandName: null,
      lastCommandAt: null,
      lastPromptAt: null,
      bootstrapDroppedUpdateId: null,
    },
    probe: {
      me: {
        first_name: null,
      },
    },
    mode: "admin",
  });
  const sessionAdmin = new SessionAdmin({
    sessionStore,
    config: {
      parkedSessionRetentionHours: 24,
    },
    runtimeObserver,
  });

  return {
    root,
    logsDir,
    sessionStore,
    sessionAdmin,
  };
}

test("SessionAdmin lists sessions and builds lifecycle counts", async () => {
  const { sessionStore, sessionAdmin } = await makeHarness();

  const active = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 201,
    topicName: "Active",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const parkedBase = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 202,
    topicName: "Parked",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const parked = await sessionStore.park(parkedBase, "test/park", {
    purge_after: "2026-03-30T00:00:00.000Z",
    retention_pin: true,
  });
  const purgedBase = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 203,
    topicName: "Purged",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  await sessionStore.purge(purgedBase, "test/purge");

  const sessions = await sessionAdmin.listSessions();
  const counts = buildSessionCounts(sessions);

  assert.equal(sessions.length, 3);
  assert.equal(counts.total, 3);
  assert.equal(counts.active, 1);
  assert.equal(counts.parked, 1);
  assert.equal(counts.purged, 1);
  assert.equal(counts.pinned, 1);
  assert.equal(
    sessions.some((session) => session.session_key === active.session_key),
    true,
  );
  assert.equal(
    sessions.some((session) => session.session_key === parked.session_key),
    true,
  );
});

test("SessionAdmin pin/unpin/reactivate/purge updates state and audit trails", async () => {
  const { logsDir, sessionStore, sessionAdmin } = await makeHarness();

  const created = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 204,
    topicName: "Retention",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const parked = await sessionStore.park(created, "test/park", {
    purge_after: "2000-01-01T00:00:00.000Z",
  });

  const pinned = await sessionAdmin.setRetentionPin(
    parked.chat_id,
    parked.topic_id,
    true,
    "admin/pin",
  );
  assert.equal(pinned.retention_pin, true);

  const unpinned = await sessionAdmin.setRetentionPin(
    parked.chat_id,
    parked.topic_id,
    false,
    "admin/unpin",
  );
  assert.equal(unpinned.retention_pin, false);
  assert.ok(Date.parse(unpinned.purge_after) > Date.now());

  const active = await sessionAdmin.reactivateSession(
    parked.chat_id,
    parked.topic_id,
  );
  assert.equal(active.lifecycle_state, "active");

  const purged = await sessionAdmin.purgeSession(
    parked.chat_id,
    parked.topic_id,
  );
  assert.equal(purged.lifecycle_state, "purged");

  const events = (await fs.readFile(path.join(logsDir, "runtime-events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(
    events.some(
      (event) =>
        event.type === "session.lifecycle" &&
        event.action === "reactivated" &&
        event.trigger === "admin-cli",
    ),
    true,
  );
  assert.equal(
    events.some(
      (event) =>
        event.type === "session.lifecycle" &&
        event.action === "purged" &&
        event.trigger === "admin-cli",
    ),
    true,
  );
});

test("SessionAdmin refuses to purge a session that still reports a running run", async () => {
  const { sessionAdmin, sessionStore } = await makeHarness();
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 903,
    topicName: "Running session",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  await sessionStore.patch(session, {
    last_run_status: "running",
  });

  await assert.rejects(
    sessionAdmin.purgeSession(session.chat_id, session.topic_id),
    /Cannot purge active session/u,
  );
});
