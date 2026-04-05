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
      from: { id: 5825672398, is_bot: false },
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
  assert.match(sent[0].text, /`первый queued prompt на проверку/u);
  assert.doesNotMatch(sent[0].text, /<code>/u);
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
      from: { id: 5825672398, is_bot: false },
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
  assert.match(sent[0].text, /Коротко: `второй prompt на удаление/u);
  assert.doesNotMatch(sent[0].text, /<code>/u);
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
      from: { id: 5825672398, is_bot: false },
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
  assert.match(sent[0].text, /Коротко: `Что на фото\?`/u);
  assert.doesNotMatch(sent[0].text, /<code>/u);
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
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 613,
      message_thread_id: 77,
    },
  });
  const secondResult = await handleIncomingMessage({
    ...commonArgs,
    message: {
      text: "tail fragment",
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 614,
      message_thread_id: 77,
    },
  });

  assert.equal(firstResult.reason, "queue-buffered");
  assert.equal(secondResult.reason, "queue-buffered");

  await waitFor(() => queued.length === 1);

  assert.equal(queued.length, 1);
  assert.match(queued[0].rawPrompt, new RegExp(`^${longHead}`));
  assert.match(queued[0].rawPrompt, /tail fragment/u);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Поставил в очередь/u);
  assert.doesNotMatch(sent[0].text, /<code>/u);
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
      from: { id: 5825672398, is_bot: false },
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
      from: { id: 5825672398, is_bot: false },
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
      from: { id: 5825672398, is_bot: false },
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


