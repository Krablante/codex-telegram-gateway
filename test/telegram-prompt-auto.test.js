import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";
import {
  PROMPT_FLOW_CONFIG as config,
  waitFor,
} from "../test-support/prompt-flow-fixtures.js";

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
          auto_mode: {
            enabled: false,
            phase: "off",
            omni_bot_id: "2234567890",
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
      from: { id: 1234567890, is_bot: false },
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
      from: { id: 1234567890, is_bot: false },
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
          auto_mode: {
            enabled: true,
            phase: "running",
            omni_bot_id: "2234567890",
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
      from: { id: 1234567890, is_bot: false },
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
            omni_bot_id: "2234567890",
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
          auto_mode: {
            enabled: true,
            phase: "running",
            omni_bot_id: "2234567890",
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
      from: { id: 2234567890, is_bot: true },
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
            omni_bot_id: "2234567890",
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
      from: { id: 2234567890, is_bot: true },
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
            omni_bot_id: "2234567890",
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
      from: { id: 2234567890, is_bot: true },
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
            omni_bot_id: "2234567890",
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


