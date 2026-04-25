import { mkdtempForTest } from "./tmp.js";

export function buildConfig(stateRoot) {
  return {
    stateRoot,
    workspaceRoot: "/srv/codex-workspace",
    codexBinPath: "codex",
    telegramAllowedUserId: "123456789",
    telegramAllowedUserIds: ["123456789"],
    telegramAllowedBotIds: ["8603043042"],
    telegramForumChatId: "-1001234567890",
  };
}

export async function createStateRoot(t = null) {
  return mkdtempForTest(t, "codex-telegram-gateway-zoo-service-");
}

export function createApiStub() {
  const calls = {
    createForumTopic: [],
    sendMessage: [],
    editMessageText: [],
    pinChatMessage: [],
    deleteMessage: [],
    answerCallbackQuery: [],
  };

  return {
    calls,
    async createForumTopic(params) {
      calls.createForumTopic.push(params);
      return {
        message_thread_id: 700,
        name: "Zoo",
      };
    },
    async sendMessage(params) {
      calls.sendMessage.push(params);
      return {
        message_id: 900 + calls.sendMessage.length,
      };
    },
    async editMessageText(params) {
      calls.editMessageText.push(params);
      return true;
    },
    async pinChatMessage(params) {
      calls.pinChatMessage.push(params);
      return true;
    },
    async deleteMessage(params) {
      calls.deleteMessage.push(params);
      return true;
    },
    async answerCallbackQuery(params) {
      calls.answerCallbackQuery.push(params);
      return true;
    },
  };
}

export function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
