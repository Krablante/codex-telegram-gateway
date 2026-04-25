import test from "node:test";
import assert from "node:assert/strict";

import { handleIncomingMessage } from "../src/telegram/command-router.js";
import { PROMPT_FLOW_CONFIG as config } from "../test-support/prompt-flow-fixtures.js";

test("handleIncomingMessage asks for caption when media arrives without text", async () => {
  const sent = [];
  let bufferedSession = null;

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      photo: [{ file_id: "photo-1", file_unique_id: "photo-1", file_size: 10 }],
      from: { id: 123456789, is_bot: false },
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
      async ensureSessionForMessage() {
        return {
          session_key: "-1001234567890:78",
          chat_id: "-1001234567890",
          topic_id: "78",
          lifecycle_state: "active",
          ui_language: "rus",
        };
      },
      async ensureRunnableSessionForMessage() {
        return {
          session_key: "-1001234567890:78",
          chat_id: "-1001234567890",
          topic_id: "78",
          lifecycle_state: "active",
          ui_language: "rus",
        };
      },
      async ingestIncomingAttachments() {
        return [
          {
            file_path: "/tmp/incoming-photo.jpg",
            relative_path: "incoming/incoming-photo.jpg",
            mime_type: "image/jpeg",
            size_bytes: 10,
            is_image: true,
          },
        ];
      },
      async bufferPendingPromptAttachments(session, attachments) {
        bufferedSession = { session, attachments };
      },
    },
    workerPool: {
      async startPromptRun() {
        throw new Error("should not start");
      },
    },
  });

  assert.equal(result.reason, "attachment-without-caption");
  assert.equal(bufferedSession.attachments.length, 1);
  assert.match(sent[0].text, /Добавь подпись/u);
  assert.match(sent[0].text, /следующим сообщением/u);
});

test("handleIncomingMessage carries attachment-only message into the next text prompt in the same topic", async () => {
  const sent = [];
  const startedRuns = [];
  const pendingByTopic = new Map();
  const session = {
    session_key: "-1001234567890:88",
    chat_id: "-1001234567890",
    topic_id: "88",
    lifecycle_state: "active",
    ui_language: "rus",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
    workspace_binding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  };
  const attachmentMessage = {
    document: {
      file_id: "file-1",
      file_unique_id: "uniq-file-1",
      file_name: "ai_studio_code.txt",
      mime_type: "text/plain",
      file_size: 12345,
    },
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 2001,
    message_thread_id: 88,
  };
  const textMessage = {
    text: "Переделай это в нормальный формат и влепи в ридмишку.",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 2002,
    message_thread_id: 88,
  };

  const commonArgs = {
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return { ...session };
      },
      async ensureRunnableSessionForMessage() {
        return { ...session };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments(_api, _session, message) {
        if (message.message_id !== attachmentMessage.message_id) {
          return [];
        }

        return [
          {
            file_path: "/tmp/ai_studio_code.txt",
            relative_path: "incoming/ai_studio_code.txt",
            mime_type: "text/plain",
            size_bytes: 12345,
            is_image: false,
          },
        ];
      },
      async bufferPendingPromptAttachments(currentSession, attachments) {
        pendingByTopic.set(currentSession.topic_id, attachments);
        return {
          ...currentSession,
          pending_prompt_attachments: attachments,
          pending_prompt_attachments_expires_at: "2026-03-31T16:00:00.000Z",
        };
      },
      async getPendingPromptAttachments(currentSession) {
        return pendingByTopic.get(currentSession.topic_id) || [];
      },
      async clearPendingPromptAttachments(currentSession) {
        pendingByTopic.delete(currentSession.topic_id);
        return {
          ...currentSession,
          pending_prompt_attachments: [],
          pending_prompt_attachments_expires_at: null,
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
  };

  const attachmentResult = await handleIncomingMessage({
    ...commonArgs,
    message: attachmentMessage,
  });
  const textResult = await handleIncomingMessage({
    ...commonArgs,
    message: textMessage,
  });

  assert.equal(attachmentResult.reason, "attachment-without-caption");
  assert.equal(textResult.reason, "prompt-started");
  assert.equal(startedRuns.length, 1);
  assert.equal(startedRuns[0].rawPrompt, textMessage.text);
  assert.equal(startedRuns[0].attachments.length, 1);
  assert.equal(startedRuns[0].attachments[0].file_path, "/tmp/ai_studio_code.txt");
  assert.equal(pendingByTopic.has("88"), false);
  assert.match(sent[0].text, /Вложение получил/u);
});

test("handleIncomingMessage keeps /q attachment buffering separate from direct Spike prompts", async () => {
  const sent = [];
  const startedRuns = [];
  const directPendingByTopic = new Map();
  const queuedPendingByTopic = new Map();
  const session = {
    session_key: "-1001234567890:89",
    chat_id: "-1001234567890",
    topic_id: "89",
    lifecycle_state: "active",
    ui_language: "rus",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
    workspace_binding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  };
  const queuedAttachmentMessage = {
    caption: "/q",
    caption_entities: [{ type: "bot_command", offset: 0, length: 2 }],
    document: {
      file_id: "queue-file-1",
      file_unique_id: "queue-uniq-file-1",
      file_name: "queue.txt",
      mime_type: "text/plain",
      file_size: 100,
    },
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 2101,
    message_thread_id: 89,
  };
  const textMessage = {
    text: "Сделай обычный Spike prompt без очереди.",
    from: { id: 123456789, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: 2102,
    message_thread_id: 89,
  };

  const commonArgs = {
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    sessionService: {
      async ensureSessionForMessage() {
        return { ...session };
      },
      async ensureRunnableSessionForMessage() {
        return { ...session };
      },
      async getGlobalPromptSuffix() {
        return {
          prompt_suffix_enabled: false,
          prompt_suffix_text: null,
        };
      },
      async ingestIncomingAttachments(_api, _session, message) {
        if (message.message_id !== queuedAttachmentMessage.message_id) {
          return [];
        }

        return [
          {
            file_path: "/tmp/queue.txt",
            relative_path: "incoming/queue.txt",
            mime_type: "text/plain",
            size_bytes: 100,
            is_image: false,
          },
        ];
      },
      async bufferPendingPromptAttachments(currentSession, attachments, options = {}) {
        const store = options.scope === "queue"
          ? queuedPendingByTopic
          : directPendingByTopic;
        store.set(currentSession.topic_id, attachments);
      },
      async getPendingPromptAttachments(currentSession, options = {}) {
        const store = options.scope === "queue"
          ? queuedPendingByTopic
          : directPendingByTopic;
        return [...(store.get(currentSession.topic_id) || [])];
      },
      async clearPendingPromptAttachments(currentSession, options = {}) {
        const store = options.scope === "queue"
          ? queuedPendingByTopic
          : directPendingByTopic;
        store.delete(currentSession.topic_id);
        return currentSession;
      },
      async recordHandledSession() {},
      async listPromptQueue() {
        return [];
      },
      async enqueuePromptQueue() {
        throw new Error("should not enqueue");
      },
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

  const queuedAttachmentResult = await handleIncomingMessage({
    ...commonArgs,
    message: queuedAttachmentMessage,
  });
  const textResult = await handleIncomingMessage({
    ...commonArgs,
    message: textMessage,
  });

  assert.equal(queuedAttachmentResult.reason, "queue-attachment-without-prompt");
  assert.equal(textResult.reason, "prompt-started");
  assert.equal(startedRuns.length, 1);
  assert.equal(startedRuns[0].attachments.length, 0);
  assert.equal(queuedPendingByTopic.get(session.topic_id)?.length, 1);
  assert.equal(directPendingByTopic.has(session.topic_id), false);
  assert.match(sent[0].text, /через \/q/u);
});
