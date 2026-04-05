import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { handleIncomingMessage } from "../src/telegram/command-router.js";

const config = {
  telegramAllowedUserId: "1234567890",
  telegramAllowedUserIds: ["1234567890"],
  telegramAllowedBotIds: ["2234567890"],
  telegramForumChatId: "-1001234567890",
  maxParallelSessions: 4,
  codexModel: "gpt-5.4",
  codexReasoningEffort: "medium",
  codexContextWindow: 320000,
  codexAutoCompactTokenLimit: 300000,
  codexConfigPath: "/tmp/codex-telegram-gateway-tests-missing-config.toml",
};

function createGlobalControlPanelStore(initialState = {}) {
  let state = {
    schema_version: 1,
    updated_at: null,
    menu_message_id: null,
    active_screen: "root",
    ui_language: "rus",
    pending_input: null,
    ...initialState,
  };

  return {
    async load() {
      return JSON.parse(JSON.stringify(state));
    },
    async patch(patch) {
      state = {
        ...state,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      return JSON.parse(JSON.stringify(state));
    },
    getState() {
      return JSON.parse(JSON.stringify(state));
    },
  };
}

test("handleIncomingMessage sends the help card from General topic", async () => {
  const documents = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendDocument(payload) {
        documents.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
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

  assert.equal(result.command, "help");
  assert.equal(documents.length, 2);
  assert.equal(documents[0].document.fileName, "severus-help-summer-rus-1.png");
  assert.equal(documents[1].document.fileName, "severus-help-summer-rus-2.png");
  assert.equal(documents[0].caption, undefined);
  assert.equal(documents[1].caption, undefined);
});

test("handleIncomingMessage sends the guidebook PDF from General topic", async () => {
  const documents = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendDocument(payload) {
        documents.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/guide",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
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

  assert.equal(result.command, "guide");
  assert.equal(documents.length, 1);
  assert.equal(documents[0].document.fileName, "codex-telegram-guidebook-rus.pdf");
  assert.match(documents[0].document.filePath, /codex-telegram-guidebook-rus\.pdf$/u);
  const stats = await fs.stat(documents[0].document.filePath);
  assert.ok(stats.size > 1_000);
  const header = await fs.readFile(documents[0].document.filePath);
  assert.equal(header.subarray(0, 5).toString("utf8"), "%PDF-");
});

test("handleIncomingMessage keeps /guide General-only", async () => {
  const sent = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
  const session = {
    session_key: "-1001234567890:77",
    chat_id: "-1001234567890",
    topic_id: "77",
    topic_name: "Guide topic",
    lifecycle_state: "active",
    ui_language: "rus",
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
      text: "/guide",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 77,
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
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
      interrupt() {
        return false;
      },
    },
  });

  assert.equal(result.command, "guide");
  assert.equal(result.reason, "guide-general-only");
  assert.match(sent[0].text, /работает только в General/u);
});

test("handleIncomingMessage sends the English help card inside an ENG topic", async () => {
  const documents = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendDocument(payload) {
        documents.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/help",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 88,
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        return {
          session_key: "-1001234567890:88",
          chat_id: "-1001234567890",
          topic_id: "88",
          topic_name: "ENG topic",
          lifecycle_state: "active",
          ui_language: "eng",
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

  assert.equal(result.command, "help");
  assert.equal(documents.length, 2);
  assert.equal(documents[0].document.fileName, "severus-help-summer-eng-1.png");
  assert.equal(documents[1].document.fileName, "severus-help-summer-eng-2.png");
  assert.equal(documents[0].caption, undefined);
  assert.equal(documents[1].caption, undefined);
});

test("handleIncomingMessage shows suffix help from General topic", async () => {
  const sent = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
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
      text: "/suffix help",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
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
  assert.match(sent[0].text, /Prompt suffix help/u);
  assert.match(sent[0].text, /\/suffix global <text>/u);
  assert.match(sent[0].text, /\/suffix topic off/u);
});

test("handleIncomingMessage keeps suffix help in ENG when General panel language is ENG", async () => {
  const sent = [];
  const serviceState = {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      ui_language: "eng",
    }),
    message: {
      text: "/suffix help",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState,
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
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
  assert.match(sent[0].text, /Suffix help/u);
  assert.doesNotMatch(sent[0].text, /Использование/u);
});
