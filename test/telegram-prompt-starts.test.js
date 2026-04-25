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

test("handleIncomingMessage keeps suffix guidance out of the user prompt body", async () => {
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
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          prompt_suffix_enabled: true,
          prompt_suffix_text:
            "P.S.\nKeep it short and never overcomplicate anything.",
        };
      },
    },
    workerPool: {
      async startPromptRun({ prompt }) {
        assert.equal(
          prompt,
          "User Prompt:\nrun a quick task",
        );
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage reports a bound host as unavailable by name", async () => {
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
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          execution_host_id: "worker-a",
          execution_host_label: "worker-a",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
    },
    workerPool: {
      async startPromptRun() {
        return {
          ok: false,
          reason: "host-unavailable",
          hostId: "worker-a",
          hostLabel: "worker-a",
        };
      },
    },
  });

  assert.equal(result.reason, "host-unavailable");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Хост worker-a сейчас недоступен/u);
});

test("handleIncomingMessage fails closed when a topic lost its saved host binding", async () => {
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
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 770,
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
          session_key: "-1001234567890:770",
          created_via: "topic/implicit-attach",
          execution_host_id: null,
          execution_host_label: null,
          execution_host_last_failure: "binding-missing",
          ui_language: "rus",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
    },
    workerPool: {
      async startPromptRun() {
        throw new Error("should not start a run without a saved host binding");
      },
    },
  });

  assert.equal(result.reason, "missing-topic-binding");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /нет безопасно сохранённой привязки/u);
});

test("handleIncomingMessage keeps topic suffix overrides out of the user prompt body", async () => {
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
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          prompt_suffix_enabled: true,
          prompt_suffix_text: "TOPIC\nKeep it short in this thread.",
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: true,
          prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
        };
      },
    },
    workerPool: {
      async startPromptRun({ prompt }) {
        assert.equal(
          prompt,
          "User Prompt:\nrun a quick task",
        );
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage suppresses both topic and global suffixes when topic routing is off", async () => {
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
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          prompt_suffix_topic_enabled: false,
          prompt_suffix_enabled: true,
          prompt_suffix_text: "TOPIC\nKeep it short in this thread.",
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: true,
          prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
        };
      },
    },
    workerPool: {
      async startPromptRun({ prompt }) {
        assert.equal(prompt, "User Prompt:\nrun a quick task");
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage starts codex run for captioned photo in a topic", async () => {
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
      caption: "Что на фото?",
      photo: [
        { file_id: "small-photo", file_unique_id: "small", file_size: 10 },
        { file_id: "large-photo", file_unique_id: "large", file_size: 20 },
      ],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 501,
      message_thread_id: 77,
    },
    serviceState,
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:77",
          chat_id: "-1001234567890",
          topic_id: "77",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
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
    },
    workerPool: {
      async startPromptRun({ prompt, session, attachments }) {
        assert.equal(prompt, "User Prompt:\nЧто на фото?");
        assert.equal(session.session_key, "-1001234567890:77");
        assert.equal(attachments.length, 1);
        assert.equal(attachments[0].file_path, "/tmp/incoming-photo.jpg");
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage keeps suffix guidance out of captioned media prompts", async () => {
  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("should not send reply on successful prompt start");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      caption: "Что на фото?",
      photo: [
        { file_id: "small-photo", file_unique_id: "small", file_size: 10 },
        { file_id: "large-photo", file_unique_id: "large", file_size: 20 },
      ],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 501,
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
          prompt_suffix_enabled: true,
          prompt_suffix_text: "P.S.\nAnswer briefly.",
        };
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
    },
    workerPool: {
      async startPromptRun({ prompt, attachments }) {
        assert.equal(
          prompt,
          "User Prompt:\nЧто на фото?",
        );
        assert.equal(attachments.length, 1);
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage auto-assembles Telegram media groups into one run", async () => {
  const startedRuns = [];
  const promptFragmentAssembler = new PromptFragmentAssembler({
    flushDelayMs: 20,
    flushGraceMs: 5,
    longPromptThresholdChars: 3000,
  });
  const session = {
    session_key: "-1001234567890:86",
    chat_id: "-1001234567890",
    topic_id: "86",
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
  const firstMessage = {
    caption: "Разбери оба файла вместе.",
    media_group_id: "docs-1",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 970,
    message_thread_id: 86,
    document: {
      file_id: "doc-1",
      file_unique_id: "doc-1",
      file_name: "a.md",
      mime_type: "text/markdown",
      file_size: 64,
    },
  };
  const secondMessage = {
    media_group_id: "docs-1",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 971,
    message_thread_id: 86,
    document: {
      file_id: "doc-2",
      file_unique_id: "doc-2",
      file_name: "b.md",
      mime_type: "text/markdown",
      file_size: 72,
    },
  };

  const commonArgs = {
    api: {
      async sendMessage() {},
    },
    botUsername: "gatewaybot",
    config,
    promptFragmentAssembler,
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return session;
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments(_api, _session, message) {
        if (message.message_id === firstMessage.message_id) {
          return [
            {
              kind: "document",
              file_path: "/tmp/a.md",
              is_image: false,
              mime_type: "text/markdown",
              size_bytes: 64,
            },
          ];
        }

        if (message.message_id === secondMessage.message_id) {
          return [
            {
              kind: "document",
              file_path: "/tmp/b.md",
              is_image: false,
              mime_type: "text/markdown",
              size_bytes: 72,
            },
          ];
        }

        return [];
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

  await waitFor(() => startedRuns.length === 1);

  assert.equal(startedRuns.length, 1);
  assert.equal(startedRuns[0].rawPrompt, firstMessage.caption);
  assert.equal(startedRuns[0].attachments.length, 2);
  assert.deepEqual(
    startedRuns[0].attachments.map((attachment) => attachment.file_path),
    ["/tmp/a.md", "/tmp/b.md"],
  );
});

test("handleIncomingMessage queues a follow-up when live steer is temporarily unavailable", async () => {
  const sent = [];
  const queuedPayloads = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "докинь это в текущий run",
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 780,
      message_thread_id: 91,
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
          session_key: "-1001234567890:91",
          chat_id: "-1001234567890",
          topic_id: "91",
          ui_language: "rus",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async enqueuePromptQueue(_session, payload) {
        queuedPayloads.push(payload);
        return { position: 1 };
      },
    },
    workerPool: {
      async startPromptRun() {
        return { ok: false, reason: "busy" };
      },
      async steerActiveRun() {
        return { ok: false, reason: "steer-unavailable" };
      },
    },
  });

  assert.equal(result.reason, "steer-deferred");
  assert.equal(queuedPayloads.length, 1);
  assert.equal(queuedPayloads[0].rawPrompt, "докинь это в текущий run");
  assert.equal(queuedPayloads[0].prompt, "User Prompt:\nдокинь это в текущий run");
  assert.equal(queuedPayloads[0].replyToMessageId, 780);
  assert.match(sent[0].text, /live steer недоступен/u);
  assert.match(sent[0].text, /следующим prompt/u);
});

test("handleIncomingMessage queues a follow-up instead of sending the generic busy reply after steer-failed", async () => {
  const sent = [];
  const queuedPayloads = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "докинь несмотря на временный steer fail",
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 782,
      message_thread_id: 93,
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
          session_key: "-1001234567890:93",
          chat_id: "-1001234567890",
          topic_id: "93",
          ui_language: "rus",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async enqueuePromptQueue(_session, payload) {
        queuedPayloads.push(payload);
        return { position: 1 };
      },
    },
    workerPool: {
      async startPromptRun() {
        return { ok: false, reason: "busy" };
      },
      async steerActiveRun() {
        return { ok: false, reason: "steer-failed" };
      },
    },
  });

  assert.equal(result.reason, "steer-deferred");
  assert.equal(queuedPayloads.length, 1);
  assert.doesNotMatch(sent[0].text, /Я ещё работаю/u);
  assert.match(sent[0].text, /live steer недоступен/u);
});

test("handleIncomingMessage queues a follow-up after steer-timeout instead of wedging the topic", async () => {
  const sent = [];
  const queuedPayloads = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "докинь это после зависшего steer",
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 783,
      message_thread_id: 94,
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
          session_key: "-1001234567890:94",
          chat_id: "-1001234567890",
          topic_id: "94",
          ui_language: "rus",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async enqueuePromptQueue(_session, payload) {
        queuedPayloads.push(payload);
        return { position: 1 };
      },
    },
    workerPool: {
      async startPromptRun() {
        return { ok: false, reason: "busy" };
      },
      async steerActiveRun() {
        return { ok: false, reason: "steer-timeout" };
      },
    },
  });

  assert.equal(result.reason, "steer-deferred");
  assert.equal(queuedPayloads.length, 1);
  assert.equal(queuedPayloads[0].rawPrompt, "докинь это после зависшего steer");
  assert.match(sent[0].text, /live steer недоступен/u);
});

test("handleIncomingMessage immediately starts the queued follow-up when the busy run already cleared", async () => {
  const drainCalls = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage() {
        throw new Error("should not send reply when queued follow-up starts immediately");
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "докинь это сразу после гонки",
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_id: 781,
      message_thread_id: 92,
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
          session_key: "-1001234567890:92",
          chat_id: "-1001234567890",
          topic_id: "92",
          ui_language: "rus",
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async enqueuePromptQueue() {
        return { position: 1 };
      },
      async drainPromptQueue(workerPoolArg, { session }) {
        drainCalls.push({
          workerPoolArg,
          sessionKey: session.session_key,
        });
        return [
          {
            sessionKey: session.session_key,
            result: { handled: true, reason: "prompt-started" },
          },
        ];
      },
    },
    workerPool: {
      async startPromptRun() {
        return { ok: false, reason: "busy" };
      },
      async steerActiveRun() {
        return { ok: false, reason: "idle" };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
  assert.equal(drainCalls.length, 1);
  assert.equal(drainCalls[0].sessionKey, "-1001234567890:92");
});
