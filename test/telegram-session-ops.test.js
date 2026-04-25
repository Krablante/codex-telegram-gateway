import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildBindingResolutionErrorMessage,
  buildCompactMessage,
  buildCompactStartedMessage,
  buildDiffCleanMessage,
  buildDiffUnavailableMessage,
  buildPurgedSessionMessage,
  buildPurgeAckMessage,
  buildPurgeBusyMessage,
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import {
  buildCompactAlreadyRunningMessage,
} from "../src/telegram/command-handlers/topic-commands.js";

const config = {
  telegramAllowedUserId: "123456789",
  telegramAllowedUserIds: ["123456789"],
  telegramAllowedBotIds: ["8603043042"],
  telegramForumChatId: "-1001234567890",
  maxParallelSessions: 4,
  codexModel: "gpt-5.4",
  codexReasoningEffort: "medium",
  codexContextWindow: 320000,
  codexAutoCompactTokenLimit: 300000,
  codexConfigPath: "/tmp/codex-telegram-gateway-tests-missing-config.toml",
};

function buildUnlimitedLimitsSummary(overrides = {}) {
  return {
    available: true,
    capturedAt: "2026-04-04T13:00:00.000Z",
    source: "windows_worker",
    planType: "business",
    limitName: "codex",
    unlimited: true,
    windows: [],
    primary: null,
    secondary: null,
    ...overrides,
  };
}

function buildTopicCommandMessage(text, overrides = {}) {
  return {
    text,
    entities: [{ type: "bot_command", offset: 0, length: text.length }],
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_thread_id: 55,
    ...overrides,
  };
}

function buildSession(overrides = {}) {
  return {
    session_key: "-1001234567890:55",
    chat_id: "-1001234567890",
    topic_id: "55",
    topic_name: "Test topic 1",
    lifecycle_state: "active",
    workspace_binding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
    allowedUserId: "123456789",
    startedAt: "2026-03-22T12:00:00.000Z",
    handledUpdates: 3,
    acceptedPrompts: 1,
    knownSessions: 1,
    activeRunCount: 0,
    lastUpdateId: 99,
    lastPromptAt: "2026-03-22T12:01:00.000Z",
  };
}

function createGlobalControlPanelStore(initialState = {}) {
  let state = {
    schema_version: 1,
    updated_at: null,
    menu_message_id: null,
    active_screen: "root",
    ui_language: "rus",
    pending_input: null,
    ...initialState,
  };

  return {
    async load() {
      return JSON.parse(JSON.stringify(state));
    },
    async patch(patch) {
      state = {
        ...state,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      return JSON.parse(JSON.stringify(state));
    },
    getState() {
      return JSON.parse(JSON.stringify(state));
    },
  };
}

function createTopicControlPanelStore(initialState = {}) {
  const states = new Map();

  function getKey(session) {
    return String(session?.session_key ?? `${session?.chat_id}:${session?.topic_id}`);
  }

  function ensureState(session) {
    const key = getKey(session);
    if (!states.has(key)) {
      states.set(key, {
        schema_version: 1,
        updated_at: null,
        menu_message_id: null,
        active_screen: "root",
        pending_input: null,
        ...initialState,
      });
    }
    return states.get(key);
  }

  return {
    async load(session) {
      return JSON.parse(JSON.stringify(ensureState(session)));
    },
    async patch(session, patch) {
      const key = getKey(session);
      const nextState = {
        ...ensureState(session),
        ...patch,
        updated_at: new Date().toISOString(),
      };
      states.set(key, nextState);
      return JSON.parse(JSON.stringify(nextState));
    },
    getState(session) {
      return JSON.parse(JSON.stringify(ensureState(session)));
    },
  };
}

test("handleIncomingMessage creates new topic session and sends bootstrap", async () => {
  const sent = [];
  const touched = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/new Slice 4 test",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState: buildServiceState(),
    sessionService: {
      async resolveInheritedBinding() {
        return {
          binding: {
            repo_root: "/srv/codex-workspace",
            cwd: "/srv/codex-workspace",
            branch: "main",
            worktree_path: "/srv/codex-workspace",
          },
          inheritedFromSessionKey: null,
        };
      },
      async createTopicSession() {
        return {
          forumTopic: {
            name: "Slice 4 test",
            message_thread_id: 55,
          },
          session: buildSession(),
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

  assert.equal(result.command, "new");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].message_thread_id, 55);
  assert.equal(touched[0].commandName, "new");
});

test("handleIncomingMessage passes explicit host selection through /new", async () => {
  const createCalls = [];

  await handleIncomingMessage({
    api: {
      async sendMessage() {},
    },
    botUsername: "gatewaybot",
    config: {
      ...config,
      currentHostId: "controller",
    },
    message: {
      text: "/new host=worker-a Slice 4 test",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState: buildServiceState(),
    sessionService: {
      async resolveInheritedBinding() {
        return {
          binding: {
            repo_root: "/srv/codex-workspace",
            cwd: "/srv/codex-workspace",
            branch: "main",
            worktree_path: "/srv/codex-workspace",
          },
          inheritedFromSessionKey: null,
        };
      },
      async createTopicSession(params) {
        createCalls.push(params);
        return {
          forumTopic: {
            name: "Slice 4 test (worker-a)",
            message_thread_id: 55,
          },
          session: buildSession({
            execution_host_id: "worker-a",
            execution_host_label: "worker-a",
          }),
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

  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].executionHostId, "worker-a");
  assert.equal(createCalls[0].title, "Slice 4 test");
});

test("handleIncomingMessage reports unavailable local host for /new", async () => {
  const sent = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/new Slice 4 test",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState: buildServiceState(),
    sessionService: {
      async resolveInheritedBinding() {
        return {
          binding: {
            repo_root: "/srv/codex-workspace",
            cwd: "/srv/codex-workspace",
            branch: "main",
            worktree_path: "/srv/codex-workspace",
          },
          inheritedFromSessionKey: null,
        };
      },
      async createTopicSession() {
        const error = new Error("Execution host unavailable: controller");
        error.code = "EXECUTION_HOST_UNAVAILABLE";
        error.hostId = "controller";
        error.hostLabel = "controller";
        throw error;
      },
      async recordHandledSession() {
        throw new Error("should not record a session for failed /new");
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

  assert.equal(result.command, "new");
  assert.equal(result.reason, "host-unavailable");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /хосте controller/u);
  assert.match(sent[0].text, /недоступен/u);
});

test("handleIncomingMessage reuses the current topic binding for /new without reloading inheritance twice", async () => {
  const sourceSession = buildSession({
    session_key: "-1001234567890:77",
    topic_id: "77",
    workspace_binding: {
      repo_root: "/srv/codex-workspace/work",
      cwd: "/srv/codex-workspace/work",
      branch: "feature/demo",
      worktree_path: "/srv/codex-workspace/work",
    },
  });
  let ensuredSessionCount = 0;
  const created = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {},
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/new Reuse current binding",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    serviceState: buildServiceState(),
    sessionService: {
      async ensureSessionForMessage() {
        ensuredSessionCount += 1;
        return sourceSession;
      },
      async resolveInheritedBinding() {
        throw new Error("should reuse the already loaded topic session");
      },
      async createTopicSession({ workspaceBinding, inheritedFromSessionKey }) {
        created.push({ workspaceBinding, inheritedFromSessionKey });
        return {
          forumTopic: {
            name: "Reuse current binding",
            message_thread_id: 78,
          },
          session: buildSession({
            session_key: "-1001234567890:78",
            topic_id: "78",
            workspace_binding: workspaceBinding,
          }),
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

  assert.equal(result.command, "new");
  assert.equal(ensuredSessionCount, 1);
  assert.deepEqual(created, [
    {
      workspaceBinding: sourceSession.workspace_binding,
      inheritedFromSessionKey: sourceSession.session_key,
    },
  ]);
});

test("handleIncomingMessage creates and pins a local control menu for a new topic", async () => {
  const sent = [];
  const pinned = [];
  const topicControlPanelStore = createTopicControlPanelStore();
  const session = buildSession({
    session_key: "-1001234567890:58",
    topic_id: "58",
    ui_language: "rus",
    prompt_suffix_topic_enabled: true,
    prompt_suffix_text: null,
    prompt_suffix_enabled: false,
    spike_model_override: null,
    spike_reasoning_effort_override: null,
  });

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 900 + sent.length };
      },
      async pinChatMessage(payload) {
        pinned.push(payload);
        return true;
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/new Local menu topic",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState: buildServiceState(),
    sessionService: {
      async resolveInheritedBinding() {
        return {
          binding: session.workspace_binding,
          inheritedFromSessionKey: null,
        };
      },
      async createTopicSession() {
        return {
          forumTopic: {
            name: "Local menu topic",
            message_thread_id: 58,
          },
          session,
        };
      },
      async getGlobalCodexSettings() {
        return {
          spike_model: null,
          spike_reasoning_effort: null,
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async getCodexLimitsSummary() {
        return buildUnlimitedLimitsSummary();
      },
      async recordHandledSession() {},
    },
    topicControlPanelStore,
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "new");
  assert.equal(sent.length, 3);
  assert.equal(sent[0].message_thread_id, 58);
  assert.equal(sent[1].message_thread_id, 58);
  assert.match(sent[1].text, /Topic control panel/u);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].message_id, 902);
  assert.equal(topicControlPanelStore.getState(session).menu_message_id, 902);
});

test("handleIncomingMessage creates new topic session with explicit binding path", async () => {
  const sent = [];
  const touched = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/new cwd=projects/codex-telegram-gateway Bound repo",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState: buildServiceState(),
    sessionService: {
      async resolveBindingPath(requestedPath) {
        assert.equal(
          requestedPath,
          "projects/codex-telegram-gateway",
        );
        return {
          repo_root: "/srv/codex-workspace/codex-telegram-gateway",
          cwd: "/srv/codex-workspace/codex-telegram-gateway",
          branch: "main",
          worktree_path: "/srv/codex-workspace/codex-telegram-gateway",
        };
      },
      async createTopicSession({ title, workspaceBinding, inheritedFromSessionKey }) {
        assert.equal(title, "Bound repo");
        assert.equal(inheritedFromSessionKey, null);
        assert.equal(
          workspaceBinding.cwd,
          "/srv/codex-workspace/codex-telegram-gateway",
        );
        return {
          forumTopic: {
            name: "Bound repo",
            message_thread_id: 56,
          },
          session: buildSession({
            session_key: "-1001234567890:56",
            topic_id: "56",
            workspace_binding: workspaceBinding,
          }),
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

  assert.equal(result.command, "new");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].message_thread_id, 56);
  assert.equal(touched[0].commandName, "new");
});

test("handleIncomingMessage creates a new topic in English when General panel language is ENG", async () => {
  const sent = [];
  const store = createGlobalControlPanelStore({
    ui_language: "eng",
  });

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: store,
    message: {
      text: "/new English topic",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState: buildServiceState(),
    sessionService: {
      async resolveInheritedBinding() {
        return {
          binding: {
            repo_root: "/srv/codex-workspace",
            cwd: "/srv/codex-workspace",
            branch: "main",
            worktree_path: "/srv/codex-workspace",
          },
          inheritedFromSessionKey: null,
        };
      },
      async createTopicSession({ title, uiLanguage }) {
        assert.equal(title, "English topic");
        assert.equal(uiLanguage, "eng");
        return {
          forumTopic: {
            name: "English topic",
            message_thread_id: 57,
          },
          session: buildSession({
            session_key: "-1001234567890:57",
            topic_id: "57",
            ui_language: "eng",
          }),
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

  assert.equal(result.command, "new");
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Topic is ready\./u);
  assert.match(sent[1].text, /Created topic "English topic"\./u);
});

test("handleIncomingMessage reports binding resolution failures for /new", async () => {
  const sent = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/new cwd=/missing/path Bound repo",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState: buildServiceState(),
    sessionService: {
      async resolveBindingPath() {
        throw new Error("ENOENT: no such file or directory");
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

  assert.equal(result.reason, "binding-error");
  assert.equal(
    sent[0].text,
    buildBindingResolutionErrorMessage(
      "/missing/path",
      new Error("ENOENT: no such file or directory"),
    ),
  );
});

test("handleIncomingMessage reports binding resolution failures for /new in English from General", async () => {
  const sent = [];
  const store = createGlobalControlPanelStore({
    ui_language: "eng",
  });

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: store,
    message: {
      text: "/new cwd=/missing/path Bound repo",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState: buildServiceState(),
    sessionService: {
      async resolveBindingPath() {
        throw new Error("ENOENT: no such file or directory");
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

  assert.equal(result.reason, "binding-error");
  assert.equal(
    sent[0].text,
    buildBindingResolutionErrorMessage(
      "/missing/path",
      new Error("ENOENT: no such file or directory"),
      "eng",
    ),
  );
});

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

test("handleIncomingMessage reports unavailable /diff inline for non-git bindings", async () => {
  const messages = [];
  const session = buildSession({
    workspace_binding: {
      repo_root: "C:/Users/Friend/Desktop/plain-folder",
      cwd: "C:/Users/Friend/Desktop/plain-folder",
      branch: null,
      worktree_path: "C:/Users/Friend/Desktop/plain-folder",
    },
  });

  const result = await handleIncomingMessage({
    api: {
      async sendDocument() {
        throw new Error("should not send a document for unavailable diff");
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
          unavailable: true,
          reason: "workspace-not-git",
          generatedAt: "2026-04-08T18:55:00.000Z",
          cwd: session.workspace_binding.cwd,
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
    buildDiffUnavailableMessage(session, "2026-04-08T18:55:00.000Z"),
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

test("handleIncomingMessage blocks /purge while compact is active", async () => {
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
      async isCompacting() {
        return true;
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

  assert.equal(messages[0].text, buildPurgeBusyMessage(session));
});

test("handleIncomingMessage blocks /purge while a foreign-owned run is still marked running", async () => {
  const messages = [];
  const session = buildSession({
    last_run_status: "running",
    session_owner_generation_id: "gen-old",
  });

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
      async isCompacting() {
        return false;
      },
      async recordHandledSession() {},
      async purgeSession() {
        throw new Error("should not purge a foreign-owned running session");
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

test("handleIncomingMessage blocks /compact while the topic run is active", async () => {
  const messages = [];
  const session = buildSession({
    last_run_status: "running",
    session_owner_generation_id: "spike-gen-1",
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
        return session;
      },
      isCompacting() {
        return false;
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

  assert.equal(messages[0].text, buildCompactAlreadyRunningMessage(session));
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
