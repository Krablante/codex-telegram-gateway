import test from "node:test";
import assert from "node:assert/strict";

import { handleIncomingMessage } from "../src/telegram/command-router.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";
import { PROMPT_FLOW_CONFIG as config } from "../test-support/prompt-flow-fixtures.js";

test("handleIncomingMessage uses plain /wait as a local one-shot window and resets after the flushed prompt", async () => {
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
  const session = {
    session_key: "-1001234567890:81",
    chat_id: "-1001234567890",
    topic_id: "82",
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
  const waitCommand = {
    text: "wait 600",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 910,
    message_thread_id: 82,
  };
  const attachmentMessage = {
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 911,
    message_thread_id: 82,
    media_group_id: "docs-2",
    document: {
      file_id: "file-1",
      file_unique_id: "uniq-file-1",
      file_name: "script.js",
      mime_type: "application/javascript",
      file_size: 128,
    },
  };
  const secondAttachmentMessage = {
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 912,
    message_thread_id: 82,
    media_group_id: "docs-2",
    document: {
      file_id: "file-2",
      file_unique_id: "uniq-file-2",
      file_name: "notes.md",
      mime_type: "text/markdown",
      file_size: 96,
    },
  };
  const textMessage = {
    text: "Ура!!! Значит всё работает отлично",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 913,
    message_thread_id: 82,
  };
  const secondTextMessage = {
    text: "Теперь я тестирую wait окно.",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 914,
    message_thread_id: 82,
  };
  const flushMessage = {
    text: "Все",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 915,
    message_thread_id: 82,
  };
  const followUpTextMessage = {
    text: "Это уже следующий prompt без повторного /wait.",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 916,
    message_thread_id: 82,
  };

  const commonArgs = {
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    promptFragmentAssembler,
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return {
          ...session,
          session_key: `-1001234567890:${attachmentMessage.message_thread_id}`,
          topic_id: String(attachmentMessage.message_thread_id),
        };
      },
      async ensureRunnableSessionForMessage(message) {
        return {
          ...session,
          session_key: `-1001234567890:${message.message_thread_id}`,
          topic_id: String(message.message_thread_id),
        };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments(_api, _session, message) {
        if (message.message_id === attachmentMessage.message_id) {
          return [
            {
              file_path: "/tmp/script.js",
              is_image: false,
              mime_type: "application/javascript",
              size_bytes: 128,
            },
          ];
        }

        if (message.message_id === secondAttachmentMessage.message_id) {
          return [
            {
              file_path: "/tmp/notes.md",
              is_image: false,
              mime_type: "text/markdown",
              size_bytes: 96,
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

  const waitResult = await handleIncomingMessage({
    ...commonArgs,
    message: waitCommand,
  });
  const attachmentResult = await handleIncomingMessage({
    ...commonArgs,
    message: attachmentMessage,
  });
  const secondAttachmentResult = await handleIncomingMessage({
    ...commonArgs,
    message: secondAttachmentMessage,
  });
  const textResult = await handleIncomingMessage({
    ...commonArgs,
    message: textMessage,
  });
  const secondTextResult = await handleIncomingMessage({
    ...commonArgs,
    message: secondTextMessage,
  });
  const flushResult = await handleIncomingMessage({
    ...commonArgs,
    message: flushMessage,
  });
  const followUpTextResult = await handleIncomingMessage({
    ...commonArgs,
    message: followUpTextMessage,
  });

  assert.equal(waitResult.command, "wait");
  assert.match(sent[0].text, /status: on/u);
  assert.equal(attachmentResult.reason, "prompt-buffered");
  assert.equal(secondAttachmentResult.reason, "prompt-buffered");
  assert.equal(textResult.reason, "prompt-buffered");
  assert.equal(secondTextResult.reason, "prompt-buffered");
  assert.equal(flushResult.reason, "prompt-buffer-flushed");
  assert.equal(followUpTextResult.reason, "prompt-started");
  assert.equal(startedRuns.length, 2);
  assert.equal(
    startedRuns[0].rawPrompt,
    `${textMessage.text}\n\n${secondTextMessage.text}`,
  );
  assert.equal(startedRuns[0].attachments.length, 2);
  assert.equal(startedRuns[0].message.message_id, secondTextMessage.message_id);
  assert.equal(startedRuns[0].session.topic_id, "82");
  assert.equal(startedRuns[1].rawPrompt, followUpTextMessage.text);
  assert.equal(startedRuns[1].attachments.length, 0);
  assert.equal(startedRuns[1].message.message_id, followUpTextMessage.message_id);
  assert.equal(startedRuns[1].session.topic_id, "82");
});

test("handleIncomingMessage keeps /wait global persistent across topics", async () => {
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
  const waitCommand = {
    text: "/wait global 600",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 920,
    message_thread_id: 81,
    entities: [{ type: "bot_command", offset: 0, length: 5 }],
  };
  const firstTopicMessage = {
    text: "first buffered part",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 921,
    message_thread_id: 82,
  };
  const secondTopicMessage = {
    text: "second buffered part",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 922,
    message_thread_id: 83,
  };
  const flushMessage = {
    text: "Все",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 923,
    message_thread_id: 84,
  };

  const commonArgs = {
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    promptFragmentAssembler,
    serviceState,
    sessionService: {
      async ensureSessionForMessage(message) {
        return {
          session_key: `-1001234567890:${message.message_thread_id}`,
          chat_id: "-1001234567890",
          topic_id: String(message.message_thread_id),
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
      },
      async ensureRunnableSessionForMessage(message) {
        return {
          session_key: `-1001234567890:${message.message_thread_id}`,
          chat_id: "-1001234567890",
          topic_id: String(message.message_thread_id),
          lifecycle_state: "active",
          workspace_binding: {
            repo_root: "/srv/codex-workspace",
            cwd: "/srv/codex-workspace",
            branch: "main",
            worktree_path: "/srv/codex-workspace",
          },
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

  const waitResult = await handleIncomingMessage({
    ...commonArgs,
    message: waitCommand,
  });
  const firstResult = await handleIncomingMessage({
    ...commonArgs,
    message: firstTopicMessage,
  });
  const secondResult = await handleIncomingMessage({
    ...commonArgs,
    message: secondTopicMessage,
  });
  const flushResult = await handleIncomingMessage({
    ...commonArgs,
    message: flushMessage,
  });

  assert.equal(waitResult.command, "wait");
  assert.match(sent[0].text, /scope: global/u);
  assert.equal(firstResult.reason, "prompt-buffered");
  assert.equal(secondResult.reason, "prompt-buffered");
  assert.equal(flushResult.reason, "prompt-buffer-flushed");
  assert.equal(startedRuns.length, 1);
  assert.equal(
    startedRuns[0].rawPrompt,
    `${firstTopicMessage.text}\n\n${secondTopicMessage.text}`,
  );
});
