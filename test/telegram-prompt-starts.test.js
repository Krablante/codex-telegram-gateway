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

test("handleIncomingMessage appends configured prompt suffix before starting a run", async () => {
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
          "run a quick task\n\nP.S.\nKeep it short and never overcomplicate anything.",
        );
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage lets topic prompt suffix override global prompt suffix", async () => {
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
          "run a quick task\n\nTOPIC\nKeep it short in this thread.",
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
        assert.equal(prompt, "run a quick task");
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
      from: { id: 1234567890, is_bot: false },
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
        assert.equal(prompt, "Что на фото?");
        assert.equal(session.session_key, "-1001234567890:77");
        assert.equal(attachments.length, 1);
        assert.equal(attachments[0].file_path, "/tmp/incoming-photo.jpg");
        return { ok: true };
      },
    },
  });

  assert.equal(result.reason, "prompt-started");
});

test("handleIncomingMessage appends prompt suffix to captioned media prompts", async () => {
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
      from: { id: 1234567890, is_bot: false },
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
          "Что на фото?\n\nP.S.\nAnswer briefly.",
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
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
  };
  const firstMessage = {
    caption: "Разбери оба файла вместе.",
    media_group_id: "docs-1",
    from: { id: 1234567890, is_bot: false },
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
    from: { id: 1234567890, is_bot: false },
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


