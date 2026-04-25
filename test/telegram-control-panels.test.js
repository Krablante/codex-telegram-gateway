import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingCallbackQuery,
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { handleGlobalControlCallbackQuery } from "../src/telegram/global-control-panel.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";
import {
  buildIdleWorkerPool,
  buildUnlimitedLimitsSummary,
  config,
  createGlobalControlPanelStore,
  createGlobalControlSessionService,
  createTopicControlPanelStore,
} from "../test-support/control-panel-fixtures.js";

test("handleIncomingMessage opens the persistent global control panel in General", async () => {
  const sent = [];
  const limitsRequests = [];
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
    sessionService: createGlobalControlSessionService({
      async getCodexLimitsSummary(options) {
        limitsRequests.push(options ?? {});
        return buildUnlimitedLimitsSummary();
      },
    }),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "global");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Global control panel/u);
  assert.doesNotMatch(sent[0].text, /Закрепи это сообщение/u);
  assert.match(sent[0].text, /interface language: RUS/u);
  assert.match(sent[0].text, /topic hosts: 2 ready \/ 3/u);
  assert.match(sent[0].text, /лимиты: безлимит/u);
  assert.match(sent[0].text, /spike: .+ \([a-z]+\)/u);
  assert.doesNotMatch(sent[0].text, /spike reasoning:/u);
  assert.equal(Array.isArray(sent[0].reply_markup.inline_keyboard), true);
  assert.deepEqual(
    sent[0].reply_markup.inline_keyboard[0].map((button) => button.text),
    ["New Topic", "Hosts"],
  );
  assert.deepEqual(
    sent[0].reply_markup.inline_keyboard[1].map((button) => button.text),
    ["Bot Settings", "Language"],
  );
  assert.deepEqual(
    sent[0].reply_markup.inline_keyboard[2].map((button) => button.text),
    ["Guide", "Help"],
  );
  assert.deepEqual(
    sent[0].reply_markup.inline_keyboard[3].map((button) => button.text),
    ["Wait", "Suffix"],
  );
  assert.deepEqual(
    sent[0].reply_markup.inline_keyboard[4].map((button) => button.text),
    ["Zoo", "Clear"],
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Bot Settings"),
    ),
    true,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Spike model"),
    ),
    false,
  );
  assert.deepEqual(limitsRequests, [{ allowStale: true }]);
  assert.equal(store.getState().menu_message_id, 901);
});

test("handleIncomingMessage opens the persistent global control panel when General uses thread id 0", async () => {
  const sent = [];
  const store = createGlobalControlPanelStore();

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
      message_thread_id: 0,
    },
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "global");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Global control panel/u);
});

test("handleIncomingCallbackQuery opens the new-topic host picker inside the global menu", async () => {
  const edited = [];
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
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-new-topic",
      data: "gcfg:n:nt",
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
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /New topic host picker/u);
  assert.match(edited[0].text, /- worker-a: ready/u);
  assert.equal(
    edited[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "worker-a"),
    ),
    true,
  );
});

test("handleIncomingCallbackQuery starts new-topic title input directly with one configured host", async () => {
  const edited = [];
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
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-single-host-new-topic",
      data: "gcfg:n:nt",
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
    sessionService: createGlobalControlSessionService({
      async listTopicCreationHosts() {
        return [
          {
            ok: true,
            hostId: "controller",
            hostLabel: "controller",
            lastReadyAt: "2026-04-21T19:00:00.000Z",
            failureReason: null,
          },
        ];
      },
    }),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-pending-input-started");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /Global control panel/u);
  assert.doesNotMatch(edited[0].text, /New topic host picker/u);
  assert.match(edited[0].text, /pending input: topic title; send the next text message/u);
  assert.match(edited[0].text, /status: Send the next text message with the new topic title\./u);
  assert.doesNotMatch(edited[0].text, /for host controller/u);
  assert.equal(store.getState().active_screen, "root");
  assert.equal(store.getState().pending_input.kind, "new_topic_title");
  assert.equal(store.getState().pending_input.requested_host_id, "controller");
  assert.equal(store.getState().pending_input.single_host_auto_selected, true);
});

test("handleIncomingCallbackQuery keeps host picker when one of several hosts is ready", async () => {
  const edited = [];
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
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-one-ready-new-topic",
      data: "gcfg:n:nt",
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
    sessionService: createGlobalControlSessionService({
      async listTopicCreationHosts() {
        return [
          {
            ok: true,
            hostId: "controller",
            hostLabel: "controller",
            lastReadyAt: "2026-04-21T19:00:00.000Z",
            failureReason: null,
          },
          {
            ok: false,
            hostId: "worker-a",
            hostLabel: "worker-a",
            lastReadyAt: null,
            failureReason: "host-not-ready",
          },
          {
            ok: false,
            hostId: "worker-b",
            hostLabel: "worker-b",
            lastReadyAt: null,
            failureReason: "codex-auth",
          },
        ];
      },
    }),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /New topic host picker/u);
  assert.match(edited[0].text, /- controller: ready/u);
  assert.match(edited[0].text, /- worker-a: not-ready/u);
  assert.equal(store.getState().active_screen, "new_topic");
  assert.equal(store.getState().pending_input, null);
  assert.deepEqual(
    edited[0].reply_markup.inline_keyboard
      .flat()
      .filter((button) => ["controller", "worker-a", "worker-b"].includes(button.text))
      .map((button) => button.text),
    ["controller"],
  );
});

test("handleIncomingCallbackQuery routes global callbacks before topic-only fallback", async () => {
  const edited = [];
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
      async editMessageText(payload) {
        edited.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-global-with-topic-store",
      data: "gcfg:n:nt",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1001234567890 },
      },
    },
    config,
    globalControlPanelStore: store,
    topicControlPanelStore: createTopicControlPanelStore(),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /New topic host picker/u);
});

test("handleGlobalControlCallbackQuery reports an unavailable stale host picker selection", async () => {
  const answered = [];
  const edited = [];
  const sent = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "new_topic",
    ui_language: "eng",
  });

  const result = await handleGlobalControlCallbackQuery({
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
    callbackQuery: {
      id: "cbq-global-new-topic-unavailable",
      data: "gcfg:nh:worker-b",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1001234567890 },
      },
    },
    config,
    dispatchCommand() {
      throw new Error("should not dispatch /new for an unavailable host");
    },
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    sessionService: createGlobalControlSessionService(),
  });

  assert.equal(result.reason, "global-control-host-unavailable");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(sent.length, 0);
  assert.match(edited[0].text, /Host worker-b is unavailable right now/u);
});

test("handleIncomingMessage creates a host-bound topic from the global host picker reply", async () => {
  const edited = [];
  const sent = [];
  const createCalls = [];
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const globalControlPanelStore = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "new_topic",
    ui_language: "eng",
    pending_input: {
      kind: "new_topic_title",
      requested_at: "2026-04-21T19:20:00.000Z",
      requested_by_user_id: "123456789",
      menu_message_id: 901,
      screen: "new_topic",
      requested_host_id: "worker-a",
      requested_host_label: "worker-a",
    },
  });
  const sessionService = createGlobalControlSessionService({
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
          name: "Remote bound topic (worker-a)",
          message_thread_id: 77,
        },
        session: {
          session_key: "-1001234567890:77",
          chat_id: "-1001234567890",
          topic_id: "77",
          topic_name: "Remote bound topic (worker-a)",
          lifecycle_state: "active",
          ui_language: "eng",
          execution_host_id: "worker-a",
          execution_host_label: "worker-a",
          workspace_binding: {
            repo_root: "/srv/codex-workspace",
            cwd: "/srv/codex-workspace",
            branch: "main",
            worktree_path: "/srv/codex-workspace",
          },
        },
      };
    },
    async recordHandledSession() {},
  });

  await handleIncomingMessage({
    api: {
      async editMessageText(payload) {
        edited.push(payload);
      },
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 950 + sent.length };
      },
      async pinChatMessage() {},
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore,
    message: {
      text: "Remote bound topic",
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
    sessionService,
    topicControlPanelStore: createTopicControlPanelStore(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].executionHostId, "worker-a");
  assert.equal(createCalls[0].title, "Remote bound topic");
  assert.equal(globalControlPanelStore.getState().pending_input, null);
  assert.equal(edited.length >= 1, true);
  assert.equal(sent.some((payload) => /Remote bound topic \(worker-a\)/u.test(payload.text)), true);
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
    workerPool: buildIdleWorkerPool(),
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
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
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

test("handleGlobalControlCallbackQuery reports unavailable global wait without throwing", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "wait",
  });

  const result = await handleGlobalControlCallbackQuery({
    applyGlobalWaitChange: async () => ({ available: false }),
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
    callbackQuery: {
      id: "cbq-wait-unavailable",
      data: "gcfg:w:60",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1001234567890 },
      },
    },
    config,
    dispatchCommand: async () => {
      throw new Error("dispatchCommand should not run for unavailable wait");
    },
    globalControlPanelStore: store,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    sessionService: createGlobalControlSessionService(),
  });

  assert.equal(result.reason, "global-control-action-applied");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(sent.length, 0);
  assert.match(edited[0].text, /Manual collection window|Manual collection windows/u);
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
    sessionService: createGlobalControlSessionService({
      async getCodexLimitsSummary() {
        return buildUnlimitedLimitsSummary();
      },
    }),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-language-updated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(store.getState().ui_language, "eng");
  assert.equal(store.getState().active_screen, "root");
  assert.match(edited[0].text, /Global control panel/u);
  assert.match(edited[0].text, /interface language: ENG/u);
  assert.match(edited[0].text, /limits: unlimited/u);
  assert.match(edited[0].text, /Interface language updated\./u);
});

test("handleIncomingCallbackQuery opens bot settings inside the global control menu", async () => {
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "root",
  });

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
      id: "cbq-global-bots",
      data: "gcfg:n:b",
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
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /Bot settings|Настройки ботов/u);
  assert.match(edited[0].text, /\/compact: gpt-5\.4 \(medium\)/u);
  assert.equal(edited[0].reply_markup.inline_keyboard[0][0].text, "Spike model");
  assert.equal(
    edited[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "/compact model"),
    ),
    true,
  );
  assert.equal(
    edited[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "/compact reasoning"),
    ),
    true,
  );
  assert.equal(edited[0].reply_markup.inline_keyboard.at(-1)[0].text, "Back");
  assert.equal(store.getState().active_screen, "bot_settings");
});

test("handleIncomingCallbackQuery applies compact model from the global control panel", async () => {
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "compact_model",
  });
  const sessionService = createGlobalControlSessionService();

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
      id: "cbq-global-compact-model",
      data: "gcfg:m:c:gpt-5.4-mini",
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
    sessionService,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-action-applied");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(store.getState().active_screen, "compact_model");
  assert.match(edited[0].text, /Compact summarizer model/u);
  assert.match(edited[0].text, /(?:configured|настроено): gpt-5\.4-mini/u);
  const settings = await sessionService.getGlobalCodexSettings();
  assert.equal(settings.compact_model, "gpt-5.4-mini");
});

test("handleIncomingCallbackQuery applies compact reasoning from the global control panel", async () => {
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "compact_reasoning",
  });
  const sessionService = createGlobalControlSessionService();

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
      id: "cbq-global-compact-reasoning",
      data: "gcfg:r:c:high",
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
    sessionService,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-action-applied");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(store.getState().active_screen, "compact_reasoning");
  assert.match(edited[0].text, /Compact summarizer reasoning/u);
  assert.match(edited[0].text, /(?:configured|настроено): High \(high\)/u);
  const settings = await sessionService.getGlobalCodexSettings();
  assert.equal(settings.compact_reasoning_effort, "high");
});

test("handleIncomingCallbackQuery rejects stale global menu callbacks", async () => {
  const answered = [];
  const edited = [];

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
      id: "cbq-global-stale",
      data: "gcfg:n:b",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 900,
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
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-menu-expired");
  assert.equal(edited.length, 0);
  assert.equal(answered.length, 1);
  assert.match(answered[0].text, /устарело/u);
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
    sessionService: createGlobalControlSessionService({
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: true,
          prompt_suffix_text: longSuffix,
        };
      },
    }),
    workerPool: buildIdleWorkerPool(),
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
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-help-sent");
  assert.equal(answered.length, 1);
  assert.equal(documents.length, 2);
  assert.equal(documents[0].document.fileName, "severus-help-summer-eng-1.png");
  assert.equal(documents[1].document.fileName, "severus-help-summer-eng-2.png");
});

test("handleIncomingCallbackQuery sends the guidebook in the selected global panel language", async () => {
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
      id: "cbq-guide",
      data: "gcfg:g:show",
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
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "global-control-guide-sent");
  assert.equal(answered.length, 1);
  assert.equal(documents.length, 1);
  assert.equal(documents[0].document.fileName, "codex-telegram-guidebook-eng.pdf");
});

test("handleGlobalControlCallbackQuery dispatches /zoo from the global root menu", async () => {
  const answered = [];
  const dispatched = [];
  const chat = { id: Number(config.telegramForumChatId) };

  const result = await handleGlobalControlCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText() {
        throw new Error("Zoo shortcut should not edit the global menu directly");
      },
      async sendMessage() {
        throw new Error("Zoo shortcut should route through dispatchCommand");
      },
    },
    callbackQuery: {
      id: "cbq-zoo-shortcut",
      data: "gcfg:z:show",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 901,
        chat,
      },
    },
    config,
    dispatchCommand: async (payload) => {
      dispatched.push(payload);
      return { handled: true, command: "zoo", reason: "zoo-topic-opened" };
    },
    globalControlPanelStore: createGlobalControlPanelStore({
      menu_message_id: 901,
      active_screen: "root",
    }),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    sessionService: createGlobalControlSessionService(),
  });

  assert.equal(result.reason, "global-control-zoo-opened");
  assert.equal(answered.length, 1);
  assert.deepEqual(dispatched, [{
    actor: { id: 123456789, is_bot: false },
    chat,
    commandText: "/zoo",
  }]);
});

test("handleIncomingCallbackQuery keeps zoo routing alive for the global Zoo button", async () => {
  const answered = [];
  const zooMessages = [];

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText() {
        throw new Error("Zoo shortcut should route through zooService");
      },
      async sendMessage() {
        throw new Error("Zoo shortcut should not send a General no-session reply");
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-zoo-live-route",
      data: "gcfg:z:show",
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
    }),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
    zooService: {
      async handleCallbackQuery() {
        return { handled: false };
      },
      async maybeHandleIncomingMessage({ message }) {
        zooMessages.push(message);
        return { handled: true, command: "zoo", reason: "zoo-topic-opened" };
      },
    },
  });

  assert.equal(result.reason, "global-control-zoo-opened");
  assert.equal(answered.length, 1);
  assert.equal(zooMessages.length, 1);
  assert.equal(zooMessages[0].text, "/zoo");
  assert.equal(zooMessages[0].is_internal_global_control_dispatch, true);
});

test("handleGlobalControlCallbackQuery dispatches /clear from the global root menu", async () => {
  const answered = [];
  const dispatched = [];
  const chat = { id: Number(config.telegramForumChatId) };

  const result = await handleGlobalControlCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async editMessageText() {
        throw new Error("Clear shortcut should route through the General cleanup flow");
      },
      async sendMessage() {
        throw new Error("Clear shortcut should not send a side message here");
      },
    },
    callbackQuery: {
      id: "cbq-clear-shortcut",
      data: "gcfg:c:run",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 901,
        chat,
      },
    },
    config,
    dispatchCommand: async (payload) => {
      dispatched.push(payload);
      return { handled: true, command: "clear", reason: "clear-complete" };
    },
    globalControlPanelStore: createGlobalControlPanelStore({
      menu_message_id: 901,
      active_screen: "root",
    }),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    sessionService: createGlobalControlSessionService(),
  });

  assert.equal(result.reason, "global-control-clear-run");
  assert.equal(answered.length, 1);
  assert.deepEqual(dispatched, [{
    actor: { id: 123456789, is_bot: false },
    chat,
    commandText: "/clear",
  }]);
});
