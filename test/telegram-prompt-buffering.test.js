import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";
import { PROMPT_FLOW_CONFIG as config } from "../test-support/prompt-flow-fixtures.js";

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
