import test from "node:test";
import assert from "node:assert/strict";

import {
  handleIncomingMessage,
} from "../src/telegram/command-router.js";
import {
  preparePromptRoutingContext,
} from "../src/telegram/command-handlers/prompt-flow-routing.js";
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
      from: { id: 123456789, is_bot: false },
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

test("handleIncomingMessage queues prompts after purged topic reactivation", async () => {
  const sent = [];
  const enqueued = [];

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
      text: "/q continue",
      entities: [{ type: "bot_command", offset: 0, length: 2 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 6111,
      message_thread_id: 771,
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
          session_key: "-1001234567890:771",
          lifecycle_state: "active",
          topic_name: "Purged queue topic",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async recordHandledSession() {},
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:771",
          lifecycle_state: "active",
          topic_name: "Purged queue topic",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
          codex_thread_id: null,
          provider_session_id: null,
          codex_rollout_path: null,
          last_context_snapshot: null,
        };
      },
      async enqueuePromptQueue(session, payload) {
        enqueued.push({ session, payload });
        return { position: 2, size: 2 };
      },
    },
    workerPool: {},
  });

  assert.equal(result.reason, "prompt-queued");
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].session.lifecycle_state, "active");
  assert.match(sent[0].text, /Queued|Очередь|очеред/i);
});

test("handleIncomingMessage does not reactivate purged topic for blank /q usage", async () => {
  const sent = [];
  let ensureRunnableCalls = 0;
  const purgedSession = {
    session_key: "-1001234567890:771",
    lifecycle_state: "purged",
    topic_name: "Purged queue topic",
    ui_language: "rus",
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
      text: "/q",
      entities: [{ type: "bot_command", offset: 0, length: 2 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 6113,
      message_thread_id: 771,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return purgedSession;
      },
      async recordHandledSession() {},
      async ensureRunnableSessionForMessage() {
        ensureRunnableCalls += 1;
        return { ...purgedSession, lifecycle_state: "active" };
      },
    },
    workerPool: {},
  });

  assert.equal(result.reason, "queue-usage");
  assert.equal(ensureRunnableCalls, 0);
  assert.match(sent[0].text, /\/q/u);
});

test("handleIncomingMessage buffers long /q after purge without reactivation", async () => {
  const queuePromptAssembler = new PromptFragmentAssembler({
    flushDelayMs: 1000,
    flushGraceMs: 10,
    longPromptThresholdChars: 100,
  });
  let ensureRunnableCalls = 0;
  const purgedSession = {
    session_key: "-1001234567890:771",
    lifecycle_state: "purged",
    topic_name: "Purged queue topic",
    ui_language: "rus",
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        return { message_id: 1 };
      },
    },
    botUsername: "gatewaybot",
    config,
    queuePromptAssembler,
    message: {
      text: `/q ${"A".repeat(200)}`,
      entities: [{ type: "bot_command", offset: 0, length: 2 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 6114,
      message_thread_id: 771,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return purgedSession;
      },
      async recordHandledSession() {},
      async ensureRunnableSessionForMessage() {
        ensureRunnableCalls += 1;
        return { ...purgedSession, lifecycle_state: "active" };
      },
    },
    workerPool: {},
  });

  assert.equal(result.reason, "queue-buffered");
  assert.equal(ensureRunnableCalls, 0);
});

test("handleIncomingMessage keeps attachment-only /q after purge non-reactivating", async () => {
  const sent = [];
  const buffered = [];
  let ensureRunnableCalls = 0;
  const purgedSession = {
    session_key: "-1001234567890:771",
    lifecycle_state: "purged",
    topic_name: "Purged queue topic",
    ui_language: "rus",
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
      caption: "/q",
      caption_entities: [{ type: "bot_command", offset: 0, length: 2 }],
      photo: [
        { file_id: "queue-photo", file_unique_id: "queue-photo", file_size: 10 },
      ],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 6115,
      message_thread_id: 771,
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return purgedSession;
      },
      async recordHandledSession() {},
      async ensureRunnableSessionForMessage() {
        ensureRunnableCalls += 1;
        return { ...purgedSession, lifecycle_state: "active" };
      },
      async ingestIncomingAttachments() {
        return [
          {
            kind: "photo",
            file_path: "/tmp/queue-photo.jpg",
            is_image: true,
          },
        ];
      },
      async bufferPendingPromptAttachments(_session, attachments, options) {
        buffered.push({ attachments, options });
      },
    },
    workerPool: {},
  });

  assert.equal(result.reason, "queue-attachment-without-prompt");
  assert.equal(ensureRunnableCalls, 0);
  assert.equal(buffered.length, 1);
  assert.match(sent[0].text, /текст|caption|подпись/iu);
});

test("handleIncomingMessage fails closed for /q when a topic lost its saved host binding", async () => {
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
      text: "/q continue",
      entities: [{ type: "bot_command", offset: 0, length: 2 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 6112,
      message_thread_id: 772,
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
          session_key: "-1001234567890:772",
          lifecycle_state: "active",
          created_via: "topic/implicit-attach",
          execution_host_id: null,
          execution_host_label: null,
          execution_host_last_failure: "binding-missing",
          ui_language: "rus",
        };
      },
      async recordHandledSession() {},
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:772",
          lifecycle_state: "active",
          created_via: "topic/implicit-attach",
          execution_host_id: null,
          execution_host_label: null,
          execution_host_last_failure: "binding-missing",
          ui_language: "rus",
        };
      },
    },
    workerPool: {},
  });

  assert.equal(result.reason, "missing-topic-binding");
  assert.match(sent[0].text, /нет безопасно сохранённой привязки/u);
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
      from: { id: 123456789, is_bot: false },
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
      from: { id: 123456789, is_bot: false },
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

test("handleIncomingMessage reports host-unavailable instead of fake /q success when immediate drain fails closed", async () => {
  const sent = [];
  const session = {
    session_key: "-1001234567890:77",
    chat_id: "-1001234567890",
    topic_id: "77",
    execution_host_id: "worker-a",
    execution_host_label: "worker-a",
    lifecycle_state: "active",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
    workspace_binding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
      text: "/q продолжи после пробуждения хоста",
      entities: [{ type: "bot_command", offset: 0, length: 2 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 613,
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
      async enqueuePromptQueue() {
        return {
          position: 1,
          size: 1,
        };
      },
      async drainPromptQueue() {
        return [
          {
            sessionKey: session.session_key,
            result: {
              reason: "host-unavailable",
              hostId: "worker-a",
              hostLabel: "worker-a",
            },
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
        return null;
      },
    },
  });

  assert.equal(result.reason, "host-unavailable");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /worker-a/u);
  assert.match(sent[0].text, /недоступен/u);
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 613,
      message_thread_id: 77,
    },
  });
  const secondResult = await handleIncomingMessage({
    ...commonArgs,
    message: {
      text: "tail fragment",
      from: { id: 123456789, is_bot: false },
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

test("preparePromptRoutingContext treats blank /q as a queue-buffer flush only", async () => {
  let flushed = false;
  const result = await preparePromptRoutingContext({
    botUsername: "gatewaybot",
    message: {
      text: "/q",
      entities: [{ type: "bot_command", offset: 0, length: 2 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 615,
      message_thread_id: 77,
    },
    queuePromptAssembler: {
      hasPendingForSameTopicMessage() {
        return true;
      },
      async flushPendingForMessage() {
        flushed = true;
        return true;
      },
    },
  });

  assert.equal(flushed, true);
  assert.deepEqual(result.handledResult, {
    handled: true,
    reason: "queue-buffer-flushed",
  });
});

test("handleIncomingMessage stores prompt suffix text via /suffix", async () => {
  const sent = [];
  const session = {
    session_key: "-1001234567890:77",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
    lifecycle_state: "active",
    workspace_binding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
      from: { id: 123456789, is_bot: false },
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
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
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
      from: { id: 123456789, is_bot: false },
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
