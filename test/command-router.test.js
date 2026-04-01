import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPromptSuffix,
  buildBindingResolutionErrorMessage,
  buildNoSessionTopicMessage,
  buildReplyMessageParams,
  buildStatusMessage,
  extractBotCommand,
  getTopicLabel,
  handleIncomingMessage,
  isAuthorizedMessage,
  parseLanguageCommandArgs,
  parseWaitCommandArgs,
  parsePromptSuffixCommandArgs,
  parseNewTopicCommandArgs,
} from "../src/telegram/command-router.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";

const config = {
  telegramAllowedUserId: "1234567890",
  telegramForumChatId: "-1001234567890",
  maxParallelSessions: 4,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

test("parseNewTopicCommandArgs keeps legacy title mode and supports explicit binding path", () => {
  assert.deepEqual(parseNewTopicCommandArgs("Slice 4 test"), {
    bindingPath: null,
    title: "Slice 4 test",
  });
  assert.deepEqual(
    parseNewTopicCommandArgs("cwd=/home/example/workspace Gateway topic"),
    {
      bindingPath: "/home/example/workspace",
      title: "Gateway topic",
    },
  );
  assert.deepEqual(
    parseNewTopicCommandArgs("--cwd=homelab/infra/automation/codex-telegram-gateway"),
    {
      bindingPath: "homelab/infra/automation/codex-telegram-gateway",
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

test("parseWaitCommandArgs supports show, disable, and duration modes", () => {
  assert.deepEqual(parseWaitCommandArgs(""), {
    action: "show",
    delayMs: null,
    seconds: null,
  });
  assert.deepEqual(parseWaitCommandArgs("off"), {
    action: "off",
    delayMs: null,
    seconds: null,
  });
  assert.deepEqual(parseWaitCommandArgs("60"), {
    action: "set",
    delayMs: 60000,
    seconds: 60,
  });
  assert.deepEqual(parseWaitCommandArgs("1m"), {
    action: "set",
    delayMs: 60000,
    seconds: 60,
  });
  assert.deepEqual(parseWaitCommandArgs("90s"), {
    action: "set",
    delayMs: 90000,
    seconds: 90,
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

test("isAuthorizedMessage only allows configured user in configured chat", () => {
  const message = {
    from: { id: 1234567890, is_bot: false },
    chat: { id: -1001234567890 },
  };

  assert.equal(isAuthorizedMessage(message, config), true);
  assert.equal(
    isAuthorizedMessage(
      { ...message, from: { id: 1, is_bot: false } },
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
        repo_root: "/home/example/workspace",
        cwd: "/home/example/workspace",
        branch: "main",
        worktree_path: "/home/example/workspace",
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
  assert.match(text, /папка: \/home\/bloob\/atlas/u);
  assert.match(text, /модель: gpt-5\.4/u);
  assert.match(text, /thinking: xhigh/u);
  assert.match(text, /context window: 320000/u);
  assert.match(text, /язык: RUS/u);
  assert.match(text, /использование контекста: 71\.4%/u);
  assert.match(text, /токены контекста: 228400 \/ 320000/u);
  assert.match(text, /доступно токенов: 91600/u);
  assert.match(text, /вход\/кэш\/выход: 227200 \/ 180000 \/ 1200/u);
  assert.match(text, /reasoning tokens: 800/u);
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
        repo_root: "/home/example/workspace",
        cwd: "/home/example/workspace",
        branch: "main",
        worktree_path: "/home/example/workspace",
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

test("handleIncomingMessage sends the help card from General topic", async () => {
  const photos = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendPhoto(payload) {
        photos.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
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

  assert.equal(result.command, "help");
  assert.equal(photos.length, 1);
  assert.equal(photos[0].photo.fileName, "severus-help-summer-rus.png");
  assert.equal(photos[0].caption, undefined);
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
      repo_root: "/home/example/workspace",
      cwd: "/home/example/workspace",
      branch: "main",
      worktree_path: "/home/example/workspace",
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

test("handleIncomingMessage sends the English help card inside an ENG topic", async () => {
  const photos = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendPhoto(payload) {
        photos.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1234567890, is_bot: false },
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
            repo_root: "/home/example/workspace",
            cwd: "/home/example/workspace",
            branch: "main",
            worktree_path: "/home/example/workspace",
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
  assert.equal(photos.length, 1);
  assert.equal(photos[0].photo.fileName, "severus-help-summer-eng.png");
  assert.equal(photos[0].caption, undefined);
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

  assert.equal(result.command, "suffix");
  assert.match(sent[0].text, /Suffix help/u);
  assert.match(sent[0].text, /\/suffix global <text>/u);
  assert.match(sent[0].text, /\/suffix topic off/u);
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
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState,
    sessionService: {
      async resolveInheritedBinding() {
        return {
          binding: {
            repo_root: "/home/example/workspace",
            cwd: "/home/example/workspace",
            branch: "main",
            worktree_path: "/home/example/workspace",
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
              repo_root: "/home/example/workspace",
              cwd: "/home/example/workspace",
              branch: "main",
              worktree_path: "/home/example/workspace",
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
      text: "/new cwd=homelab/infra/automation/codex-telegram-gateway Bound repo",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState,
    sessionService: {
      async resolveBindingPath(requestedPath) {
        assert.equal(
          requestedPath,
          "homelab/infra/automation/codex-telegram-gateway",
        );
        return {
          repo_root: "/path/to/codex-telegram-gateway",
          cwd: "/path/to/codex-telegram-gateway",
          branch: "main",
          worktree_path: "/path/to/codex-telegram-gateway",
        };
      },
      async createTopicSession({ title, workspaceBinding, inheritedFromSessionKey }) {
        assert.equal(title, "Bound repo");
        assert.equal(inheritedFromSessionKey, null);
        assert.equal(
          workspaceBinding.cwd,
          "/path/to/codex-telegram-gateway",
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
      from: { id: 1234567890, is_bot: false },
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
      from: { id: 1234567890, is_bot: false },
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
      from: { id: 1234567890, is_bot: false },
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
      from: { id: 1234567890, is_bot: false },
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
      repo_root: "/home/example/workspace",
      cwd: "/home/example/workspace",
      branch: "main",
      worktree_path: "/home/example/workspace",
    },
  };
  const firstMessage = {
    caption: "Разбери оба файла вместе.",
    media_group_id: "docs-1",
    from: { id: 1234567890, is_bot: false },
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
    from: { id: 1234567890, is_bot: false },
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

test("handleIncomingMessage stores prompt suffix text via /suffix", async () => {
  const sent = [];
  const session = {
    session_key: "-1001234567890:77",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
    lifecycle_state: "active",
    workspace_binding: {
      repo_root: "/home/example/workspace",
      cwd: "/home/example/workspace",
      branch: "main",
      worktree_path: "/home/example/workspace",
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
  assert.match(sent[0].text, /Prompt suffix обновлён\./u);
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
  assert.match(sent[0].text, /Глобальный prompt suffix обновлён\./u);
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
      repo_root: "/home/example/workspace",
      cwd: "/home/example/workspace",
      branch: "main",
      worktree_path: "/home/example/workspace",
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
  assert.match(sent[0].text, /Routing topic prompt suffix выключен\./u);
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
      from: { id: 1234567890, is_bot: false },
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
        throw new Error("should not start run without prompt");
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
      repo_root: "/home/example/workspace",
      cwd: "/home/example/workspace",
      branch: "main",
      worktree_path: "/home/example/workspace",
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
    from: { id: 1234567890, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 2001,
    message_thread_id: 88,
  };
  const textMessage = {
    text: "Переделай это в нормальный формат и влепи в ридмишку.",
    from: { id: 1234567890, is_bot: false },
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
    from: { id: 1234567890, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 880,
    message_thread_id: 78,
  };
  const secondMessage = {
    text: " second-fragment",
    from: { id: 1234567890, is_bot: false },
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
    from: { id: 1234567890, is_bot: false },
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
    from: { id: 1234567890, is_bot: false },
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
    from: { id: 1234567890, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 900,
    message_thread_id: 80,
  };
  const interruptMessage = {
    text: "/interrupt",
    entities: [{ type: "bot_command", offset: 0, length: 10 }],
    from: { id: 1234567890, is_bot: false },
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
            repo_root: "/home/example/workspace",
            cwd: "/home/example/workspace",
            branch: "main",
            worktree_path: "/home/example/workspace",
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
            repo_root: "/home/example/workspace",
            cwd: "/home/example/workspace",
            branch: "main",
            worktree_path: "/home/example/workspace",
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

test("handleIncomingMessage buffers mixed payloads after global wait and flushes them on single-word Все", async () => {
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
      repo_root: "/home/example/workspace",
      cwd: "/home/example/workspace",
      branch: "main",
      worktree_path: "/home/example/workspace",
    },
  };
  const waitCommand = {
    text: "wait 600",
    from: { id: 1234567890, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 910,
    message_thread_id: 81,
  };
  const attachmentMessage = {
    from: { id: 1234567890, is_bot: false },
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
    from: { id: 1234567890, is_bot: false },
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
    from: { id: 1234567890, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 913,
    message_thread_id: 82,
  };
  const secondTextMessage = {
    text: "Теперь я тестирую wait окно.",
    from: { id: 1234567890, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 914,
    message_thread_id: 82,
  };
  const flushMessage = {
    text: "Все",
    from: { id: 1234567890, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 915,
    message_thread_id: 83,
  };
  const followUpTextMessage = {
    text: "Это уже следующий prompt без повторного /wait.",
    from: { id: 1234567890, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 916,
    message_thread_id: 84,
  };
  const secondFlushMessage = {
    text: "Все",
    from: { id: 1234567890, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 917,
    message_thread_id: 85,
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
          session_key: `-1001234567890:${waitCommand.message_thread_id}`,
          topic_id: String(waitCommand.message_thread_id),
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
  const secondFlushResult = await handleIncomingMessage({
    ...commonArgs,
    message: secondFlushMessage,
  });

  assert.equal(waitResult.command, "wait");
  assert.match(sent[0].text, /status: on/u);
  assert.equal(attachmentResult.reason, "prompt-buffered");
  assert.equal(secondAttachmentResult.reason, "prompt-buffered");
  assert.equal(textResult.reason, "prompt-buffered");
  assert.equal(secondTextResult.reason, "prompt-buffered");
  assert.equal(flushResult.reason, "prompt-buffer-flushed");
  assert.equal(followUpTextResult.reason, "prompt-buffered");
  assert.equal(secondFlushResult.reason, "prompt-buffer-flushed");
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
  assert.equal(startedRuns[1].session.topic_id, "84");
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
      from: { id: 1234567890, is_bot: false },
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
      from: { id: 1234567890, is_bot: false },
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
