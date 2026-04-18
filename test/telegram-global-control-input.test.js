import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingCallbackQuery,
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";
import { PROMPT_SUFFIX_MAX_CHARS } from "../src/session-manager/prompt-suffix.js";
import {
  buildIdleWorkerPool,
  config,
  createGlobalControlPanelStore,
  createGlobalControlSessionService,
} from "../test-support/control-panel-fixtures.js";

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
  const sessionService = createGlobalControlSessionService();

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
      from: { id: 5825672398, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1003577434463 },
      },
    },
    config,
    globalControlPanelStore: store,
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool: buildIdleWorkerPool(),
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
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
      reply_to_message: { message_id: 901 },
    },
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(replyResult.reason, "global-control-pending-input-applied");
  assert.equal(store.getState().pending_input, null);
  assert.match(sent.at(-1).text, /Global prompt suffix updated/u);
  assert.equal(edited.length >= 2, true);
});

test("global control panel keeps literal suffix text like off instead of reinterpreting it as a command", async () => {
  const sent = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
    pending_input: {
      kind: "suffix_text",
      requested_at: "2026-04-04T15:00:00.000Z",
      requested_by_user_id: "5825672398",
      menu_message_id: 901,
      screen: "suffix",
    },
  });
  const sessionService = createGlobalControlSessionService();

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
      async editMessageText() {
        return { ok: true };
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: store,
    message: {
      text: "off",
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
      reply_to_message: { message_id: 901 },
    },
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

  assert.equal(result.reason, "global-control-pending-input-applied");
  const suffixState = await sessionService.getGlobalPromptSuffix();
  assert.equal(suffixState.prompt_suffix_text, "off");
  assert.equal(suffixState.prompt_suffix_enabled, true);
  assert.match(sent.at(-1).text, /text: set/u);
});

test("handleIncomingCallbackQuery clears pending global panel input", async () => {
  const sent = [];
  const edited = [];
  const answered = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
    pending_input: {
      kind: "suffix_text",
      requested_at: "2026-04-04T15:00:00.000Z",
      requested_by_user_id: "5825672398",
      menu_message_id: 901,
      screen: "suffix",
    },
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
      id: "cbq-pending-clear",
      data: "gcfg:p:clear",
      from: { id: 5825672398, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1003577434463 },
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

  assert.equal(result.reason, "global-control-pending-input-cleared");
  assert.equal(answered.length, 1);
  assert.equal(edited.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(store.getState().pending_input, null);
  assert.match(sent[0].text, /Pending manual input cleared|Ожидание ручного ввода очищено/u);
});

test("global control panel rejects overly long suffix replies", async () => {
  const sent = [];
  const tooLongSuffix = "x".repeat(PROMPT_SUFFIX_MAX_CHARS + 1);
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
    pending_input: {
      kind: "suffix_text",
      requested_at: "2026-04-04T15:00:00.000Z",
      requested_by_user_id: "5825672398",
      menu_message_id: 901,
      screen: "suffix",
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
    globalControlPanelStore: store,
    message: {
      text: tooLongSuffix,
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
      reply_to_message: { message_id: 901 },
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

  assert.equal(result.reason, "global-control-suffix-too-long");
  assert.equal(store.getState().pending_input.kind, "suffix_text");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, new RegExp(`max_chars: ${PROMPT_SUFFIX_MAX_CHARS}`, "u"));
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
      from: { id: 5825672398, is_bot: false },
      message: {
        message_id: 901,
        chat: { id: -1003577434463 },
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

  assert.equal(result.reason, "global-control-pending-input-started");
  assert.equal(answered.length, 1);
  assert.equal(sent.length, 2);
  assert.equal(store.getState().menu_message_id, 902);
  assert.equal(store.getState().pending_input.menu_message_id, 902);
});
