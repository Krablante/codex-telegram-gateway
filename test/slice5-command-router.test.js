import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildCompactMessage,
  buildCompactStartedMessage,
  buildDiffCleanMessage,
  buildPurgedSessionMessage,
  buildPurgeAckMessage,
  buildPurgeBusyMessage,
  handleIncomingMessage,
} from "../src/telegram/command-router.js";

const config = {
  telegramAllowedUserId: "5825672398",
  telegramForumChatId: "-1003577434463",
  maxParallelSessions: 4,
};

function buildTopicCommandMessage(text) {
  return {
    text,
    entities: [{ type: "bot_command", offset: 0, length: text.length }],
    from: { id: 5825672398, is_bot: false },
    chat: { id: -1003577434463 },
    message_thread_id: 55,
  };
}

function buildSession(overrides = {}) {
  return {
    session_key: "-1003577434463:55",
    chat_id: "-1003577434463",
    topic_id: "55",
    topic_name: "Test topic 1",
    lifecycle_state: "active",
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
    ...overrides,
  };
}

function buildServiceState() {
  return {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
    botUsername: "gatewaybot",
    allowedUserId: "5825672398",
    startedAt: "2026-03-22T12:00:00.000Z",
    handledUpdates: 3,
    acceptedPrompts: 1,
    knownSessions: 1,
    activeRunCount: 0,
    lastUpdateId: 99,
    lastPromptAt: "2026-03-22T12:01:00.000Z",
  };
}

test("handleIncomingMessage reports empty /diff inline when workspace is clean", async () => {
  const messages = [];
  const session = buildSession();

  const result = await handleIncomingMessage({
    api: {
      async sendDocument() {
        throw new Error("should not send a document for clean diff");
      },
      async sendMessage(payload) {
        messages.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: buildTopicCommandMessage("/diff"),
    serviceState: buildServiceState(),
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async createDiffArtifact() {
        return {
          clean: true,
          generatedAt: "2026-03-22T12:05:00.000Z",
        };
      },
      async recordHandledSession() {},
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "diff");
  assert.equal(messages.length, 1);
  assert.equal(
    messages[0].text,
    buildDiffCleanMessage(session, "2026-03-22T12:05:00.000Z"),
  );
});

test("handleIncomingMessage blocks /purge while a run is active", async () => {
  const messages = [];
  const session = buildSession();

  await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        messages.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: buildTopicCommandMessage("/purge"),
    serviceState: buildServiceState(),
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async recordHandledSession() {},
    },
    workerPool: {
      getActiveRun() {
        return { state: { status: "running" } };
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(messages[0].text, buildPurgeBusyMessage(session));
});

test("handleIncomingMessage parks the session when reply delivery hits unavailable topic", async () => {
  const touched = [];
  const session = buildSession();
  const parkedSession = buildSession({
    lifecycle_state: "parked",
    parked_reason: "telegram/topic-unavailable",
  });

  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error(
          "Telegram API sendMessage failed: Bad Request: message thread not found",
        );
      },
    },
    botUsername: "gatewaybot",
    config,
    lifecycleManager: {
      async handleTransportError(currentSession, error) {
        assert.equal(currentSession.session_key, session.session_key);
        assert.match(error.message, /message thread not found/u);
        return {
          handled: true,
          parked: true,
          session: parkedSession,
        };
      },
    },
    message: buildTopicCommandMessage("/status"),
    serviceState: buildServiceState(),
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async recordHandledSession(_, handledSession, commandName) {
        touched.push({ handledSession, commandName });
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.reason, "topic-unavailable");
  assert.equal(touched[0].handledSession.lifecycle_state, "parked");
  assert.equal(touched[0].commandName, "status");
});

test("handleIncomingMessage parks the session when diff delivery hits unavailable topic", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-gateway-"));
  const diffPath = path.join(tmpDir, "workspace.diff");
  await fs.writeFile(diffPath, "diff --git a b\n", "utf8");
  const touched = [];
  const session = buildSession();
  const parkedSession = buildSession({
    lifecycle_state: "parked",
    parked_reason: "telegram/topic-unavailable",
  });

  const result = await handleIncomingMessage({
    api: {
      async sendDocument() {
        throw new Error(
          "Telegram API sendDocument failed: Bad Request: topic closed",
        );
      },
      async sendMessage() {
        throw new Error("should not fall back to sendMessage");
      },
    },
    botUsername: "gatewaybot",
    config,
    lifecycleManager: {
      async handleTransportError(currentSession, error) {
        assert.equal(currentSession.session_key, session.session_key);
        assert.match(error.message, /topic closed/u);
        return {
          handled: true,
          parked: true,
          session: parkedSession,
        };
      },
    },
    message: buildTopicCommandMessage("/diff"),
    serviceState: buildServiceState(),
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async createDiffArtifact() {
        return {
          clean: false,
          filePath: diffPath,
          artifact: {
            file_name: "workspace.diff",
          },
          session,
        };
      },
      async recordHandledSession(_, handledSession, commandName) {
        touched.push({ handledSession, commandName });
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.reason, "topic-unavailable");
  assert.equal(touched[0].handledSession.lifecycle_state, "parked");
  assert.equal(touched[0].commandName, "diff");
});

test("handleIncomingMessage parks the session when help-card delivery hits unavailable topic", async () => {
  const touched = [];
  const session = buildSession();
  const parkedSession = buildSession({
    lifecycle_state: "parked",
    parked_reason: "telegram/topic-unavailable",
  });

  const result = await handleIncomingMessage({
    api: {
      async sendDocument() {
        throw new Error(
          "Telegram API sendDocument failed: Bad Request: message thread not found",
        );
      },
    },
    botUsername: "gatewaybot",
    config,
    lifecycleManager: {
      async handleTransportError(currentSession, error) {
        assert.equal(currentSession.session_key, session.session_key);
        assert.match(error.message, /message thread not found/u);
        return {
          handled: true,
          parked: true,
          session: parkedSession,
        };
      },
    },
    message: buildTopicCommandMessage("/help"),
    serviceState: buildServiceState(),
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async recordHandledSession(_, handledSession, commandName) {
        touched.push({ handledSession, commandName });
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.reason, "topic-unavailable");
  assert.equal(touched[0].handledSession.lifecycle_state, "parked");
  assert.equal(touched[0].commandName, "help");
});

test("handleIncomingMessage refreshes compact state for /compact", async () => {
  const messages = [];
  const touched = [];
  const session = buildSession();
  const compactedSession = buildSession({
    last_compacted_at: "2026-03-22T12:20:00.000Z",
    last_compaction_reason: "command/compact",
    exchange_log_entries: 2,
  });
  let resolveCompact;
  const compactPromise = new Promise((resolve) => {
    resolveCompact = resolve;
  });

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        messages.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: buildTopicCommandMessage("/compact"),
    serviceState: buildServiceState(),
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      isCompacting() {
        return false;
      },
      async compactSession() {
        return compactPromise;
      },
      async recordHandledSession(_, handledSession, commandName) {
        touched.push({ handledSession, commandName });
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "compact");
  assert.equal(
    messages[0].text,
    buildCompactStartedMessage(session),
  );
  assert.equal(messages.length, 1);
  assert.equal(touched[0].handledSession.session_key, session.session_key);

  resolveCompact({
    session: compactedSession,
    reason: "command/compact",
    exchangeLogEntries: 2,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    messages[1].text,
    buildCompactMessage(compactedSession, {
      reason: "command/compact",
      exchangeLogEntries: 2,
    }),
  );
});

test("handleIncomingMessage refuses /compact for purged sessions", async () => {
  const messages = [];
  const purgedSession = buildSession({
    lifecycle_state: "purged",
  });

  await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        messages.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: buildTopicCommandMessage("/compact"),
    serviceState: buildServiceState(),
    sessionService: {
      async ensureSessionForMessage() {
        return purgedSession;
      },
      async recordHandledSession() {},
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(messages[0].text, buildPurgedSessionMessage(purgedSession));
});

test("handleIncomingMessage purges local state and acknowledges /purge", async () => {
  const messages = [];
  const touched = [];
  const session = buildSession();
  const purgedSession = buildSession({
    lifecycle_state: "purged",
    purged_at: "2026-03-22T12:10:00.000Z",
  });

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        messages.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: buildTopicCommandMessage("/purge"),
    serviceState: buildServiceState(),
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async purgeSession() {
        return purgedSession;
      },
      async recordHandledSession(_, handledSession, commandName) {
        touched.push({ handledSession, commandName });
      },
    },
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "purge");
  assert.equal(messages[0].text, buildPurgeAckMessage(purgedSession));
  assert.equal(touched[0].handledSession.lifecycle_state, "purged");
});
