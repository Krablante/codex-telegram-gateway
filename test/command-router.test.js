import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  applyPromptSuffix,
  buildBindingResolutionErrorMessage,
  buildNoSessionTopicMessage,
  buildReplyMessageParams,
  buildStatusMessage,
  extractBotCommand,
  getTopicLabel,
  handleIncomingCallbackQuery,
  handleIncomingMessage,
  isAuthorizedMessage,
  parseLanguageCommandArgs,
  parseQueueCommandArgs,
  parseWaitCommandArgs,
  parsePromptSuffixCommandArgs,
  parseNewTopicCommandArgs,
  parseScopedRuntimeSettingCommandArgs,
} from "../src/telegram/command-router.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";

const config = {
  telegramAllowedUserId: "123456789",
  telegramAllowedUserIds: ["123456789"],
  telegramAllowedBotIds: ["222333444"],
  telegramForumChatId: "-1001234567890",
  maxParallelSessions: 4,
  codexModel: "gpt-5.4",
  codexReasoningEffort: "medium",
  codexContextWindow: 320000,
  codexAutoCompactTokenLimit: 300000,
  codexConfigPath: "/tmp/codex-telegram-gateway-tests-missing-config.toml",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

test("extractBotCommand parses direct commands and bot username suffix", () => {
  const rawCommand = "/status@jvan34fsdfbifbiwnoi4bot";
  const message = {
    text: `${rawCommand} now`,
    entities: [{ type: "bot_command", offset: 0, length: rawCommand.length }],
  };

  const command = extractBotCommand(message, "jvan34fsdfbifbiwnoi4bot");
  assert.equal(command.name, "status");
  assert.equal(command.args, "now");
});

test("extractBotCommand also parses commands from caption entities", () => {
  const message = {
    caption: "/interrupt now",
    caption_entities: [{ type: "bot_command", offset: 0, length: 10 }],
  };

  const command = extractBotCommand(message, "gatewaybot");
  assert.equal(command.name, "interrupt");
  assert.equal(command.args, "now");
});

test("extractBotCommand accepts bare wait commands when args are valid", () => {
  assert.deepEqual(
    extractBotCommand(
      {
        text: "wait 600",
      },
      "gatewaybot",
    ),
    {
      name: "wait",
      raw: "wait",
      args: "600",
    },
  );
  assert.equal(
    extractBotCommand(
      {
        text: "wait why is this broken",
      },
      "gatewaybot",
    ),
    null,
  );
});

test("parseQueueCommandArgs distinguishes queue actions from prompt text", () => {
  assert.deepEqual(parseQueueCommandArgs("status"), {
    action: "status",
    text: null,
    position: null,
  });
  assert.deepEqual(parseQueueCommandArgs("delete 2"), {
    action: "delete",
    text: null,
    position: 2,
  });
  assert.deepEqual(parseQueueCommandArgs("delete node_modules and retry"), {
    action: "enqueue",
    text: "delete node_modules and retry",
    position: null,
  });
});

test("parseNewTopicCommandArgs keeps legacy title mode and supports explicit binding path", () => {
  assert.deepEqual(parseNewTopicCommandArgs("Slice 4 test"), {
    bindingPath: null,
    title: "Slice 4 test",
  });
  assert.deepEqual(
    parseNewTopicCommandArgs("cwd=/workspace Gateway topic"),
    {
      bindingPath: "/workspace",
      title: "Gateway topic",
    },
  );
  assert.deepEqual(
    parseNewTopicCommandArgs("--cwd=projects/codex-telegram-gateway"),
    {
      bindingPath: "projects/codex-telegram-gateway",
      title: "",
    },
  );
});

test("parsePromptSuffixCommandArgs supports show, toggle, and set modes", () => {
  assert.deepEqual(parsePromptSuffixCommandArgs(""), {
    scope: "topic",
    action: "show",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("on"), {
    scope: "topic",
    action: "on",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("off"), {
    scope: "topic",
    action: "off",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("clear"), {
    scope: "topic",
    action: "clear",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("P.S.\nKeep it short."), {
    scope: "topic",
    action: "set",
    text: "P.S.\nKeep it short.",
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("global"), {
    scope: "global",
    action: "show",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("global on"), {
    scope: "global",
    action: "on",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("global clear"), {
    scope: "global",
    action: "clear",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("global P.S.\nKeep it short."), {
    scope: "global",
    action: "set",
    text: "P.S.\nKeep it short.",
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("topic"), {
    scope: "topic-control",
    action: "show",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("topic off"), {
    scope: "topic-control",
    action: "off",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("topic on"), {
    scope: "topic-control",
    action: "on",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("help"), {
    scope: "help",
    action: "show",
    text: null,
  });
});

test("parseWaitCommandArgs supports local and global wait scopes", () => {
  assert.deepEqual(parseWaitCommandArgs(""), {
    action: "show",
    scope: "effective",
    delayMs: null,
    seconds: null,
  });
  assert.deepEqual(parseWaitCommandArgs("off"), {
    action: "off",
    scope: "topic",
    delayMs: null,
    seconds: null,
  });
  assert.deepEqual(parseWaitCommandArgs("60"), {
    action: "set",
    scope: "topic",
    delayMs: 60000,
    seconds: 60,
  });
  assert.deepEqual(parseWaitCommandArgs("1m"), {
    action: "set",
    scope: "topic",
    delayMs: 60000,
    seconds: 60,
  });
  assert.deepEqual(parseWaitCommandArgs("90s"), {
    action: "set",
    scope: "topic",
    delayMs: 90000,
    seconds: 90,
  });
  assert.deepEqual(parseWaitCommandArgs("global"), {
    action: "show",
    scope: "global",
    delayMs: null,
    seconds: null,
  });
  assert.deepEqual(parseWaitCommandArgs("global 60"), {
    action: "set",
    scope: "global",
    delayMs: 60000,
    seconds: 60,
  });
  assert.deepEqual(parseWaitCommandArgs("global off"), {
    action: "off",
    scope: "global",
    delayMs: null,
    seconds: null,
  });
  assert.equal(parseWaitCommandArgs("9999").action, "invalid");
});

test("parseLanguageCommandArgs supports show and ENG/RUS values", () => {
  assert.deepEqual(parseLanguageCommandArgs(""), {
    action: "show",
    language: null,
    raw: "",
  });
  assert.deepEqual(parseLanguageCommandArgs("eng"), {
    action: "set",
    language: "eng",
    raw: "eng",
  });
  assert.deepEqual(parseLanguageCommandArgs("RUS"), {
    action: "set",
    language: "rus",
    raw: "RUS",
  });
  assert.equal(parseLanguageCommandArgs("deu").action, "invalid");
});

test("parseScopedRuntimeSettingCommandArgs supports topic and global modes", () => {
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs(""), {
    scope: "topic",
    action: "show",
    value: null,
  });
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs("list"), {
    scope: "topic",
    action: "list",
    value: null,
  });
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs("clear"), {
    scope: "topic",
    action: "clear",
    value: null,
  });
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs("gpt-5.4-mini"), {
    scope: "topic",
    action: "set",
    value: "gpt-5.4-mini",
  });
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs("global"), {
    scope: "global",
    action: "show",
    value: null,
  });
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs("global list"), {
    scope: "global",
    action: "list",
    value: null,
  });
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs("global xhigh"), {
    scope: "global",
    action: "set",
    value: "xhigh",
  });
});

test("applyPromptSuffix prefers topic suffix over global and falls back when topic is off", () => {
  assert.equal(
    applyPromptSuffix(
      "run a quick task",
      {
        prompt_suffix_enabled: true,
        prompt_suffix_text: "P.S.\nKeep it short.",
      },
      {
        prompt_suffix_enabled: true,
        prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
      },
    ),
    "run a quick task\n\nP.S.\nKeep it short.",
  );
  assert.equal(
    applyPromptSuffix(
      "run a quick task",
      {
        prompt_suffix_enabled: false,
        prompt_suffix_text: "TOPIC\nKeep it short.",
      },
      {
        prompt_suffix_enabled: true,
        prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
      },
    ),
    "run a quick task\n\nGLOBAL\nNever overcomplicate.",
  );
  assert.equal(
    applyPromptSuffix(
      "run a quick task",
      {
        prompt_suffix_topic_enabled: false,
        prompt_suffix_enabled: true,
        prompt_suffix_text: "TOPIC\nKeep it short.",
      },
      {
        prompt_suffix_enabled: true,
        prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
      },
    ),
    "run a quick task",
  );
});

test("isAuthorizedMessage allows trusted human and trusted bot principals in configured chat", () => {
  const message = {
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
  };

  assert.equal(isAuthorizedMessage(message, config), true);
  assert.equal(
    isAuthorizedMessage(
      {
        from: { id: 222333444, is_bot: true },
        chat: { id: -1001234567890 },
      },
      config,
    ),
    true,
  );
  assert.equal(
    isAuthorizedMessage(
      { ...message, from: { id: 1, is_bot: false } },
      config,
    ),
    false,
  );
  assert.equal(
    isAuthorizedMessage(
      {
        from: { id: 999999999, is_bot: true },
        chat: { id: -1001234567890 },
      },
      config,
    ),
    false,
  );
});

test("buildReplyMessageParams keeps topic routing when message_thread_id exists", () => {
  const message = {
    chat: { id: -1001234567890 },
    message_thread_id: 42,
  };

  assert.deepEqual(buildReplyMessageParams(message, "ok"), {
    chat_id: -1001234567890,
    text: "ok",
    message_thread_id: 42,
  });
  assert.equal(getTopicLabel(message), "42");
});

test("buildStatusMessage reports session state, binding, and run state", () => {
  const text = buildStatusMessage(
    {
      codexModel: "gpt-5.4",
      codexReasoningEffort: "xhigh",
      codexContextWindow: 320000,
      codexAutoCompactTokenLimit: 300000,
    },
    {
      chat: { id: -1001234567890 },
      message_thread_id: 7,
    },
    {
      session_key: "-1001234567890:7",
      topic_name: "Test topic 1",
      lifecycle_state: "active",
      codex_thread_id: "thread-1",
      last_run_status: "running",
      last_run_started_at: "2026-03-22T12:01:00.000Z",
      last_run_finished_at: null,
      last_token_usage: {
        input_tokens: 227200,
        cached_input_tokens: 180000,
        output_tokens: 1200,
        reasoning_tokens: 800,
        total_tokens: 228400,
      },
      workspace_binding: {
        repo_root: "/workspace",
        cwd: "/workspace",
        branch: "main",
        worktree_path: "/workspace",
      },
    },
    {
      state: {
        status: "running",
        threadId: "thread-1",
      },
    },
  );

  assert.match(text, /тема: Test topic 1/u);
  assert.match(text, /run: running/u);
  assert.match(text, /папка: \/workspace/u);
  assert.match(text, /модель: gpt-5\.4/u);
  assert.match(text, /reasoning: Extra High \(xhigh\)/u);
  assert.match(text, /context window: 320000/u);
  assert.match(text, /язык: RUS/u);
  assert.match(text, /использование контекста: 71\.4%/u);
  assert.match(text, /токены контекста: 228400 \/ 320000/u);
  assert.match(text, /доступно токенов: 91600/u);
  assert.match(text, /вход\/кэш\/выход: 227200 \/ 180000 \/ 1200/u);
  assert.match(text, /reasoning tokens: 800/u);
});

test("buildStatusMessage hides Omni lines when Omni is globally disabled", () => {
  const text = buildStatusMessage(
    {
      omniEnabled: false,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "xhigh",
      codexContextWindow: 320000,
      codexAutoCompactTokenLimit: 300000,
    },
    {
      chat: { id: -1001234567890 },
      message_thread_id: 7,
    },
    {
      session_key: "-1001234567890:7",
      topic_name: "Test topic 1",
      lifecycle_state: "active",
      last_run_status: "idle",
      workspace_binding: {
        repo_root: "/workspace",
        cwd: "/workspace",
        branch: "main",
        worktree_path: "/workspace",
      },
    },
    null,
  );

  assert.doesNotMatch(text, /omni model/u);
  assert.doesNotMatch(text, /omni reasoning/u);
});

test("buildStatusMessage prefers rollout context snapshot over static config", () => {
  const text = buildStatusMessage(
    {
      codexModel: "gpt-5.4",
      codexReasoningEffort: "xhigh",
      codexContextWindow: 320000,
      codexAutoCompactTokenLimit: 300000,
    },
    {
      chat: { id: -1001234567890 },
      message_thread_id: 7,
    },
    {
      session_key: "-1001234567890:7",
      topic_name: "Test topic 2",
      lifecycle_state: "active",
      codex_thread_id: "thread-2",
      last_run_status: "completed",
      last_token_usage: null,
      workspace_binding: {
        repo_root: "/workspace",
        cwd: "/workspace",
        branch: "main",
        worktree_path: "/workspace",
      },
    },
    null,
    {
      captured_at: "2026-03-23T23:14:19.000Z",
      model_context_window: 275500,
      last_token_usage: {
        input_tokens: 18220,
        cached_input_tokens: 5504,
        output_tokens: 42,
        reasoning_tokens: 30,
        total_tokens: 18262,
      },
      rollout_path:
        "/home/bloob/.codex/sessions/2026/03/23/rollout-2026-03-23T23-14-18-thread-2.jsonl",
    },
  );

  assert.match(text, /context window: 275500/u);
  assert.match(text, /язык: RUS/u);
  assert.match(text, /omni model: gpt-5\.4/u);
  assert.match(text, /использование контекста: 6\.6%/u);
  assert.match(text, /токены контекста: 18262 \/ 275500/u);
  assert.match(text, /доступно токенов: 257238/u);
  assert.match(text, /вход\/кэш\/выход: 18220 \/ 5504 \/ 42/u);
  assert.match(text, /reasoning tokens: 30/u);
});

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
      from: { id: 123456789, is_bot: false },
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
      from: { id: 123456789, is_bot: false },
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

test("handleIncomingMessage opens the persistent global control panel in General", async () => {
  const sent = [];
  const store = createGlobalControlPanelStore();
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
        return { message_id: 901 };
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: store,
    message: {
      text: "/global",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    promptFragmentAssembler: new PromptFragmentAssembler(),
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
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
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

  assert.equal(result.command, "global");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Global control panel/u);
  assert.doesNotMatch(sent[0].text, /Закрепи это сообщение/u);
  assert.match(sent[0].text, /interface language: RUS/u);
  assert.equal(Array.isArray(sent[0].reply_markup.inline_keyboard), true);
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Язык" || button.text === "Help"),
    ),
    true,
  );
  assert.equal(store.getState().menu_message_id, 901);
});

test("handleIncomingMessage keeps /menu General guidance in the selected General language", async () => {
  const sent = [];
  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 902 };
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      ui_language: "eng",
    }),
    topicControlPanelStore: createTopicControlPanelStore(),
    message: {
      text: "/menu",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 123456789, is_bot: false },
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

  assert.equal(result.command, "menu");
  assert.match(sent[0].text, /Use \/menu inside a topic\./u);
});

test("handleIncomingCallbackQuery applies a global wait preset from the control panel", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const callOrder = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "wait",
  });
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        callOrder.push("ack");
        answered.push(payload);
      },
      async editMessageText(payload) {
        callOrder.push("edit");
        edited.push(payload);
      },
      async sendMessage(payload) {
        callOrder.push("send");
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-1",
      data: "gcfg:w:60",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1001234567890 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler,
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
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
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

  const waitState = promptFragmentAssembler.getStateForMessage({
    chat: { id: -1001234567890 },
    from: { id: 123456789 },
  });

  assert.equal(result.reason, "global-control-action-applied");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(waitState.global.active, true);
  assert.equal(waitState.global.flushDelayMs, 60000);
  assert.equal(callOrder[0], "ack");
  assert.equal(callOrder.includes("send"), false);
  assert.equal(callOrder.indexOf("ack") < callOrder.indexOf("edit"), true);
});

test("handleIncomingCallbackQuery applies a local wait preset from the topic control panel", async () => {
  const edited = [];
  const answered = [];
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "wait",
  });
  const session = {
    session_key: "-1001234567890:55",
    chat_id: "-1001234567890",
    topic_id: "55",
    topic_name: "Slice 4 test",
    ui_language: "rus",
    prompt_suffix_topic_enabled: true,
    prompt_suffix_text: null,
    prompt_suffix_enabled: false,
    spike_model_override: null,
    spike_reasoning_effort_override: null,
    omni_model_override: null,
    omni_reasoning_effort_override: null,
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  };

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-topic-1",
      data: "tcfg:w:300",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1001234567890 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler,
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
      async getGlobalCodexSettings() {
        return {
          spike_model: null,
          spike_reasoning_effort: null,
          omni_model: null,
          omni_reasoning_effort: null,
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
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

  const waitState = promptFragmentAssembler.getStateForMessage({
    chat: { id: -1001234567890 },
    from: { id: 123456789 },
    message_thread_id: 55,
  });

  assert.equal(result.reason, "topic-control-action-applied");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(waitState.local.active, true);
  assert.equal(waitState.local.flushDelayMs, 300000);
});

test("handleIncomingCallbackQuery updates the global panel language and refreshes the menu", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "language",
    ui_language: "rus",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-language",
      data: "gcfg:l:eng",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1001234567890 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async getGlobalCodexSettings() {
        return {
          spike_model: null,
          spike_reasoning_effort: null,
          omni_model: null,
          omni_reasoning_effort: null,
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
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

  assert.equal(result.reason, "global-control-language-updated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(store.getState().ui_language, "eng");
  assert.equal(store.getState().active_screen, "root");
  assert.match(edited[0].text, /Global control panel/u);
  assert.match(edited[0].text, /interface language: ENG/u);
  assert.match(sent[0].text, /Interface language updated\./u);
});

test("handleIncomingCallbackQuery shows the full global suffix text on the suffix screen", async () => {
  const edited = [];
  const longSuffix = [
    "НЕ переусложняй: нужен практичный и эффективный результат.",
    "Можешь использовать ЛЮБЫЕ доступные MCP/инструменты.",
    "Держи фокус на efficiency, modularity, security, agentness, convenience.",
  ].join("\n");

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery() {},
      async editMessageText(payload) {
        edited.push(payload);
      },
      async sendMessage() {
        throw new Error("suffix screen navigation should edit the menu in place");
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-suffix-full",
      data: "gcfg:n:s",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1001234567890 },
      },
    },
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      menu_message_id: 901,
      active_screen: "root",
      ui_language: "rus",
    }),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async getGlobalCodexSettings() {
        return {
          spike_model: null,
          spike_reasoning_effort: null,
          omni_model: null,
          omni_reasoning_effort: null,
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: true,
          prompt_suffix_text: longSuffix,
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

  assert.equal(result.reason, "global-control-menu-navigated");
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /НЕ переусложняй/u);
  assert.match(edited[0].text, /agentness, convenience\./u);
  assert.doesNotMatch(edited[0].text, /\.\.\./u);
});

test("handleIncomingCallbackQuery sends help cards in the selected global panel language", async () => {
  const documents = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "root",
    ui_language: "eng",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async sendDocument(payload) {
        documents.push(payload);
      },
      async sendMessage() {},
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-help",
      data: "gcfg:h:show",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1001234567890 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
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

  assert.equal(result.reason, "global-control-help-sent");
  assert.equal(answered.length, 1);
  assert.equal(documents.length, 2);
  assert.equal(documents[0].document.fileName, "severus-help-summer-eng-1.png");
  assert.equal(documents[1].document.fileName, "severus-help-summer-eng-2.png");
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
      from: { id: 123456789, is_bot: false },
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
    from: { id: 123456789 },
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
      from: { id: 123456789, is_bot: false },
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

test("global control panel suffix text flow applies reply-based manual input", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
  });
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const globalSuffixState = {
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
  };
  const sessionService = {
    async getGlobalCodexSettings() {
      return {
        spike_model: null,
        spike_reasoning_effort: null,
        omni_model: null,
        omni_reasoning_effort: null,
      };
    },
    async getGlobalPromptSuffix() {
      return { ...globalSuffixState };
    },
    async updateGlobalPromptSuffix(patch) {
      globalSuffixState.prompt_suffix_text =
        patch.text ?? globalSuffixState.prompt_suffix_text;
      globalSuffixState.prompt_suffix_enabled =
        patch.enabled ?? globalSuffixState.prompt_suffix_enabled;
      return { ...globalSuffixState };
    },
    async clearGlobalPromptSuffix() {
      globalSuffixState.prompt_suffix_text = null;
      globalSuffixState.prompt_suffix_enabled = false;
      return { ...globalSuffixState };
    },
  };

  const callbackResult = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-2",
      data: "gcfg:s:input",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1001234567890 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(callbackResult.reason, "global-control-pending-input-started");
  assert.equal(store.getState().pending_input.kind, "suffix_text");
  assert.match(sent[0].text, /Ответь на menu|Reply to the menu/u);

  const replyResult = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: store,
    message: {
      text: "P.S.\nKeep it short everywhere.",
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      reply_to_message: { message_id: 901 },
    },
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool: {
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(replyResult.reason, "global-control-pending-input-applied");
  assert.equal(store.getState().pending_input, null);
  assert.match(sent.at(-1).text, /Global prompt suffix updated/u);
  assert.equal(edited.length >= 2, true);
});

test("global control panel keeps pending reply target aligned when the menu message is recreated", async () => {
  const sent = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
  });

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText() {
        throw new Error("Telegram API editMessageText failed: message to edit not found");
      },
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 902 };
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-3",
      data: "gcfg:s:input",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1001234567890 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async getGlobalCodexSettings() {
        return {
          spike_model: null,
          spike_reasoning_effort: null,
          omni_model: null,
          omni_reasoning_effort: null,
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
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

  assert.equal(result.reason, "global-control-pending-input-started");
  assert.equal(answered.length, 1);
  assert.equal(sent.length, 2);
  assert.equal(store.getState().menu_message_id, 902);
  assert.equal(store.getState().pending_input.menu_message_id, 902);
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
      from: { id: 123456789, is_bot: false },
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
      from: { id: 123456789, is_bot: false },
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
      from: { id: 123456789, is_bot: false },
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
      from: { id: 123456789, is_bot: false },
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
      from: { id: 123456789, is_bot: false },
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
});

test("handleIncomingMessage sends the help card from General topic", async () => {
  const documents = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendDocument(payload) {
        documents.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 123456789, is_bot: false },
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

  assert.equal(result.command, "help");
  assert.equal(documents.length, 2);
  assert.equal(documents[0].document.fileName, "severus-help-summer-rus-1.png");
  assert.equal(documents[1].document.fileName, "severus-help-summer-rus-2.png");
  assert.equal(documents[0].caption, undefined);
  assert.equal(documents[1].caption, undefined);
});

test("handleIncomingMessage sends the guidebook PDF from General topic", async () => {
  const documents = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendDocument(payload) {
        documents.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/guide",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
      from: { id: 123456789, is_bot: false },
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

  assert.equal(result.command, "guide");
  assert.equal(documents.length, 1);
  assert.equal(documents[0].document.fileName, "codex-telegram-guidebook-rus.pdf");
  assert.match(documents[0].document.filePath, /codex-telegram-guidebook-rus\.pdf$/u);
  const stats = await fs.stat(documents[0].document.filePath);
  assert.ok(stats.size > 10_000);
});

test("handleIncomingMessage keeps /guide General-only", async () => {
  const sent = [];
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
    topic_name: "Guide topic",
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
      text: "/guide",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return session;
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

  assert.equal(result.command, "guide");
  assert.equal(result.reason, "guide-general-only");
  assert.match(sent[0].text, /работает только в General/u);
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
      from: { id: 123456789, is_bot: false },
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

test("handleIncomingMessage sends the English help card inside an ENG topic", async () => {
  const documents = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendDocument(payload) {
        documents.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 88,
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return {
          session_key: "-1001234567890:88",
          chat_id: "-1001234567890",
          topic_id: "88",
          topic_name: "ENG topic",
          lifecycle_state: "active",
          ui_language: "eng",
          workspace_binding: {
            repo_root: "/workspace",
            cwd: "/workspace",
            branch: "main",
            worktree_path: "/workspace",
          },
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

  assert.equal(result.command, "help");
  assert.equal(documents.length, 2);
  assert.equal(documents[0].document.fileName, "severus-help-summer-eng-1.png");
  assert.equal(documents[1].document.fileName, "severus-help-summer-eng-2.png");
  assert.equal(documents[0].caption, undefined);
  assert.equal(documents[1].caption, undefined);
});

test("handleIncomingMessage shows suffix help from General topic", async () => {
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
      text: "/suffix help",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 123456789, is_bot: false },
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

  assert.equal(result.command, "suffix");
  assert.match(sent[0].text, /Prompt suffix help/u);
  assert.match(sent[0].text, /\/suffix global <text>/u);
  assert.match(sent[0].text, /\/suffix topic off/u);
});

test("handleIncomingMessage keeps suffix help in ENG when General panel language is ENG", async () => {
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
      text: "/suffix help",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 123456789, is_bot: false },
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

  assert.equal(result.command, "suffix");
  assert.match(sent[0].text, /Suffix help/u);
  assert.doesNotMatch(sent[0].text, /Использование/u);
});

test("handleIncomingMessage creates new topic session and sends bootstrap", async () => {
  const sent = [];
  const touched = [];
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
      text: "/new Slice 4 test",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState,
    sessionService: {
      async resolveInheritedBinding() {
        return {
          binding: {
            repo_root: "/workspace",
            cwd: "/workspace",
            branch: "main",
            worktree_path: "/workspace",
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
          session: {
            session_key: "-1001234567890:55",
            chat_id: "-1001234567890",
            topic_id: "55",
            workspace_binding: {
              repo_root: "/workspace",
              cwd: "/workspace",
              branch: "main",
              worktree_path: "/workspace",
            },
          },
        };
      },
      async recordHandledSession(_, session, commandName) {
        touched.push({ session, commandName });
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

test("handleIncomingMessage creates and pins a local control menu for a new topic", async () => {
  const sent = [];
  const pinned = [];
  const topicControlPanelStore = createTopicControlPanelStore();

  const session = {
    session_key: "-1001234567890:58",
    chat_id: "-1001234567890",
    topic_id: "58",
    ui_language: "rus",
    prompt_suffix_topic_enabled: true,
    prompt_suffix_text: null,
    prompt_suffix_enabled: false,
    spike_model_override: null,
    spike_reasoning_effort_override: null,
    omni_model_override: null,
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
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
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
          omni_model: null,
          omni_reasoning_effort: null,
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
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
      text: "/new cwd=projects/codex-telegram-gateway Bound repo",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState,
    sessionService: {
      async resolveBindingPath(requestedPath) {
        assert.equal(
          requestedPath,
          "projects/codex-telegram-gateway",
        );
        return {
          repo_root: "/workspace/projects/codex-telegram-gateway",
          cwd: "/workspace/projects/codex-telegram-gateway",
          branch: "main",
          worktree_path: "/workspace/projects/codex-telegram-gateway",
        };
      },
      async createTopicSession({ title, workspaceBinding, inheritedFromSessionKey }) {
        assert.equal(title, "Bound repo");
        assert.equal(inheritedFromSessionKey, null);
        assert.equal(
          workspaceBinding.cwd,
          "/workspace/projects/codex-telegram-gateway",
        );
        return {
          forumTopic: {
            name: "Bound repo",
            message_thread_id: 56,
          },
          session: {
            session_key: "-1001234567890:56",
            chat_id: "-1001234567890",
            topic_id: "56",
            workspace_binding: workspaceBinding,
          },
        };
      },
      async recordHandledSession(_, session, commandName) {
        touched.push({ session, commandName });
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
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async resolveInheritedBinding() {
        return {
          binding: {
            repo_root: "/workspace",
            cwd: "/workspace",
            branch: "main",
            worktree_path: "/workspace",
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
          session: {
            session_key: "-1001234567890:57",
            chat_id: "-1001234567890",
            topic_id: "57",
            ui_language: "eng",
            workspace_binding: {
              repo_root: "/workspace",
              cwd: "/workspace",
              branch: "main",
              worktree_path: "/workspace",
            },
          },
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

test("handleIncomingMessage opens and pins the local topic control menu with /menu", async () => {
  const sent = [];
  const pinned = [];
  const topicControlPanelStore = createTopicControlPanelStore();
  const session = {
    session_key: "-1001234567890:55",
    chat_id: "-1001234567890",
    topic_id: "55",
    topic_name: "Slice 4 test",
    ui_language: "rus",
    prompt_suffix_topic_enabled: true,
    prompt_suffix_text: null,
    prompt_suffix_enabled: false,
    spike_model_override: null,
    spike_reasoning_effort_override: null,
    omni_model_override: null,
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
        return { message_id: 777 };
      },
      async pinChatMessage(payload) {
        pinned.push(payload);
        return true;
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/menu",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 55,
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
      async getGlobalCodexSettings() {
        return {
          spike_model: null,
          spike_reasoning_effort: null,
          omni_model: null,
          omni_reasoning_effort: null,
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
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

  assert.equal(result.command, "menu");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_thread_id, 55);
  assert.match(sent[0].text, /Topic control panel/u);
  assert.match(sent[0].text, /global suffix routing: on/u);
  assert.equal(pinned.length, 1);
  assert.equal(topicControlPanelStore.getState(session).menu_message_id, 777);
});

test("handleIncomingMessage reports binding resolution failures for /new", async () => {
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
      text: "/new cwd=/missing/path Bound repo",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState,
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
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
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

test("handleIncomingMessage starts codex run for plain text in a topic", async () => {
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("should not send reply on successful prompt start");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "run a quick task",
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    serviceState,
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
    },
    workerPool: {
      async startPromptRun({ prompt, session }) {
        assert.equal(prompt, "run a quick task");
        assert.equal(session.session_key, "-1001234567890:77");
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage silently blocks direct human prompts to Spike in auto topics", async () => {
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("should not reply when Omni owns the topic");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "continue from here",
      from: { id: 123456789, is_bot: false },
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
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          auto_mode: {
            enabled: true,
            phase: "running",
            omni_bot_id: "222333444",
          },
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
    },
    workerPool: {
      async startPromptRun() {
        throw new Error("human prompt should never reach Spike run start");
      },
    },
  });

  assert.equal(result.reason, "auto-topic-human-input-blocked");
});

test("handleIncomingMessage accepts direct human prompts again when auto mode is off", async () => {
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("should not reply on successful prompt start");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "continue without omni",
      from: { id: 123456789, is_bot: false },
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
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          auto_mode: {
            enabled: false,
            phase: "off",
            omni_bot_id: "222333444",
          },
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
    },
    workerPool: {
      async startPromptRun({ prompt, session }) {
        assert.equal(prompt, "continue without omni");
        assert.equal(session.session_key, "-1001234567890:77");
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage ignores Omni-owned /auto commands in Spike bot", async () => {
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("Spike should stay silent for Omni-owned commands");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/auto",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {},
    workerPool: {},
  });

  assert.equal(result.reason, "omni-owned-command");
});

test("handleIncomingMessage returns a clear unavailable message for /auto when Omni is disabled", async () => {
  const sent = [];
  const result = await handleIncomingMessage({
    api: {
      async sendMessage(params) {
        sent.push(params);
      },
    },
    botUsername: "gatewaybot",
    config: {
      ...config,
      omniEnabled: false,
    },
    message: {
      text: "/auto",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    lifecycleManager: null,
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          topic_id: "77",
          chat_id: "-1001234567890",
          ui_language: "rus",
        };
      },
      async recordHandledSession(_state, session) {
        return session;
      },
    },
    workerPool: {},
  });

  assert.equal(result.reason, "omni-disabled");
  assert.match(sent[0].text, /Omni сейчас отключён/u);
});

test("handleIncomingMessage ignores foreign bot commands instead of starting a Spike run", async () => {
  let canceled = 0;
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("Spike should stay silent for a foreign bot command");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/auto@omnibot",
      entities: [{ type: "bot_command", offset: 0, length: 13 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    promptFragmentAssembler: {
      getStateForMessage() {
        return { active: false };
      },
      hasPendingForSameTopicMessage() {
        return true;
      },
      cancelPendingForMessage() {
        canceled += 1;
      },
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {},
    workerPool: {
      async startPromptRun() {
        throw new Error("foreign bot command must not start a Spike run");
      },
    },
  });

  assert.equal(result.reason, "foreign-bot-command");
  assert.equal(canceled, 0);
});

test("handleIncomingMessage ignores /omni because it belongs to Omni", async () => {
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("Spike should stay silent for Omni-owned commands");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/omni what changed?",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {},
    workerPool: {},
  });

  assert.equal(result.reason, "omni-owned-command");
});

test("handleIncomingMessage blocks destructive human Spike commands in auto topics", async () => {
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("blocked auto-topic command should stay silent");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/purge",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
      from: { id: 123456789, is_bot: false },
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
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          auto_mode: {
            enabled: true,
            phase: "running",
            omni_bot_id: "222333444",
          },
        };
      },
      async purgeSession() {
        throw new Error("purge must not run while Omni owns the topic");
      },
    },
    workerPool: {},
  });

  assert.equal(result.reason, "auto-topic-human-command-blocked");
});

test("handleIncomingMessage rejects /q while /auto owns the topic", async () => {
  const sent = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 1 };
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/q подготовь следующий шаг",
      entities: [{ type: "bot_command", offset: 0, length: 2 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 778,
      message_thread_id: 77,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          chat_id: "-1001234567890",
          topic_id: "77",
          auto_mode: {
            enabled: true,
            phase: "running",
            omni_bot_id: "222333444",
          },
        };
      },
    },
    workerPool: {},
  });

  assert.equal(result.reason, "auto-topic-human-command-blocked");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Очередь Spike недоступна/u);
});

test("handleIncomingMessage ignores stale auto human-input locks when Omni is globally disabled", async () => {
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("plain prompt should go to Spike directly");
      },
    },
    botUsername: "gatewaybot",
    config: {
      ...config,
      omniEnabled: false,
    },
    message: {
      text: "continue without omni at all",
      from: { id: 123456789, is_bot: false },
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
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          auto_mode: {
            enabled: true,
            phase: "running",
            omni_bot_id: "222333444",
          },
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async getPendingPromptAttachments() {
        return [];
      },
    },
    workerPool: {
      async startPromptRun({ prompt }) {
        assert.equal(prompt, "continue without omni at all");
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage ignores Omni bot chatter before the goal is captured", async () => {
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("Spike should stay silent for Omni setup chatter");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "Auto setup started. Send the goal next.",
      from: { id: 222333444, is_bot: true },
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
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          auto_mode: {
            enabled: true,
            phase: "await_goal",
            omni_bot_id: "222333444",
          },
        };
      },
    },
    workerPool: {
      async startPromptRun() {
        throw new Error("Omni setup chatter must not start a Spike run");
      },
    },
  });

  assert.equal(result.reason, "bot-prompt-ignored");
});

test("handleIncomingMessage accepts Omni bot continuation prompts in active auto topics", async () => {
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("successful Omni prompt should not send a reply");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "Continuation task: finish the remaining validation work.",
      from: { id: 222333444, is_bot: true },
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
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          auto_mode: {
            enabled: true,
            phase: "running",
            omni_bot_id: "222333444",
          },
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
    },
    workerPool: {
      async startPromptRun({ prompt }) {
        assert.match(prompt, /Continuation task/u);
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage does not buffer internal Omni handoff prompts", async () => {
  const longPrompt = `Continuation task: ${"x".repeat(5000)}`;
  let started = 0;
  const promptFragmentAssembler = new PromptFragmentAssembler();
  promptFragmentAssembler.shouldBufferMessage = () => {
    throw new Error("internal Omni handoff must bypass prompt buffering");
  };
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("internal Omni handoff should not send a reply");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: longPrompt,
      is_internal_omni_handoff: true,
      from: { id: 222333444, is_bot: true },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    promptFragmentAssembler,
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          auto_mode: {
            enabled: true,
            phase: "running",
            omni_bot_id: "222333444",
          },
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
    },
    workerPool: {
      async startPromptRun({ prompt }) {
        started += 1;
        assert.equal(prompt, longPrompt);
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
  assert.equal(started, 1);
});

test("handleIncomingMessage appends configured prompt suffix before starting a run", async () => {
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("should not send reply on successful prompt start");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "run a quick task",
      from: { id: 123456789, is_bot: false },
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
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          prompt_suffix_enabled: true,
          prompt_suffix_text:
            "P.S.\nKeep it short and never overcomplicate anything.",
        };
      },
    },
    workerPool: {
      async startPromptRun({ prompt }) {
        assert.equal(
          prompt,
          "run a quick task\n\nP.S.\nKeep it short and never overcomplicate anything.",
        );
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage lets topic prompt suffix override global prompt suffix", async () => {
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("should not send reply on successful prompt start");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "run a quick task",
      from: { id: 123456789, is_bot: false },
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
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          prompt_suffix_enabled: true,
          prompt_suffix_text: "TOPIC\nKeep it short in this thread.",
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: true,
          prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
        };
      },
    },
    workerPool: {
      async startPromptRun({ prompt }) {
        assert.equal(
          prompt,
          "run a quick task\n\nTOPIC\nKeep it short in this thread.",
        );
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage suppresses both topic and global suffixes when topic routing is off", async () => {
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("should not send reply on successful prompt start");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "run a quick task",
      from: { id: 123456789, is_bot: false },
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
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          prompt_suffix_topic_enabled: false,
          prompt_suffix_enabled: true,
          prompt_suffix_text: "TOPIC\nKeep it short in this thread.",
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: true,
          prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
        };
      },
    },
    workerPool: {
      async startPromptRun({ prompt }) {
        assert.equal(prompt, "run a quick task");
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage starts codex run for captioned photo in a topic", async () => {
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("should not send reply on successful prompt start");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      caption: "Что на фото?",
      photo: [
        { file_id: "small-photo", file_unique_id: "small", file_size: 10 },
        { file_id: "large-photo", file_unique_id: "large", file_size: 20 },
      ],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 501,
      message_thread_id: 77,
    },
    serviceState,
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          chat_id: "-1001234567890",
          topic_id: "77",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments() {
        return [
          {
            kind: "photo",
            file_path: "/tmp/incoming-photo.jpg",
            is_image: true,
          },
        ];
      },
    },
    workerPool: {
      async startPromptRun({ prompt, session, attachments }) {
        assert.equal(prompt, "Что на фото?");
        assert.equal(session.session_key, "-1001234567890:77");
        assert.equal(attachments.length, 1);
        assert.equal(attachments[0].file_path, "/tmp/incoming-photo.jpg");
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage appends prompt suffix to captioned media prompts", async () => {
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("should not send reply on successful prompt start");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      caption: "Что на фото?",
      photo: [
        { file_id: "small-photo", file_unique_id: "small", file_size: 10 },
        { file_id: "large-photo", file_unique_id: "large", file_size: 20 },
      ],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 501,
      message_thread_id: 77,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          chat_id: "-1001234567890",
          topic_id: "77",
          prompt_suffix_enabled: true,
          prompt_suffix_text: "P.S.\nAnswer briefly.",
        };
      },
      async ingestIncomingAttachments() {
        return [
          {
            kind: "photo",
            file_path: "/tmp/incoming-photo.jpg",
            is_image: true,
          },
        ];
      },
    },
    workerPool: {
      async startPromptRun({ prompt, attachments }) {
        assert.equal(
          prompt,
          "Что на фото?\n\nP.S.\nAnswer briefly.",
        );
        assert.equal(attachments.length, 1);
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage auto-assembles Telegram media groups into one run", async () => {
  const startedRuns = [];
  const promptFragmentAssembler = new PromptFragmentAssembler({
    flushDelayMs: 20,
    flushGraceMs: 5,
    longPromptThresholdChars: 3000,
  });
  const session = {
    session_key: "-1001234567890:86",
    chat_id: "-1001234567890",
    topic_id: "86",
    lifecycle_state: "active",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  };
  const firstMessage = {
    caption: "Разбери оба файла вместе.",
    media_group_id: "docs-1",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 970,
    message_thread_id: 86,
    document: {
      file_id: "doc-1",
      file_unique_id: "doc-1",
      file_name: "a.md",
      mime_type: "text/markdown",
      file_size: 64,
    },
  };
  const secondMessage = {
    media_group_id: "docs-1",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 971,
    message_thread_id: 86,
    document: {
      file_id: "doc-2",
      file_unique_id: "doc-2",
      file_name: "b.md",
      mime_type: "text/markdown",
      file_size: 72,
    },
  };

  const commonArgs = {
    api: {
      async sendMessage() {},
    },
    botUsername: "gatewaybot",
    config,
    promptFragmentAssembler,
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return session;
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments(_api, _session, message) {
        if (message.message_id === firstMessage.message_id) {
          return [
            {
              kind: "document",
              file_path: "/tmp/a.md",
              is_image: false,
              mime_type: "text/markdown",
              size_bytes: 64,
            },
          ];
        }

        if (message.message_id === secondMessage.message_id) {
          return [
            {
              kind: "document",
              file_path: "/tmp/b.md",
              is_image: false,
              mime_type: "text/markdown",
              size_bytes: 72,
            },
          ];
        }

        return [];
      },
      async recordHandledSession() {},
    },
    workerPool: {
      async startPromptRun(args) {
        startedRuns.push(args);
        return { ok: true };
      },
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  };

  const firstResult = await handleIncomingMessage({
    ...commonArgs,
    message: firstMessage,
  });
  const secondResult = await handleIncomingMessage({
    ...commonArgs,
    message: secondMessage,
  });

  assert.equal(firstResult.reason, "prompt-buffered");
  assert.equal(secondResult.reason, "prompt-buffered");

  await sleep(50);

  assert.equal(startedRuns.length, 1);
  assert.equal(startedRuns[0].rawPrompt, firstMessage.caption);
  assert.equal(startedRuns[0].attachments.length, 2);
  assert.deepEqual(
    startedRuns[0].attachments.map((attachment) => attachment.file_path),
    ["/tmp/a.md", "/tmp/b.md"],
  );
});

test("handleIncomingMessage shows /q status with queued prompt previews", async () => {
  const sent = [];
  const session = {
    session_key: "-1001234567890:77",
    chat_id: "-1001234567890",
    topic_id: "77",
    lifecycle_state: "active",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
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
        return { message_id: 1 };
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/q status",
      entities: [{ type: "bot_command", offset: 0, length: 2 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 610,
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
      async listPromptQueue() {
        return [
          { raw_prompt: "первый queued prompt на проверку статуса" },
          { raw_prompt: "второй queued prompt после него" },
        ];
      },
      async recordHandledSession() {
        return session;
      },
    },
    workerPool: {},
  });

  assert.equal(result.reason, "queue-status");
  assert.match(sent[0].text, /Очередь Spike: 2/u);
  assert.match(sent[0].text, /1\./u);
  assert.match(sent[0].text, /2\./u);
});

test("handleIncomingMessage deletes a queued prompt by position via /q delete", async () => {
  const sent = [];
  const session = {
    session_key: "-1001234567890:77",
    chat_id: "-1001234567890",
    topic_id: "77",
    lifecycle_state: "active",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
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
        return { message_id: 1 };
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/q delete 2",
      entities: [{ type: "bot_command", offset: 0, length: 2 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 611,
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
      async deletePromptQueueEntry(_session, position) {
        assert.equal(position, 2);
        return {
          entry: { raw_prompt: "второй prompt на удаление из очереди" },
          size: 1,
        };
      },
      async recordHandledSession() {
        return session;
      },
    },
    workerPool: {},
  });

  assert.equal(result.reason, "queue-deleted");
  assert.match(sent[0].text, /Удалил элемент очереди #2/u);
  assert.match(sent[0].text, /Осталось: 1/u);
});

test("handleIncomingMessage queues /q captioned media with attachments when the topic is busy", async () => {
  const sent = [];
  const queued = [];
  const session = {
    session_key: "-1001234567890:77",
    chat_id: "-1001234567890",
    topic_id: "77",
    lifecycle_state: "active",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
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
        return { message_id: 1 };
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      caption: "/q Что на фото?",
      caption_entities: [{ type: "bot_command", offset: 0, length: 2 }],
      photo: [
        { file_id: "small-photo", file_unique_id: "small", file_size: 10 },
        { file_id: "large-photo", file_unique_id: "large", file_size: 20 },
      ],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 612,
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
      async ensureRunnableSessionForMessage() {
        return session;
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async getPendingPromptAttachments() {
        return [];
      },
      async ingestIncomingAttachments() {
        return [
          {
            kind: "photo",
            file_path: "/tmp/incoming-photo.jpg",
            is_image: true,
          },
        ];
      },
      async enqueuePromptQueue(_session, payload) {
        queued.push(payload);
        return {
          position: 1,
          size: 1,
        };
      },
      async drainPromptQueue() {
        return [
          {
            sessionKey: session.session_key,
            result: { reason: "busy" },
          },
        ];
      },
      async clearPendingPromptAttachments() {
        return session;
      },
      async recordHandledSession() {
        return session;
      },
    },
    workerPool: {
      getActiveRun() {
        return { sessionKey: session.session_key };
      },
    },
  });

  assert.equal(result.reason, "prompt-queued");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].rawPrompt, "Что на фото?");
  assert.equal(queued[0].attachments.length, 1);
  assert.equal(queued[0].attachments[0].file_path, "/tmp/incoming-photo.jpg");
  assert.match(sent[0].text, /Поставил в очередь/u);
});

test("handleIncomingMessage buffers long /q prompts and queues the merged text once", async () => {
  const sent = [];
  const queued = [];
  const queuePromptAssembler = new PromptFragmentAssembler({
    flushDelayMs: 20,
    flushGraceMs: 5,
    longPromptThresholdChars: 3000,
  });
  const session = {
    session_key: "-1001234567890:77",
    chat_id: "-1001234567890",
    topic_id: "77",
    lifecycle_state: "active",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  };
  const longHead = "A".repeat(3200);

  const commonArgs = {
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: sent.length };
      },
    },
    botUsername: "gatewaybot",
    config,
    queuePromptAssembler,
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
      async ensureRunnableSessionForMessage() {
        return session;
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async getPendingPromptAttachments() {
        return [];
      },
      async ingestIncomingAttachments() {
        return [];
      },
      async enqueuePromptQueue(_session, payload) {
        queued.push(payload);
        return {
          position: 1,
          size: 1,
        };
      },
      async drainPromptQueue() {
        return [
          {
            sessionKey: session.session_key,
            result: { reason: "busy" },
          },
        ];
      },
      async recordHandledSession() {
        return session;
      },
    },
    workerPool: {
      async startPromptRun() {
        return { ok: false, reason: "busy" };
      },
      getActiveRun() {
        return { sessionKey: session.session_key };
      },
    },
  };

  const firstResult = await handleIncomingMessage({
    ...commonArgs,
    message: {
      text: `/q ${longHead}`,
      entities: [{ type: "bot_command", offset: 0, length: 2 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 613,
      message_thread_id: 77,
    },
  });
  const secondResult = await handleIncomingMessage({
    ...commonArgs,
    message: {
      text: "tail fragment",
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 614,
      message_thread_id: 77,
    },
  });

  assert.equal(firstResult.reason, "queue-buffered");
  assert.equal(secondResult.reason, "queue-buffered");

  await sleep(50);

  assert.equal(queued.length, 1);
  assert.match(queued[0].rawPrompt, new RegExp(`^${longHead}`));
  assert.match(queued[0].rawPrompt, /tail fragment/u);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Поставил в очередь/u);
});

test("handleIncomingMessage stores prompt suffix text via /suffix", async () => {
  const sent = [];
  const session = {
    session_key: "-1001234567890:77",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
    lifecycle_state: "active",
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
      text: "/suffix P.S.\nKeep it short.",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 123456789, is_bot: false },
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
      async updatePromptSuffix(currentSession, patch) {
        assert.equal(currentSession.session_key, session.session_key);
        assert.deepEqual(patch, {
          text: "P.S.\nKeep it short.",
          enabled: true,
        });
        return {
          ...session,
          prompt_suffix_enabled: true,
          prompt_suffix_text: "P.S.\nKeep it short.",
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

  assert.equal(result.command, "suffix");
  assert.match(sent[0].text, /Prompt suffix updated\./u);
  assert.match(sent[0].text, /scope: topic/u);
  assert.match(sent[0].text, /status: on/u);
  assert.match(sent[0].text, /P\.S\./u);
});

test("handleIncomingMessage stores global prompt suffix text via /suffix global", async () => {
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
      text: "/suffix global P.S.\nKeep it short everywhere.",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async updateGlobalPromptSuffix(patch) {
        assert.deepEqual(patch, {
          text: "P.S.\nKeep it short everywhere.",
          enabled: true,
        });
        return {
          prompt_suffix_enabled: true,
          prompt_suffix_text: "P.S.\nKeep it short everywhere.",
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

  assert.equal(result.command, "suffix");
  assert.match(sent[0].text, /Global prompt suffix updated\./u);
  assert.match(sent[0].text, /scope: global/u);
  assert.match(sent[0].text, /status: on/u);
  assert.match(sent[0].text, /P\.S\./u);
});

test("handleIncomingMessage disables topic prompt suffix routing via /suffix topic off", async () => {
  const sent = [];
  const session = {
    session_key: "-1001234567890:77",
    prompt_suffix_topic_enabled: true,
    prompt_suffix_enabled: true,
    prompt_suffix_text: "TOPIC\nKeep it short.",
    lifecycle_state: "active",
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
      text: "/suffix topic off",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 123456789, is_bot: false },
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
      async updatePromptSuffixTopicState(currentSession, patch) {
        assert.equal(currentSession.session_key, session.session_key);
        assert.deepEqual(patch, {
          enabled: false,
        });
        return {
          ...session,
          prompt_suffix_topic_enabled: false,
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

  assert.equal(result.command, "suffix");
  assert.match(sent[0].text, /Topic prompt suffix routing disabled\./u);
  assert.match(sent[0].text, /scope: topic-routing/u);
  assert.match(sent[0].text, /status: off/u);
});

test("handleIncomingMessage asks for caption when media arrives without text", async () => {
  const sent = [];
  let bufferedSession = null;

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      photo: [{ file_id: "photo-1", file_unique_id: "photo-1", file_size: 10 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 78,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return {
          session_key: "-1001234567890:78",
          chat_id: "-1001234567890",
          topic_id: "78",
          lifecycle_state: "active",
          ui_language: "rus",
        };
      },
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:78",
          chat_id: "-1001234567890",
          topic_id: "78",
          lifecycle_state: "active",
          ui_language: "rus",
          auto_mode: {
            enabled: false,
            phase: "off",
          },
        };
      },
      async ingestIncomingAttachments() {
        return [
          {
            file_path: "/tmp/incoming-photo.jpg",
            relative_path: "incoming/incoming-photo.jpg",
            mime_type: "image/jpeg",
            size_bytes: 10,
            is_image: true,
          },
        ];
      },
      async bufferPendingPromptAttachments(session, attachments) {
        bufferedSession = { session, attachments };
      },
    },
    workerPool: {
      async startPromptRun() {
        throw new Error("should not start");
      },
    },
  });

  assert.equal(result.reason, "attachment-without-caption");
  assert.equal(bufferedSession.attachments.length, 1);
  assert.match(sent[0].text, /Добавь подпись/u);
  assert.match(sent[0].text, /следующим сообщением/u);
});

test("handleIncomingMessage carries attachment-only message into the next text prompt in the same topic", async () => {
  const sent = [];
  const startedRuns = [];
  const pendingByTopic = new Map();
  const session = {
    session_key: "-1001234567890:88",
    chat_id: "-1001234567890",
    topic_id: "88",
    lifecycle_state: "active",
    ui_language: "rus",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  };
  const attachmentMessage = {
    document: {
      file_id: "file-1",
      file_unique_id: "uniq-file-1",
      file_name: "ai_studio_code.txt",
      mime_type: "text/plain",
      file_size: 12345,
    },
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 2001,
    message_thread_id: 88,
  };
  const textMessage = {
    text: "Переделай это в нормальный формат и влепи в ридмишку.",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 2002,
    message_thread_id: 88,
  };

  const commonArgs = {
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return { ...session };
      },
      async ensureRunnableSessionForMessage() {
        return { ...session };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments(_api, _session, message) {
        if (message.message_id !== attachmentMessage.message_id) {
          return [];
        }

        return [
          {
            file_path: "/tmp/ai_studio_code.txt",
            relative_path: "incoming/ai_studio_code.txt",
            mime_type: "text/plain",
            size_bytes: 12345,
            is_image: false,
          },
        ];
      },
      async bufferPendingPromptAttachments(currentSession, attachments) {
        pendingByTopic.set(currentSession.topic_id, attachments);
        return {
          ...currentSession,
          pending_prompt_attachments: attachments,
          pending_prompt_attachments_expires_at: "2026-03-31T16:00:00.000Z",
        };
      },
      async getPendingPromptAttachments(currentSession) {
        return pendingByTopic.get(currentSession.topic_id) || [];
      },
      async clearPendingPromptAttachments(currentSession) {
        pendingByTopic.delete(currentSession.topic_id);
        return {
          ...currentSession,
          pending_prompt_attachments: [],
          pending_prompt_attachments_expires_at: null,
        };
      },
      async recordHandledSession() {},
    },
    workerPool: {
      async startPromptRun(args) {
        startedRuns.push(args);
        return { ok: true };
      },
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  };

  const attachmentResult = await handleIncomingMessage({
    ...commonArgs,
    message: attachmentMessage,
  });
  const textResult = await handleIncomingMessage({
    ...commonArgs,
    message: textMessage,
  });

  assert.equal(attachmentResult.reason, "attachment-without-caption");
  assert.equal(textResult.reason, "prompt-started");
  assert.equal(startedRuns.length, 1);
  assert.equal(startedRuns[0].rawPrompt, textMessage.text);
  assert.equal(startedRuns[0].attachments.length, 1);
  assert.equal(startedRuns[0].attachments[0].file_path, "/tmp/ai_studio_code.txt");
  assert.equal(pendingByTopic.has("88"), false);
  assert.match(sent[0].text, /Вложение получил/u);
});

test("handleIncomingMessage keeps /q attachment buffering separate from direct Spike prompts", async () => {
  const sent = [];
  const startedRuns = [];
  const directPendingByTopic = new Map();
  const queuedPendingByTopic = new Map();
  const session = {
    session_key: "-1001234567890:89",
    chat_id: "-1001234567890",
    topic_id: "89",
    lifecycle_state: "active",
    ui_language: "rus",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
    auto_mode: {
      enabled: false,
      phase: "off",
    },
  };
  const queuedAttachmentMessage = {
    caption: "/q",
    caption_entities: [{ type: "bot_command", offset: 0, length: 2 }],
    document: {
      file_id: "queue-file-1",
      file_unique_id: "queue-uniq-file-1",
      file_name: "queue.txt",
      mime_type: "text/plain",
      file_size: 100,
    },
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 2101,
    message_thread_id: 89,
  };
  const textMessage = {
    text: "Сделай обычный Spike prompt без очереди.",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 2102,
    message_thread_id: 89,
  };

  const commonArgs = {
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return { ...session };
      },
      async ensureRunnableSessionForMessage() {
        return { ...session };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments(_api, _session, message) {
        if (message.message_id !== queuedAttachmentMessage.message_id) {
          return [];
        }

        return [
          {
            file_path: "/tmp/queue.txt",
            relative_path: "incoming/queue.txt",
            mime_type: "text/plain",
            size_bytes: 100,
            is_image: false,
          },
        ];
      },
      async bufferPendingPromptAttachments(currentSession, attachments, options = {}) {
        const store = options.scope === "queue"
          ? queuedPendingByTopic
          : directPendingByTopic;
        store.set(currentSession.topic_id, attachments);
      },
      async getPendingPromptAttachments(currentSession, options = {}) {
        const store = options.scope === "queue"
          ? queuedPendingByTopic
          : directPendingByTopic;
        return [...(store.get(currentSession.topic_id) || [])];
      },
      async clearPendingPromptAttachments(currentSession, options = {}) {
        const store = options.scope === "queue"
          ? queuedPendingByTopic
          : directPendingByTopic;
        store.delete(currentSession.topic_id);
        return currentSession;
      },
      async recordHandledSession() {},
      async listPromptQueue() {
        return [];
      },
      async enqueuePromptQueue() {
        throw new Error("should not enqueue");
      },
    },
    workerPool: {
      async startPromptRun(args) {
        startedRuns.push(args);
        return { ok: true };
      },
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  };

  const queuedAttachmentResult = await handleIncomingMessage({
    ...commonArgs,
    message: queuedAttachmentMessage,
  });
  const textResult = await handleIncomingMessage({
    ...commonArgs,
    message: textMessage,
  });

  assert.equal(queuedAttachmentResult.reason, "queue-attachment-without-prompt");
  assert.equal(textResult.reason, "prompt-started");
  assert.equal(startedRuns.length, 1);
  assert.equal(startedRuns[0].attachments.length, 0);
  assert.equal(queuedPendingByTopic.get(session.topic_id)?.length, 1);
  assert.equal(directPendingByTopic.has(session.topic_id), false);
  assert.match(sent[0].text, /через \/q/u);
});

test("handleIncomingMessage assembles likely split long Telegram prompts into one run", async () => {
  const startedRuns = [];
  const promptFragmentAssembler = new PromptFragmentAssembler({
    flushDelayMs: 10000,
    longPromptThresholdChars: 3000,
  });
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const firstMessage = {
    text: "A".repeat(3200),
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 880,
    message_thread_id: 78,
  };
  const secondMessage = {
    text: " second-fragment",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 881,
    message_thread_id: 78,
  };

  const commonArgs = {
    api: {
      async sendMessage() {
        throw new Error("should not send reply while buffering a split prompt");
      },
    },
    botUsername: "gatewaybot",
    config,
    promptFragmentAssembler,
    serviceState,
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:78",
          chat_id: "-1001234567890",
          topic_id: "78",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments() {
        return [];
      },
    },
    workerPool: {
      async startPromptRun(args) {
        startedRuns.push(args);
        return { ok: true };
      },
    },
  };

  const firstResult = await handleIncomingMessage({
    ...commonArgs,
    message: firstMessage,
  });
  const secondResult = await handleIncomingMessage({
    ...commonArgs,
    message: secondMessage,
  });

  assert.equal(firstResult.reason, "prompt-buffered");
  assert.equal(secondResult.reason, "prompt-buffered");
  assert.equal(startedRuns.length, 0);

  await promptFragmentAssembler.flushPendingForMessage(secondMessage);

  assert.equal(startedRuns.length, 1);
  assert.equal(
    startedRuns[0].rawPrompt,
    `${firstMessage.text}\n\n${secondMessage.text.trim()}`,
  );
  assert.equal(startedRuns[0].prompt, `${firstMessage.text}\n\n${secondMessage.text.trim()}`);
  assert.equal(startedRuns[0].message.message_id, secondMessage.message_id);
});

test("handleIncomingMessage assembles four Telegram-split prompt fragments into one run", async () => {
  const startedRuns = [];
  const promptFragmentAssembler = new PromptFragmentAssembler({
    flushDelayMs: 10000,
    longPromptThresholdChars: 3000,
  });
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const messages = [
    {
      text: "A".repeat(3200),
      message_id: 890,
    },
    {
      text: " B",
      message_id: 891,
    },
    {
      text: " C",
      message_id: 892,
    },
    {
      text: " D",
      message_id: 893,
    },
  ].map((message) => ({
    ...message,
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_thread_id: 79,
  }));

  const commonArgs = {
    api: {
      async sendMessage() {
        throw new Error("should not send reply while buffering split prompt fragments");
      },
    },
    botUsername: "gatewaybot",
    config,
    promptFragmentAssembler,
    serviceState,
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:79",
          chat_id: "-1001234567890",
          topic_id: "79",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments() {
        return [];
      },
    },
    workerPool: {
      async startPromptRun(args) {
        startedRuns.push(args);
        return { ok: true };
      },
    },
  };

  for (const message of messages) {
    const result = await handleIncomingMessage({
      ...commonArgs,
      message,
    });
    assert.equal(result.reason, "prompt-buffered");
  }

  await promptFragmentAssembler.flushPendingForMessage(messages.at(-1));

  assert.equal(startedRuns.length, 1);
  assert.equal(
    startedRuns[0].rawPrompt,
    messages.map((message) => message.text.trim()).join("\n\n"),
  );
  assert.equal(startedRuns[0].message.message_id, messages.at(-1).message_id);
});

test("handleIncomingMessage keeps buffered prompt flush behind promptStartGuard", async () => {
  const startedRuns = [];
  let guardCallCount = 0;
  const promptFragmentAssembler = new PromptFragmentAssembler({
    flushDelayMs: 10000,
    longPromptThresholdChars: 3000,
  });
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const message = {
    text: "A".repeat(3200),
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 894,
    message_thread_id: 79,
  };

  const firstResult = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("guard should short-circuit before reply");
      },
    },
    botUsername: "gatewaybot",
    config,
    promptFragmentAssembler,
    promptStartGuard: {
      async handleCompetingTopicMessage() {
        guardCallCount += 1;
        if (guardCallCount === 1) {
          return { handled: false };
        }

        return { handled: true, reason: "guarded" };
      },
    },
    serviceState,
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:79",
          chat_id: "-1001234567890",
          topic_id: "79",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments() {
        return [];
      },
    },
    workerPool: {
      async startPromptRun(args) {
        startedRuns.push(args);
        return { ok: true };
      },
    },
    message,
  });

  assert.equal(firstResult.reason, "prompt-buffered");
  await promptFragmentAssembler.flushPendingForMessage(message);
  assert.equal(guardCallCount, 2);
  assert.equal(startedRuns.length, 0);
});

test("handleIncomingMessage cancels a buffered long prompt when /interrupt arrives", async () => {
  const sent = [];
  const startedRuns = [];
  const promptFragmentAssembler = new PromptFragmentAssembler({
    flushDelayMs: 10000,
    longPromptThresholdChars: 3000,
  });
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const bufferedMessage = {
    text: "A".repeat(3200),
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 900,
    message_thread_id: 80,
  };
  const interruptMessage = {
    text: "/interrupt",
    entities: [{ type: "bot_command", offset: 0, length: 10 }],
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 901,
    message_thread_id: 80,
  };

  await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: bufferedMessage,
    promptFragmentAssembler,
    serviceState,
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:80",
          chat_id: "-1001234567890",
          topic_id: "80",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ensureSessionForMessage() {
        return {
          session_key: "-1001234567890:80",
          lifecycle_state: "active",
          workspace_binding: {
            repo_root: "/workspace",
            cwd: "/workspace",
            branch: "main",
            worktree_path: "/workspace",
          },
        };
      },
      async recordHandledSession() {},
    },
    workerPool: {
      async startPromptRun(args) {
        startedRuns.push(args);
        return { ok: true };
      },
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  });

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: interruptMessage,
    promptFragmentAssembler,
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return {
          session_key: "-1001234567890:80",
          lifecycle_state: "active",
          workspace_binding: {
            repo_root: "/workspace",
            cwd: "/workspace",
            branch: "main",
            worktree_path: "/workspace",
          },
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

  assert.equal(result.command, "interrupt");
  assert.equal(startedRuns.length, 0);
  assert.equal(promptFragmentAssembler.hasBufferedForMessage(bufferedMessage), false);
  assert.match(sent.at(-1).text, /нет активного run/u);
});

test("handleIncomingMessage uses plain /wait as a local one-shot window and resets after the flushed prompt", async () => {
  const sent = [];
  const startedRuns = [];
  const promptFragmentAssembler = new PromptFragmentAssembler({
    flushDelayMs: 10000,
    longPromptThresholdChars: 3000,
  });
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const session = {
    session_key: "-1001234567890:81",
    chat_id: "-1001234567890",
    topic_id: "82",
    lifecycle_state: "active",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  };
  const waitCommand = {
    text: "wait 600",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 910,
    message_thread_id: 82,
  };
  const attachmentMessage = {
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 911,
    message_thread_id: 82,
    media_group_id: "docs-2",
    document: {
      file_id: "file-1",
      file_unique_id: "uniq-file-1",
      file_name: "script.js",
      mime_type: "application/javascript",
      file_size: 128,
    },
  };
  const secondAttachmentMessage = {
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 912,
    message_thread_id: 82,
    media_group_id: "docs-2",
    document: {
      file_id: "file-2",
      file_unique_id: "uniq-file-2",
      file_name: "notes.md",
      mime_type: "text/markdown",
      file_size: 96,
    },
  };
  const textMessage = {
    text: "Ура!!! Значит всё работает отлично",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 913,
    message_thread_id: 82,
  };
  const secondTextMessage = {
    text: "Теперь я тестирую wait окно.",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 914,
    message_thread_id: 82,
  };
  const flushMessage = {
    text: "Все",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 915,
    message_thread_id: 82,
  };
  const followUpTextMessage = {
    text: "Это уже следующий prompt без повторного /wait.",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 916,
    message_thread_id: 82,
  };

  const commonArgs = {
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    promptFragmentAssembler,
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return {
          ...session,
          session_key: `-1001234567890:${attachmentMessage.message_thread_id}`,
          topic_id: String(attachmentMessage.message_thread_id),
        };
      },
      async ensureRunnableSessionForMessage(message) {
        return {
          ...session,
          session_key: `-1001234567890:${message.message_thread_id}`,
          topic_id: String(message.message_thread_id),
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments(_api, _session, message) {
        if (message.message_id === attachmentMessage.message_id) {
          return [
            {
              file_path: "/tmp/script.js",
              is_image: false,
              mime_type: "application/javascript",
              size_bytes: 128,
            },
          ];
        }

        if (message.message_id === secondAttachmentMessage.message_id) {
          return [
            {
              file_path: "/tmp/notes.md",
              is_image: false,
              mime_type: "text/markdown",
              size_bytes: 96,
            },
          ];
        }

        return [];
      },
      async recordHandledSession() {},
    },
    workerPool: {
      async startPromptRun(args) {
        startedRuns.push(args);
        return { ok: true };
      },
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  };

  const waitResult = await handleIncomingMessage({
    ...commonArgs,
    message: waitCommand,
  });
  const attachmentResult = await handleIncomingMessage({
    ...commonArgs,
    message: attachmentMessage,
  });
  const secondAttachmentResult = await handleIncomingMessage({
    ...commonArgs,
    message: secondAttachmentMessage,
  });
  const textResult = await handleIncomingMessage({
    ...commonArgs,
    message: textMessage,
  });
  const secondTextResult = await handleIncomingMessage({
    ...commonArgs,
    message: secondTextMessage,
  });
  const flushResult = await handleIncomingMessage({
    ...commonArgs,
    message: flushMessage,
  });
  const followUpTextResult = await handleIncomingMessage({
    ...commonArgs,
    message: followUpTextMessage,
  });

  assert.equal(waitResult.command, "wait");
  assert.match(sent[0].text, /status: on/u);
  assert.equal(attachmentResult.reason, "prompt-buffered");
  assert.equal(secondAttachmentResult.reason, "prompt-buffered");
  assert.equal(textResult.reason, "prompt-buffered");
  assert.equal(secondTextResult.reason, "prompt-buffered");
  assert.equal(flushResult.reason, "prompt-buffer-flushed");
  assert.equal(followUpTextResult.reason, "prompt-started");
  assert.equal(startedRuns.length, 2);
  assert.equal(
    startedRuns[0].rawPrompt,
    `${textMessage.text}\n\n${secondTextMessage.text}`,
  );
  assert.equal(startedRuns[0].attachments.length, 2);
  assert.equal(startedRuns[0].message.message_id, secondTextMessage.message_id);
  assert.equal(startedRuns[0].session.topic_id, "82");
  assert.equal(startedRuns[1].rawPrompt, followUpTextMessage.text);
  assert.equal(startedRuns[1].attachments.length, 0);
  assert.equal(startedRuns[1].message.message_id, followUpTextMessage.message_id);
  assert.equal(startedRuns[1].session.topic_id, "82");
});

test("handleIncomingMessage keeps /wait global persistent across topics", async () => {
  const sent = [];
  const startedRuns = [];
  const promptFragmentAssembler = new PromptFragmentAssembler({
    flushDelayMs: 10000,
    longPromptThresholdChars: 3000,
  });
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const waitCommand = {
    text: "/wait global 600",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 920,
    message_thread_id: 81,
    entities: [{ type: "bot_command", offset: 0, length: 5 }],
  };
  const firstTopicMessage = {
    text: "first buffered part",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 921,
    message_thread_id: 82,
  };
  const secondTopicMessage = {
    text: "second buffered part",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 922,
    message_thread_id: 83,
  };
  const flushMessage = {
    text: "Все",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 923,
    message_thread_id: 84,
  };

  const commonArgs = {
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    promptFragmentAssembler,
    serviceState,
    sessionService: {
      async ensureSessionForMessage(message) {
        return {
          session_key: `-1001234567890:${message.message_thread_id}`,
          chat_id: "-1001234567890",
          topic_id: String(message.message_thread_id),
          lifecycle_state: "active",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
          workspace_binding: {
            repo_root: "/workspace",
            cwd: "/workspace",
            branch: "main",
            worktree_path: "/workspace",
          },
        };
      },
      async ensureRunnableSessionForMessage(message) {
        return {
          session_key: `-1001234567890:${message.message_thread_id}`,
          chat_id: "-1001234567890",
          topic_id: String(message.message_thread_id),
          lifecycle_state: "active",
          workspace_binding: {
            repo_root: "/workspace",
            cwd: "/workspace",
            branch: "main",
            worktree_path: "/workspace",
          },
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments() {
        return [];
      },
      async recordHandledSession() {},
    },
    workerPool: {
      async startPromptRun(args) {
        startedRuns.push(args);
        return { ok: true };
      },
      getActiveRun() {
        return null;
      },
      interrupt() {
        return false;
      },
    },
  };

  const waitResult = await handleIncomingMessage({
    ...commonArgs,
    message: waitCommand,
  });
  const firstResult = await handleIncomingMessage({
    ...commonArgs,
    message: firstTopicMessage,
  });
  const secondResult = await handleIncomingMessage({
    ...commonArgs,
    message: secondTopicMessage,
  });
  const flushResult = await handleIncomingMessage({
    ...commonArgs,
    message: flushMessage,
  });

  assert.equal(waitResult.command, "wait");
  assert.match(sent[0].text, /scope: global/u);
  assert.equal(firstResult.reason, "prompt-buffered");
  assert.equal(secondResult.reason, "prompt-buffered");
  assert.equal(flushResult.reason, "prompt-buffer-flushed");
  assert.equal(startedRuns.length, 1);
  assert.equal(
    startedRuns[0].rawPrompt,
    `${firstTopicMessage.text}\n\n${secondTopicMessage.text}`,
  );
});

test("handleIncomingMessage reports busy topic run", async () => {
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
      text: "run a quick task",
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 78,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:78",
        };
      },
    },
    workerPool: {
      async startPromptRun() {
        return { ok: false, reason: "busy" };
      },
    },
  });

  assert.equal(result.reason, "busy");
  assert.match(sent[0].text, /ещё работаю в этой теме/u);
});

test("handleIncomingMessage steers the active run instead of returning busy when the topic is already running", async () => {
  const sent = [];
  const steerCalls = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "Докинь ещё вот это.",
      message_id: 990,
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 78,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:78",
          chat_id: "-1001234567890",
          topic_id: "78",
          prompt_suffix_enabled: true,
          prompt_suffix_text: "SUFFIX",
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments() {
        return [];
      },
    },
    workerPool: {
      async startPromptRun() {
        return { ok: false, reason: "busy" };
      },
      async steerActiveRun(args) {
        steerCalls.push(args);
        return {
          ok: true,
          reason: "steered",
          inputCount: 1,
        };
      },
    },
  });

  assert.equal(result.reason, "steered");
  assert.equal(steerCalls.length, 1);
  assert.equal(steerCalls[0].rawPrompt, "Докинь ещё вот это.");
  assert.match(sent[0].text, /Докину это в текущий run/u);
});
