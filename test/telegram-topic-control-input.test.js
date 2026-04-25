import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingCallbackQuery,
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";
import {
  buildIdleWorkerPool,
  config,
  createServiceState,
  createTopicControlPanelStore,
  createTopicSession,
  createTopicSessionService,
} from "../test-support/control-panel-fixtures.js";

test("topic control panel suffix flow applies manual input without side prompts", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "suffix",
  });
  const session = createTopicSession();
  const sessionService = createTopicSessionService(session);
  const promptFragmentAssembler = new PromptFragmentAssembler();

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
      id: "cbq-topic-suffix",
      data: "tcfg:s:input",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1001234567890 },
        message_thread_id: 55,
      },
    },
    config,
    promptFragmentAssembler,
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(callbackResult.reason, "topic-control-pending-input-started");
  assert.equal(topicControlPanelStore.getState(session).pending_input.kind, "suffix_text");
  assert.equal(sent.length, 0);
  assert.match(edited[0].text, /следующее текстовое сообщение|next text message/u);

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
    message: {
      text: "P.S.\nKeep it short in this topic.",
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 55,
    },
    promptFragmentAssembler,
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(replyResult.reason, "topic-control-pending-input-applied");
  assert.equal(topicControlPanelStore.getState(sessionService.getCurrentSession()).pending_input, null);
  assert.equal(sessionService.getCurrentSession().prompt_suffix_enabled, true);
  assert.equal(
    sessionService.getCurrentSession().prompt_suffix_text,
    "P.S.\nKeep it short in this topic.",
  );
  assert.equal(sent.length, 0);
  assert.equal(edited.length >= 2, true);
});

test("topic control panel custom wait reply flow applies the parsed local wait", async () => {
  const sent = [];
  const edited = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "wait",
  });
  const session = createTopicSession();
  const promptFragmentAssembler = new PromptFragmentAssembler();

  const callbackResult = await handleIncomingCallbackQuery({
    api: {
      async answerCallbackQuery() {},
      async editMessageText(payload) {
        edited.push(payload);
      },
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-topic-wait-custom",
      data: "tcfg:w:input",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1001234567890 },
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

  assert.equal(callbackResult.reason, "topic-control-pending-input-started");
  assert.equal(topicControlPanelStore.getState(session).pending_input.kind, "wait_custom");

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
    message: {
      text: "2m",
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 55,
      reply_to_message: { message_id: 91 },
    },
    promptFragmentAssembler,
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  const waitState = promptFragmentAssembler.getStateForMessage({
    chat: { id: -1001234567890 },
    from: { id: 123456789 },
    message_thread_id: 55,
  });

  assert.equal(replyResult.reason, "topic-control-pending-input-applied");
  assert.equal(topicControlPanelStore.getState(session).pending_input, null);
  assert.equal(waitState.local.active, true);
  assert.equal(waitState.local.flushDelayMs, 120000);
});

test("topic control panel does not swallow non-reply slash commands as pending input", async () => {
  const sent = [];
  const edited = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "suffix",
    pending_input: {
      kind: "suffix_text",
      requested_at: "2026-04-04T15:00:00.000Z",
      requested_by_user_id: "123456789",
      menu_message_id: 91,
      screen: "suffix",
    },
  });
  const session = createTopicSession();
  const sessionService = createTopicSessionService(session);

  const result = await handleIncomingMessage({
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
    message: {
      text: "/unknown",
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 55,
    },
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: createServiceState(),
    sessionService,
    topicControlPanelStore,
    workerPool: buildIdleWorkerPool(),
  });

  assert.notEqual(result.reason, "topic-control-pending-input-applied");
  assert.equal(topicControlPanelStore.getState(session).pending_input.kind, "suffix_text");
  assert.equal(sessionService.getCurrentSession().prompt_suffix_text, null);
  assert.equal(edited.length, 0);
  assert.equal(sent.length, 1);
});

test("topic control panel keeps pending reply target aligned when the menu message is recreated", async () => {
  const sent = [];
  const answered = [];
  const deleted = [];
  const topicControlPanelStore = createTopicControlPanelStore({
    menu_message_id: 91,
    active_screen: "suffix",
  });
  const session = createTopicSession();

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
        return { message_id: 92 };
      },
      async deleteMessage(payload) {
        deleted.push(payload);
      },
      async pinChatMessage() {
        return true;
      },
    },
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cbq-topic-recreate",
      data: "tcfg:s:input",
      from: { id: 123456789, is_bot: false },
      message: {
        message_id: 91,
        chat: { id: -1001234567890 },
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

  assert.equal(result.reason, "topic-control-pending-input-started");
  assert.equal(answered.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(deleted[0].message_id, 91);
  assert.equal(topicControlPanelStore.getState(session).menu_message_id, 92);
  assert.equal(topicControlPanelStore.getState(session).pending_input.menu_message_id, 92);
});
