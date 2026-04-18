import test from "node:test";
import assert from "node:assert/strict";

import {
  applyPromptSuffix,
  handleIncomingCallbackQuery,
  handleIncomingMessage,
} from "../src/telegram/command-router.js";

const config = {
  telegramAllowedUserId: "5825672398",
  telegramAllowedUserIds: ["5825672398"],
  telegramAllowedBotIds: ["8603043042"],
  telegramForumChatId: "-1003577434463",
  maxParallelSessions: 4,
  codexModel: "gpt-5.4",
  codexReasoningEffort: "medium",
  codexContextWindow: 320000,
  codexAutoCompactTokenLimit: 300000,
  codexConfigPath: "/tmp/codex-telegram-gateway-tests-missing-config.toml",
};

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

test("handleIncomingMessage lets zooService short-circuit /zoo before normal session flow", async () => {
  const sent = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  let zooCalls = 0;

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 501 };
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/zoo",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("normal session flow should not run");
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
    zooService: {
      async maybeHandleIncomingMessage() {
        zooCalls += 1;
        return {
          handled: true,
          command: "zoo",
          reason: "zoo-topic-opened",
          ackText: "Zoo topic is ready.",
        };
      },
    },
  });

  assert.equal(zooCalls, 1);
  assert.equal(result.reason, "zoo-topic-opened");
  assert.equal(serviceState.lastCommandName, "zoo");
  assert.equal(sent[0].text, "Zoo topic is ready.");
});

test("handleIncomingCallbackQuery lets zooService short-circuit before panel callbacks", async () => {
  const result = await handleIncomingCallbackQuery({
    api: {},
    botUsername: "gatewaybot",
    callbackQuery: {
      id: "cb1",
      data: "zoo:v:pet1",
      from: { id: 5825672398, is_bot: false },
      message: {
        chat: { id: -1003577434463 },
        message_thread_id: 777,
      },
    },
    config,
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {},
    workerPool: {},
    zooService: {
      async handleCallbackQuery() {
        return {
          handled: true,
          reason: "zoo-pet-opened",
        };
      },
    },
  });

  assert.equal(result.reason, "zoo-pet-opened");
});
