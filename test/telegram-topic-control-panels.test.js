import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingCallbackQuery,
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { buildCompactQueuedHandoffMessage } from "../src/telegram/command-handlers/topic-commands.js";
import { handleTopicControlCallbackQuery } from "../src/telegram/topic-control-panel.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";
import {
  buildIdleWorkerPool,
  config,
  createServiceState,
  createTopicControlPanelStore,
  createTopicSession,
  createTopicSessionService,
} from "../test-support/control-panel-fixtures.js";

test("handleIncomingCallbackQuery applies a local wait preset from the topic control panel", async () => {
  const edited = [];
  const answered = [];
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "wait",
  });
  const session = createTopicSession();

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
      from: { id: 5825672398, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1003577434463 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler,
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  const waitState = promptFragmentAssembler.getStateForMessage({
    chat: { id: -1003577434463 },
    from: { id: 5825672398 },
    message_thread_id: 55,
  });

  assert.equal(result.reason, "topic-control-action-applied");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(waitState.local.active, true);
  assert.equal(waitState.local.flushDelayMs, 300000);
});

test("handleIncomingCallbackQuery renders status inside the topic control menu", async () => {
  const edited = [];
  const answered = [];
  const limitsRequests = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "root",
  });
  const session = createTopicSession({
    lifecycle_state: "active",
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
      id: "cbq-topic-status",
      data: "tcfg:n:st",
      from: { id: 5825672398, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1003577434463 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session, {
      async getCodexLimitsSummary(options) {
        limitsRequests.push(options ?? {});
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
        };
      },
      async resolveContextSnapshot(current) {
        return {
          session: current,
          snapshot: null,
        };
      },
    }),
    topicControlPanelStore,
    workerPool: {
      getActiveRun() {
        return {
          state: {
            status: "running",
          },
        };
      },
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.reason, "topic-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /^Статус/u);
  assert.match(edited[0].text, /run: running/u);
  assert.match(edited[0].text, /лимиты: безлимит/u);
  assert.equal(edited[0].reply_markup.inline_keyboard[0][0].text, "Refresh");
  assert.equal(edited[0].reply_markup.inline_keyboard[0][1].text, "Back");
  assert.deepEqual(limitsRequests, [{ allowStale: true }]);
  assert.equal(topicControlPanelStore.getState(session).active_screen, "status");
});

test("handleIncomingCallbackQuery blocks topic-panel /compact while an Omni handoff is queued", async () => {
  const sent = [];
  const answered = [];
  const session = createTopicSession();

  const result = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 902 };
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-topic-compact",
      data: "tcfg:cmd:compact",
      from: { id: 5825672398, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1003577434463 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    promptHandoffStore: {
      async load() {
        return {
          mode: "continuation",
          prompt: "Queued Omni continuation",
        };
      },
    },
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore: createTopicControlPanelStore({
      menu_message_id: 91,
      active_screen: "root",
    }),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-command-dispatched");
  assert.equal(answered.length, 1);
  assert.equal(sent[0].text, buildCompactQueuedHandoffMessage(session));
});

test("handleIncomingMessage opens and pins the local topic control menu with /menu", async () => {
  const sent = [];
  const pinned = [];
  const deleted = [];
  const limitsRequests = [];
  const topicControlPanelStore = createTopicControlPanelStore();
  const session = createTopicSession();

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
      async deleteMessage(payload) {
        deleted.push(payload);
        return true;
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/menu",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
      message_thread_id: 55,
    },
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session, {
      async getCodexLimitsSummary(options) {
        limitsRequests.push(options ?? {});
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
        };
      },
    }),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "menu");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_thread_id, 55);
  assert.match(sent[0].text, /Topic control panel/u);
  assert.match(sent[0].text, /global suffix routing: on/u);
  assert.match(sent[0].text, /лимиты: безлимит/u);
  assert.match(sent[0].text, /spike: .+ \([a-z]+\)/u);
  assert.doesNotMatch(sent[0].text, /spike reasoning:/u);
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Status"),
    ),
    true,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Language"),
    ),
    false,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Help"),
    ),
    false,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Bot Settings"),
    ),
    true,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Compact"),
    ),
    true,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Interrupt"),
    ),
    true,
  );
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Purge"),
    ),
    true,
  );
  assert.equal(sent[0].reply_markup.inline_keyboard[0][0].text, "Bot Settings");
  assert.equal(sent[0].reply_markup.inline_keyboard[0][1].text, "Status");
  assert.equal(sent[0].reply_markup.inline_keyboard[1][0].text, "Suffix");
  assert.equal(sent[0].reply_markup.inline_keyboard[1][1].text, "Wait");
  assert.equal(sent[0].reply_markup.inline_keyboard[2][0].text, "Purge");
  assert.equal(sent[0].reply_markup.inline_keyboard[3][0].text, "Compact");
  assert.equal(
    sent[0].reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text === "Spike model"),
    ),
    false,
  );
  assert.equal(pinned.length, 1);
  assert.equal(deleted.length, 0);
  assert.deepEqual(limitsRequests, [{ allowStale: true }]);
  assert.equal(topicControlPanelStore.getState(session).menu_message_id, 777);
});

test("handleIncomingMessage opens the local topic control menu from a suggested /menu@bot command without relying on entities", async () => {
  const sent = [];
  const topicControlPanelStore = createTopicControlPanelStore();
  const session = createTopicSession();

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 778 };
      },
      async pinChatMessage() {
        return true;
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/menu@gatewaybot",
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
      message_thread_id: 55,
    },
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "menu");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Topic control panel/u);
});

test("handleIncomingMessage recreates the local topic control menu when an explicit /menu hits an unchanged panel", async () => {
  const sent = [];
  const edited = [];
  const pinned = [];
  const deleted = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 6871,
    active_screen: "root",
  });
  const session = createTopicSession({
    session_key: "-1003577434463:2203",
    topic_id: "2203",
    topic_name: "codex-telegram",
  });

  const result = await handleIncomingMessage({
    api: {
      async editMessageText(payload) {
        edited.push(payload);
        throw new Error("Telegram API editMessageText failed: message is not modified");
      },
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 6889 };
      },
      async pinChatMessage(payload) {
        pinned.push(payload);
        return true;
      },
      async deleteMessage(payload) {
        deleted.push(payload);
        return true;
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/menu@gatewaybot",
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
      message_thread_id: 2203,
    },
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "menu");
  assert.equal(edited.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_thread_id, 2203);
  assert.match(sent[0].text, /Topic control panel/u);
  assert.equal(pinned.length, 1);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].message_id, 6871);
  assert.equal(topicControlPanelStore.getState(session).menu_message_id, 6889);
});

test("handleIncomingCallbackQuery opens bot settings inside the topic control menu", async () => {
  const edited = [];
  const answered = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "root",
  });
  const session = createTopicSession();

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
      id: "cbq-topic-bots",
      data: "tcfg:n:b",
      from: { id: 5825672398, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1003577434463 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-menu-navigated");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.match(edited[0].text, /Bot settings|Настройки ботов/u);
  assert.equal(edited[0].reply_markup.inline_keyboard[0][0].text, "Spike model");
  assert.equal(edited[0].reply_markup.inline_keyboard.at(-1)[0].text, "Back");
  assert.equal(topicControlPanelStore.getState(session).active_screen, "bot_settings");
});

test("handleTopicControlCallbackQuery dispatches topic command buttons through the existing command surface", async () => {
  const answered = [];
  const dispatched = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "root",
  });
  const session = createTopicSession();

  const result = await handleTopicControlCallbackQuery({
    api: {
      async answerCallbackQuery(payload) {
        answered.push(payload);
      },
    },
    callbackQuery: {
      id: "cbq-topic-compact",
      data: "tcfg:cmd:compact",
      from: { id: 5825672398, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1003577434463 },
        message_thread_id: 55,
      },
    },
    config,
    dispatchCommand: async (payload) => {
      dispatched.push(payload);
    },
    promptFragmentAssembler: new PromptFragmentAssembler(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.reason, "topic-control-command-dispatched");
  assert.equal(answered.length, 1);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].commandText, "/compact");
  assert.equal(dispatched[0].chat.message_thread_id, 55);
});
