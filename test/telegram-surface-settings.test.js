import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildNoSessionTopicMessage,
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";

const config = {
  telegramAllowedUserId: "1234567890",
  telegramAllowedUserIds: ["1234567890"],
  telegramAllowedBotIds: ["2234567890"],
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
    source: "windows_rtx",
    planType: "business",
    limitName: "codex",
    unlimited: true,
    windows: [],
    primary: null,
    secondary: null,
    ...overrides,
  };
}

function buildWindowedLimitsSummary(overrides = {}) {
  return {
    available: true,
    capturedAt: "2026-04-04T13:10:00.000Z",
    source: "windows_rtx",
    planType: null,
    limitName: "codex",
    unlimited: false,
    windows: [
      {
        label: "5h",
        usedPercent: 11,
        remainingPercent: 89,
        windowMinutes: 300,
        resetsAt: 1775277000,
        resetsAtIso: "2026-04-03T03:10:00.000Z",
      },
      {
        label: "7d",
        usedPercent: 33,
        remainingPercent: 67,
        windowMinutes: 10080,
        resetsAt: 1775881800,
        resetsAtIso: "2026-04-10T03:10:00.000Z",
      },
    ],
    primary: {
      label: "5h",
      usedPercent: 11,
      remainingPercent: 89,
      windowMinutes: 300,
      resetsAt: 1775277000,
      resetsAtIso: "2026-04-03T03:10:00.000Z",
    },
    secondary: {
      label: "7d",
      usedPercent: 33,
      remainingPercent: 67,
      windowMinutes: 10080,
      resetsAt: 1775881800,
      resetsAtIso: "2026-04-10T03:10:00.000Z",
    },
    ...overrides,
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

test("handleIncomingMessage replies with guidance in General topic for /status", async () => {
  const sent = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/status",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
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

  assert.equal(result.reason, "general-topic");
  assert.equal(sent[0].text, buildNoSessionTopicMessage());
});

test("handleIncomingMessage uses the global panel ENG language for General-topic guidance", async () => {
  const sent = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      ui_language: "eng",
    }),
    message: {
      text: "/status",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
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

  assert.equal(result.reason, "general-topic");
  assert.equal(sent[0].text, buildNoSessionTopicMessage("eng"));
});

test("handleIncomingMessage returns Codex limits in General without requiring a topic session", async () => {
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
      text: "/limits",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
      },
      async getCodexLimitsSummary() {
        return buildUnlimitedLimitsSummary();
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

  assert.equal(result.command, "limits");
  assert.match(sent[0].text, /Лимиты Codex/u);
  assert.match(sent[0].text, /режим: безлимит/u);
});

test("handleIncomingMessage accepts /wait global from General", async () => {
  const sent = [];
  const promptFragmentAssembler = new PromptFragmentAssembler();

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/wait global 60",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
    },
    promptFragmentAssembler,
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {},
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  const waitState = promptFragmentAssembler.getStateForMessage({
    chat: { id: -1001234567890 },
    from: { id: 1234567890 },
  });

  assert.equal(result.command, "wait");
  assert.equal(waitState.global.active, true);
  assert.equal(waitState.global.flushDelayMs, 60000);
  assert.match(sent[0].text, /Global collection window enabled/u);
});

test("handleIncomingMessage keeps /wait global replies in ENG when General panel language is ENG", async () => {
  const sent = [];
  const promptFragmentAssembler = new PromptFragmentAssembler();

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      ui_language: "eng",
    }),
    message: {
      text: "/wait global 60",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
    },
    promptFragmentAssembler,
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {},
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "wait");
  assert.match(sent[0].text, /Global collection window enabled\./u);
  assert.doesNotMatch(sent[0].text, /окно сбора/u);
});

test("handleIncomingMessage stores a global Spike model via /model global", async () => {
  const sent = [];
  const updates = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/model global gpt-5.4-mini",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState,
    sessionService: {
      async getGlobalCodexSettings() {
        return {
          spike_model: null,
          spike_reasoning_effort: null,
          omni_model: null,
          omni_reasoning_effort: null,
        };
      },
      async updateGlobalCodexSetting(target, kind, value) {
        updates.push({ target, kind, value });
        return {
          spike_model: value,
          spike_reasoning_effort: null,
          omni_model: null,
          omni_reasoning_effort: null,
        };
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

  assert.equal(result.command, "model");
  assert.deepEqual(updates, [
    { target: "spike", kind: "model", value: "gpt-5.4-mini" },
  ]);
  assert.match(sent[0].text, /Spike model обновлён\./u);
  assert.match(sent[0].text, /global default: gpt-5\.4-mini/u);
  assert.match(sent[0].text, /effective: gpt-5\.4-mini \(global\)/u);
});

test("handleIncomingMessage keeps global model replies in ENG when General panel language is ENG", async () => {
  const sent = [];
  const updates = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      ui_language: "eng",
    }),
    message: {
      text: "/model global gpt-5.4-mini",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState,
    sessionService: {
      async getGlobalCodexSettings() {
        return {
          spike_model: null,
          spike_reasoning_effort: null,
          omni_model: null,
          omni_reasoning_effort: null,
        };
      },
      async updateGlobalCodexSetting(target, kind, value) {
        updates.push({ target, kind, value });
        return {
          spike_model: value,
          spike_reasoning_effort: null,
          omni_model: null,
          omni_reasoning_effort: null,
        };
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

  assert.equal(result.command, "model");
  assert.deepEqual(updates, [
    { target: "spike", kind: "model", value: "gpt-5.4-mini" },
  ]);
  assert.match(sent[0].text, /Spike model updated\./u);
  assert.match(sent[0].text, /global default: gpt-5\.4-mini/u);
  assert.doesNotMatch(sent[0].text, /Модель Spike/u);
});

test("handleIncomingMessage validates /reasoning global against the global target model", async () => {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-runtime-settings-"),
  );
  const codexConfigPath = path.join(runtimeDir, "config.toml");
  await fs.writeFile(codexConfigPath, 'model = "gpt-5.4"\n', "utf8");
  await fs.writeFile(
    path.join(runtimeDir, "models_cache.json"),
    `${JSON.stringify({
      models: [
        {
          slug: "gpt-5.4",
          display_name: "GPT-5.4",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
            { effort: "xhigh" },
          ],
        },
        {
          slug: "gpt-5.1-codex-mini",
          display_name: "GPT-5.1-Codex-Mini",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "medium" },
            { effort: "high" },
          ],
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const sent = [];
  const updates = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const session = {
    session_key: "-1001234567890:77",
    chat_id: "-1001234567890",
    topic_id: "77",
    topic_name: "Runtime topic",
    lifecycle_state: "active",
    ui_language: "eng",
    spike_model_override: "gpt-5.1-codex-mini",
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config: {
      ...config,
      codexConfigPath,
    },
    message: {
      text: "/reasoning global xhigh",
      entities: [{ type: "bot_command", offset: 0, length: 10 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async getGlobalCodexSettings() {
        return {
          spike_model: "gpt-5.4",
          spike_reasoning_effort: null,
          omni_model: null,
          omni_reasoning_effort: null,
        };
      },
      async updateGlobalCodexSetting(target, kind, value) {
        updates.push({ target, kind, value });
        return {
          spike_model: "gpt-5.4",
          spike_reasoning_effort: value,
          omni_model: null,
          omni_reasoning_effort: null,
        };
      },
      async resolveCodexRuntimeProfile(current, { target }) {
        return target === "spike"
          ? {
              model: current.spike_model_override ?? "gpt-5.4",
              modelSource: current.spike_model_override ? "topic" : "global",
              reasoningEffort: "xhigh",
              reasoningSource: "global",
            }
          : {
              model: "gpt-5.4",
              modelSource: "default",
              reasoningEffort: "medium",
              reasoningSource: "default",
            };
      },
      async recordHandledSession(_, current) {
        return current;
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

  assert.equal(result.command, "reasoning");
  assert.deepEqual(updates, [
    { target: "spike", kind: "reasoning", value: "xhigh" },
  ]);
  assert.match(sent[0].text, /Spike reasoning updated\./u);
  assert.match(sent[0].text, /global default: Extra High \(xhigh\)/u);
});

test("handleIncomingMessage stores topic Omni reasoning via /omni_reasoning", async () => {
  const sent = [];
  const updates = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const session = {
    session_key: "-1001234567890:77",
    chat_id: "-1001234567890",
    topic_id: "77",
    topic_name: "Runtime topic",
    lifecycle_state: "active",
    ui_language: "eng",
    omni_reasoning_effort_override: null,
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/omni_reasoning xhigh",
      entities: [{ type: "bot_command", offset: 0, length: 15 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async getGlobalCodexSettings() {
        return {
          spike_model: null,
          spike_reasoning_effort: null,
          omni_model: null,
          omni_reasoning_effort: null,
        };
      },
      async updateSessionCodexSetting(current, target, kind, value) {
        updates.push({ target, kind, value });
        return {
          ...current,
          omni_reasoning_effort_override: value,
        };
      },
      async resolveCodexRuntimeProfile(current, { target }) {
        return target === "omni"
          ? {
              model: "gpt-5.4",
              modelSource: "default",
              reasoningEffort:
                current.omni_reasoning_effort_override ?? "medium",
              reasoningSource: current.omni_reasoning_effort_override
                ? "topic"
                : "default",
            }
          : {
              model: "gpt-5.4",
              modelSource: "default",
              reasoningEffort: "medium",
              reasoningSource: "default",
            };
      },
      async recordHandledSession(_, current) {
        return current;
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

  assert.equal(result.command, "omni_reasoning");
  assert.deepEqual(updates, [
    { target: "omni", kind: "reasoning", value: "xhigh" },
  ]);
  assert.match(sent[0].text, /Omni reasoning updated\./u);
  assert.match(sent[0].text, /topic override: Extra High \(xhigh\)/u);
  assert.match(sent[0].text, /effective: Extra High \(xhigh\) \(topic\)/u);
});

test("handleIncomingMessage shows resolved Spike and Omni runtime profiles in /status", async () => {
  const sent = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
    codexModel: "gpt-5.4",
    codexReasoningEffort: "medium",
    codexContextWindow: 320000,
    codexAutoCompactTokenLimit: 300000,
  };
  const session = {
    session_key: "-1001234567890:77",
    chat_id: "-1001234567890",
    topic_id: "77",
    topic_name: "Status topic",
    lifecycle_state: "active",
    ui_language: "rus",
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/status",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async resolveContextSnapshot(current) {
        return {
          session: current,
          snapshot: null,
        };
      },
      async resolveCodexRuntimeProfile(_, { target }) {
        return target === "spike"
          ? {
              model: "gpt-5.4-mini",
              modelSource: "topic",
              reasoningEffort: "high",
              reasoningSource: "topic",
            }
          : {
              model: "gpt-5.4",
              modelSource: "global",
              reasoningEffort: "low",
              reasoningSource: "global",
            };
      },
      async getCodexLimitsSummary() {
        return buildWindowedLimitsSummary();
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

  assert.equal(result.command, "status");
  assert.match(sent[0].text, /модель: gpt-5\.4-mini/u);
  assert.match(sent[0].text, /reasoning: High \(high\)/u);
  assert.match(sent[0].text, /omni model: gpt-5\.4/u);
  assert.match(sent[0].text, /omni reasoning: Low \(low\)/u);
  assert.match(sent[0].text, /лимиты 5h: 89% осталось/u);
});

test("handleIncomingMessage shows topic-local Codex limits", async () => {
  const sent = [];
  const session = {
    session_key: "-1001234567890:77",
    chat_id: "-1001234567890",
    topic_id: "77",
    topic_name: "Limits topic",
    lifecycle_state: "active",
    ui_language: "eng",
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/limits",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async getCodexLimitsSummary() {
        return buildWindowedLimitsSummary();
      },
      async recordHandledSession() {
        return session;
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

  assert.equal(result.command, "limits");
  assert.match(sent[0].text, /Codex limits/u);
  assert.match(sent[0].text, /5h: 89% left/u);
  assert.match(sent[0].text, /7d: 67% left/u);
});

test("handleIncomingMessage updates the topic UI language with /language eng", async () => {
  const sent = [];
  let patched = null;
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const session = {
    session_key: "-1001234567890:77",
    chat_id: "-1001234567890",
    topic_id: "77",
    topic_name: "Language topic",
    lifecycle_state: "active",
    ui_language: "rus",
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/language eng",
      entities: [{ type: "bot_command", offset: 0, length: 9 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async updateUiLanguage(current, { language }) {
        patched = { ...current, ui_language: language };
        return patched;
      },
      async recordHandledSession() {
        return patched || session;
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

  assert.equal(result.command, "language");
  assert.equal(patched.ui_language, "eng");
  assert.match(sent[0].text, /Interface language updated\./u);
  assert.match(sent[0].text, /current: ENG/u);
});
