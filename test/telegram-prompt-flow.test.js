import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { PROMPT_FLOW_CONFIG as config } from "../test-support/prompt-flow-fixtures.js";

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
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
      message_thread_id: 77,
    },
    serviceState,
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1003577434463:77",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
    },
    workerPool: {
      async startPromptRun({ prompt, session }) {
        assert.equal(prompt, "run a quick task");
        assert.equal(session.session_key, "-1003577434463:77");
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage refuses to auto-reactivate a purged topic for direct prompts", async () => {
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
      text: "continue",
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
      message_thread_id: 770,
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
          session_key: "-1003577434463:770",
          lifecycle_state: "purged",
          topic_name: "Purged topic",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
    },
    workerPool: {
      async startPromptRun() {
        throw new Error("purged topic should not start a run");
      },
    },
  });

  assert.equal(result.reason, "purged-session");
  assert.match(sent[0].text, /очищена|cleared/i);
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
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
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
          session_key: "-1003577434463:77",
          auto_mode: {
            enabled: true,
            phase: "running",
            omni_bot_id: "8603043042",
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
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
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
          session_key: "-1003577434463:78",
          chat_id: "-1003577434463",
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

test("handleIncomingMessage buffers long prompt fragments without reactivating the topic session", async () => {
  const enqueued = [];
  let ensuredSessionCount = 0;
  let ensuredRunnableCount = 0;

  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("buffered fragments should not send a reply yet");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "part 1 of a very long prompt",
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
      message_thread_id: 79,
    },
    promptFragmentAssembler: {
      getStateForMessage() {
        return {
          active: false,
          mode: "auto",
          messageCount: 0,
        };
      },
      hasPendingForSameTopicMessage() {
        return false;
      },
      shouldBufferMessage() {
        return true;
      },
      enqueue(entry) {
        enqueued.push(entry);
      },
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        ensuredSessionCount += 1;
        return {
          session_key: "-1003577434463:79",
          lifecycle_state: "parked",
          auto_mode: {
            enabled: false,
          },
        };
      },
      async ensureRunnableSessionForMessage() {
        ensuredRunnableCount += 1;
        throw new Error("buffer-only flow should not reactivate the session");
      },
    },
    workerPool: {
      async startPromptRun() {
        throw new Error("buffer-only flow should not start a run");
      },
    },
  });

  assert.equal(result.reason, "prompt-buffered");
  assert.equal(ensuredSessionCount, 1);
  assert.equal(ensuredRunnableCount, 0);
  assert.equal(enqueued.length, 1);
});
