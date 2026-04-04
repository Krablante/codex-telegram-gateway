import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SessionLifecycleManager,
  isTopicUnavailableTelegramError,
} from "../src/session-manager/session-lifecycle-manager.js";
import { SessionStore } from "../src/session-manager/session-store.js";

async function makeStore() {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  return new SessionStore(sessionsRoot);
}

function buildConfig() {
  return {
    parkedSessionRetentionHours: 24,
    telegramForumChatId: "-1003577434463",
  };
}

function buildBinding() {
  return {
    repo_root: "/workspace",
    cwd: "/workspace",
    branch: "main",
    worktree_path: "/workspace",
  };
}

test("SessionLifecycleManager parks a session on forum_topic_closed", async () => {
  const sessionStore = await makeStore();
  const interrupts = [];
  const lifecycleEvents = [];
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 55,
    topicName: "Test topic 1",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const manager = new SessionLifecycleManager({
    config: buildConfig(),
    sessionStore,
    workerPool: {
      getActiveRun(sessionKey) {
        return sessionKey === session.session_key ? { state: { status: "running" } } : null;
      },
      interrupt(sessionKey) {
        interrupts.push(sessionKey);
        return true;
      },
    },
    runtimeObserver: {
      async noteSessionLifecycle(event) {
        lifecycleEvents.push(event);
      },
    },
  });

  const result = await manager.handleServiceMessage({
    chat: { id: -1003577434463 },
    message_thread_id: 55,
    forum_topic_closed: {},
  });

  assert.equal(result.handled, true);
  assert.equal(result.event, "closed");
  assert.equal(interrupts[0], session.session_key);

  const parked = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(parked.lifecycle_state, "parked");
  assert.equal(parked.parked_reason, "telegram/forum-topic-closed");
  assert.ok(parked.purge_after);
  assert.equal(lifecycleEvents[0].action, "parked");
  assert.equal(lifecycleEvents[0].reason, "telegram/forum-topic-closed");
});

test("SessionLifecycleManager reactivates a parked session on forum_topic_reopened", async () => {
  const sessionStore = await makeStore();
  const lifecycleEvents = [];
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 56,
    topicName: "Test topic 2",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  await sessionStore.park(session, "test/park", {
    purge_after: "2026-03-30T00:00:00.000Z",
  });

  const manager = new SessionLifecycleManager({
    config: buildConfig(),
    sessionStore,
    runtimeObserver: {
      async noteSessionLifecycle(event) {
        lifecycleEvents.push(event);
      },
    },
  });

  const result = await manager.handleServiceMessage({
    chat: { id: -1003577434463 },
    message_thread_id: 56,
    forum_topic_reopened: {},
  });

  assert.equal(result.handled, true);
  assert.equal(result.event, "reopened");

  const active = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(active.lifecycle_state, "active");
  assert.equal(active.parked_reason, null);
  assert.equal(active.purge_after, null);
  assert.equal(lifecycleEvents[0].action, "reactivated");
  assert.equal(lifecycleEvents[0].reason, "telegram/forum-topic-reopened");
});

test("SessionLifecycleManager does not reactivate a purged session on forum_topic_reopened", async () => {
  const sessionStore = await makeStore();
  const lifecycleEvents = [];
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 560,
    topicName: "Purged topic",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  await sessionStore.purge(session, "test/purge");

  const manager = new SessionLifecycleManager({
    config: buildConfig(),
    sessionStore,
    runtimeObserver: {
      async noteSessionLifecycle(event) {
        lifecycleEvents.push(event);
      },
    },
  });

  const result = await manager.handleServiceMessage({
    chat: { id: -1003577434463 },
    message_thread_id: 560,
    forum_topic_reopened: {},
  });

  assert.equal(result.handled, true);
  assert.equal(result.event, "reopened");

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.lifecycle_state, "purged");
  assert.equal(lifecycleEvents.length, 0);
});

test("SessionLifecycleManager updates topic name on forum_topic_edited", async () => {
  const sessionStore = await makeStore();
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 57,
    topicName: "Old name",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const manager = new SessionLifecycleManager({
    config: buildConfig(),
    sessionStore,
  });

  await manager.handleServiceMessage({
    chat: { id: -1003577434463 },
    message_thread_id: 57,
    forum_topic_edited: {
      name: "New name",
    },
  });

  const updated = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(updated.topic_name, "New name");
});

test("SessionLifecycleManager sweeps expired parked sessions and preserves pinned ones", async () => {
  const sessionStore = await makeStore();
  const lifecycleEvents = [];
  const expired = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 58,
    topicName: "Expired",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const pinned = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 59,
    topicName: "Pinned",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await sessionStore.park(expired, "test/expired", {
    purge_after: "2000-01-01T00:00:00.000Z",
  });
  await sessionStore.park(pinned, "test/pinned", {
    purge_after: "2000-01-01T00:00:00.000Z",
    retention_pin: true,
  });

  const manager = new SessionLifecycleManager({
    config: buildConfig(),
    sessionStore,
    runtimeObserver: {
      async noteSessionLifecycle(event) {
        lifecycleEvents.push(event);
      },
    },
  });
  const result = await manager.sweepExpiredParkedSessions();

  assert.equal(result.purgedCount, 1);
  const expiredAfter = await sessionStore.load(expired.chat_id, expired.topic_id);
  const pinnedAfter = await sessionStore.load(pinned.chat_id, pinned.topic_id);
  assert.equal(expiredAfter.lifecycle_state, "purged");
  assert.equal(pinnedAfter.lifecycle_state, "parked");
  assert.equal(
    lifecycleEvents.some(
      (event) =>
        event.action === "purged" &&
        event.reason === "retention/expired-parked",
    ),
    true,
  );
});

test("SessionLifecycleManager parks a session on topic-unavailable transport errors", async () => {
  const sessionStore = await makeStore();
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 60,
    topicName: "Transport error",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const manager = new SessionLifecycleManager({
    config: buildConfig(),
    sessionStore,
  });

  const result = await manager.handleTransportError(
    session,
    new Error("Telegram API editMessageText failed: Bad Request: message thread not found"),
  );

  assert.equal(result.handled, true);
  assert.equal(result.parked, true);
  const parked = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(parked.lifecycle_state, "parked");
  assert.equal(parked.parked_reason, "telegram/topic-unavailable");
});

test("isTopicUnavailableTelegramError matches Telegram topic lifecycle failures", () => {
  assert.equal(
    isTopicUnavailableTelegramError(
      new Error("Telegram API sendMessage failed: Bad Request: topic closed"),
    ),
    true,
  );
  assert.equal(
    isTopicUnavailableTelegramError(
      new Error("Telegram API sendMessage failed: Forbidden: bot was blocked by the user"),
    ),
    false,
  );
});
