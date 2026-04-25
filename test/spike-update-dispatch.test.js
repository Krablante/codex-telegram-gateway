import test from "node:test";
import assert from "node:assert/strict";

import { handleSpikeUpdate } from "../src/telegram/spike-update-dispatch.js";
import { ingestIncomingAttachments } from "../src/telegram/incoming-attachments.js";
import { PROMPT_FLOW_CONFIG as config } from "../test-support/prompt-flow-fixtures.js";

test("handleSpikeUpdate replies and swallows oversized topic attachments instead of poisoning the poll cycle", async () => {
  const sent = [];
  const updateFailures = [];
  const chatId = config.telegramForumChatId;
  const userId = Number(config.telegramAllowedUserIds[0]);
  const topicId = 9760;
  const session = {
    session_key: `${chatId}:${topicId}`,
    chat_id: chatId,
    topic_id: String(topicId),
    lifecycle_state: "active",
    ui_language: "rus",
    workspace_binding: {
      repo_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      branch: "main",
      worktree_path: "/srv/codex-workspace",
    },
  };
  const message = {
    from: { id: userId, is_bot: false },
    chat: { id: Number(chatId) },
    message_id: 4201,
    message_thread_id: topicId,
    document: {
      file_id: "oversized-document-1",
      file_unique_id: "oversized-document-1",
      file_name: "7113_project_1775761230328.snpsd",
      mime_type: "application/octet-stream",
      file_size: 56183872,
    },
  };

  const api = {
    async sendMessage(payload) {
      sent.push(payload);
      return { message_id: 1 };
    },
    async getFile() {
      throw new Error("getFile should not run for oversized attachments");
    },
    async downloadFile() {
      throw new Error("downloadFile should not run for oversized attachments");
    },
  };

  await handleSpikeUpdate({
    api,
    botUsername: "gatewaybot",
    config,
    emergencyRouter: {
      async handleMessage() {
        return null;
      },
      async handleCompetingTopicMessage() {
        return null;
      },
    },
    lifecycleManager: {
      async handleServiceMessage() {
        return { handled: false };
      },
    },
    runtimeObserver: {
      async noteUpdateFailure(updateId, error) {
        updateFailures.push({ updateId, error });
      },
    },
    sessionService: {
      async ensureSessionForMessage() {
        return session;
      },
      async ensureRunnableSessionForMessage() {
        return session;
      },
      async ingestIncomingAttachments(currentApi, currentSession, currentMessage) {
        return ingestIncomingAttachments({
          api: currentApi,
          message: currentMessage,
          session: currentSession,
          sessionStore: {
            getSessionDir() {
              return "/tmp/codex-telegram-gateway-test-session";
            },
          },
        });
      },
    },
    serviceState: {
      ignoredUpdates: 0,
      handledCommands: 0,
      lastCommandName: null,
      lastCommandAt: null,
    },
    topicControlPanelStore: null,
    globalControlPanelStore: null,
    generalMessageLedgerStore: null,
    workerPool: {
      async startPromptRun() {
        throw new Error("should not start a run for an oversized attachment");
      },
    },
    zooService: null,
    update: {
      update_id: 9001,
      message,
    },
  });

  assert.equal(updateFailures.length, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Вложение слишком большое/u);
  assert.match(sent[0].text, /7113_project_1775761230328\.snpsd/u);
  assert.match(sent[0].text, /limit_bytes: 20971520/u);
});
