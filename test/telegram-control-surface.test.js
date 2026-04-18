import test from "node:test";
import assert from "node:assert/strict";

import { createTrackedGeneralApi } from "../src/telegram/general-message-cleanup.js";
import { PromptFragmentAssembler } from "../src/telegram/prompt-fragment-assembler.js";
import { handleIncomingMessage } from "../src/telegram/command-router.js";

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

function buildUnlimitedLimitsSummary(overrides = {}) {
  return {
    available: true,
    capturedAt: "2026-04-04T13:00:00.000Z",
    source: "windows_rtx",
    planType: "business",
    limitName: "codex",
    unlimited: true,
    windows: [],
    primary: null,
    secondary: null,
    ...overrides,
  };
}

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

function createGeneralMessageLedgerStore(initialState = {}) {
  let state = {
    schema_version: 1,
    updated_at: null,
    tracked_message_ids: [],
    ...initialState,
  };

  return {
    async load() {
      return JSON.parse(JSON.stringify(state));
    },
    async trackMessageId(messageId) {
      if (!Number.isInteger(messageId) || messageId <= 0) {
        return this.load();
      }
      state = {
        ...state,
        updated_at: new Date().toISOString(),
        tracked_message_ids: Array.from(
          new Set([...state.tracked_message_ids, messageId]),
        ),
      };
      return this.load();
    },
    async forgetMessageIds(messageIds) {
      const removeIds = new Set(
        (Array.isArray(messageIds) ? messageIds : [])
          .filter((messageId) => Number.isInteger(messageId) && messageId > 0),
      );
      state = {
        ...state,
        updated_at: new Date().toISOString(),
        tracked_message_ids: state.tracked_message_ids.filter(
          (messageId) => !removeIds.has(messageId),
        ),
      };
      return this.load();
    },
    getState() {
      return JSON.parse(JSON.stringify(state));
    },
  };
}

function buildBaseServiceState() {
  return {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
  };
}

function buildGeneralCommandMessage(text, overrides = {}) {
  return {
    message_id: 779,
    text,
    entities: [{ type: "bot_command", offset: 0, length: text.length }],
    from: { id: 5825672398, is_bot: false },
    chat: { id: -1003577434463 },
    ...overrides,
  };
}

function buildGlobalSessionService() {
  return {
    async getGlobalCodexSettings() {
      return {
        spike_model: null,
        spike_reasoning_effort: null,
        omni_model: null,
        omni_reasoning_effort: null,
      };
    },
    async getGlobalPromptSuffix() {
      return {
        prompt_suffix_enabled: false,
        prompt_suffix_text: null,
      };
    },
    async getCodexLimitsSummary() {
      return buildUnlimitedLimitsSummary();
    },
  };
}

function buildIdleWorkerPool() {
  return {
    getActiveRun() {
      return null;
    },
    interrupt() {
      return false;
    },
  };
}

test("handleIncomingMessage clears tracked General clutter and keeps only the active menu", async () => {
  const deleted = [];
  const store = createGlobalControlPanelStore({
    menu_message_id: 901,
    active_screen: "suffix",
  });
  const ledgerStore = createGeneralMessageLedgerStore({
    tracked_message_ids: [777, 778, 901],
  });

  const result = await handleIncomingMessage({
    api: {
      async editMessageText() {
        return true;
      },
      async deleteMessage(payload) {
        deleted.push(payload);
        return true;
      },
      async sendMessage() {
        return { message_id: 901 };
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: store,
    generalMessageLedgerStore: ledgerStore,
    message: buildGeneralCommandMessage("/clear"),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: buildBaseServiceState(),
    sessionService: buildGlobalSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "clear");
  assert.deepEqual(
    deleted.map((entry) => entry.message_id),
    [777, 778, 779],
  );
  assert.deepEqual(ledgerStore.getState().tracked_message_ids, [901]);
  assert.equal(store.getState().active_screen, "suffix");
});

test("createTrackedGeneralApi tracks General messages when Telegram uses thread id 0", async () => {
  const ledgerStore = createGeneralMessageLedgerStore();
  const trackedApi = createTrackedGeneralApi({
    async sendMessage() {
      return { message_id: 903 };
    },
  }, config, ledgerStore);

  await trackedApi.sendMessage({
    chat_id: -1003577434463,
    message_thread_id: 0,
    text: "General notice",
  });

  assert.deepEqual(ledgerStore.getState().tracked_message_ids, [903]);
});

test("handleIncomingMessage keeps /clear General-only outside General", async () => {
  const sent = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 902 };
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      ui_language: "eng",
    }),
    generalMessageLedgerStore: createGeneralMessageLedgerStore(),
    message: buildGeneralCommandMessage("/clear", {
      message_id: 55,
      message_thread_id: 2203,
    }),
    serviceState: buildBaseServiceState(),
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("should not be called");
      },
    },
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "clear");
  assert.match(sent[0].text, /\/clear works in General only\./u);
});

test("handleIncomingMessage reports /clear failures only as an error message", async () => {
  const sent = [];

  const result = await handleIncomingMessage({
    api: {
      async editMessageText() {
        return true;
      },
      async deleteMessage(payload) {
        if (payload.message_id === 778) {
          throw new Error("message can't be deleted");
        }
        return true;
      },
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 901 };
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      menu_message_id: 901,
      ui_language: "eng",
    }),
    generalMessageLedgerStore: createGeneralMessageLedgerStore({
      tracked_message_ids: [778, 901],
    }),
    message: buildGeneralCommandMessage("/clear"),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: buildBaseServiceState(),
    sessionService: buildGlobalSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "clear");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /General cleanup finished with 1 undeleted message/u);
});

test("handleIncomingMessage treats stale missing General messages as already gone during /clear", async () => {
  const sent = [];
  const ledgerStore = createGeneralMessageLedgerStore({
    tracked_message_ids: [778, 901],
  });

  const result = await handleIncomingMessage({
    api: {
      async editMessageText() {
        return true;
      },
      async deleteMessage(payload) {
        if (payload.message_id === 778) {
          throw new Error(
            "Telegram API deleteMessage failed: Bad Request: message to delete not found",
          );
        }
        return true;
      },
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: 901 };
      },
    },
    botUsername: "gatewaybot",
    config,
    globalControlPanelStore: createGlobalControlPanelStore({
      menu_message_id: 901,
      ui_language: "eng",
    }),
    generalMessageLedgerStore: ledgerStore,
    message: buildGeneralCommandMessage("/clear"),
    promptFragmentAssembler: new PromptFragmentAssembler(),
    serviceState: buildBaseServiceState(),
    sessionService: buildGlobalSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "clear");
  assert.equal(sent.length, 0);
  assert.deepEqual(ledgerStore.getState().tracked_message_ids, [901]);
});
