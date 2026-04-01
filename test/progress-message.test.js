import test from "node:test";
import assert from "node:assert/strict";

import { TelegramProgressMessage } from "../src/transport/progress-message.js";

test("TelegramProgressMessage falls back to append-only updates after a non-editable error", async () => {
  const sentMessages = [];
  const editedMessages = [];
  const deletedMessages = [];
  const progress = new TelegramProgressMessage({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async editMessageText(payload) {
        editedMessages.push(payload);
        if (payload.message_id === 1) {
          throw new Error("Telegram API editMessageText failed: Bad Request: message can't be edited");
        }

        return { ok: true };
      },
      async deleteMessage(payload) {
        deletedMessages.push(payload);
        return true;
      },
    },
    chatId: -1001234567890,
    messageThreadId: 55,
  });

  await progress.sendInitial("Start");
  progress.pendingText = "Update 1";
  await progress.flushPending();

  assert.equal(progress.appendOnlyMode, true);
  assert.equal(editedMessages.length, 1);
  assert.equal(sentMessages.length, 2);
  assert.equal(deletedMessages.length, 1);
  assert.equal(progress.currentText, "Update 1");
  assert.equal(progress.messageId, 2);
  assert.equal(progress.pendingText, null);
});

test("TelegramProgressMessage retries the same bubble after a transient edit failure", async () => {
  const editedMessages = [];
  let shouldFail = true;
  const progress = new TelegramProgressMessage({
    api: {
      async sendMessage() {
        return { message_id: 17 };
      },
      async editMessageText(payload) {
        editedMessages.push(payload);
        if (shouldFail) {
          shouldFail = false;
          throw new Error("Telegram API editMessageText failed: Too Many Requests: retry later");
        }

        return { ok: true };
      },
      async deleteMessage() {
        return true;
      },
    },
    chatId: -1001234567890,
    messageThreadId: 55,
  });

  await progress.sendInitial("Start");
  progress.pendingText = "Update 1";
  await progress.flushPending();

  assert.equal(progress.pendingText, "Update 1");
  assert.equal(progress.messageId, 17);

  await progress.flushPending();

  assert.equal(editedMessages.length, 2);
  assert.equal(progress.pendingText, null);
  assert.equal(progress.currentText, "Update 1");
  assert.equal(progress.messageId, 17);
});

test("TelegramProgressMessage avoids append-only fallback when lifecycle handler parks the session", async () => {
  const sentMessages = [];
  const editedMessages = [];
  const deletedMessages = [];
  const reportedErrors = [];
  const progress = new TelegramProgressMessage({
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length };
      },
      async editMessageText(payload) {
        editedMessages.push(payload);
        throw new Error("Telegram API editMessageText failed: Bad Request: message thread not found");
      },
      async deleteMessage(payload) {
        deletedMessages.push(payload);
        return true;
      },
    },
    chatId: -1001234567890,
    messageThreadId: 55,
    onDeliveryError: async (error) => {
      reportedErrors.push(error.message);
      return {
        handled: true,
        parked: true,
      };
    },
  });

  await progress.sendInitial("Start");
  progress.pendingText = "Update 1";
  await progress.flushPending();

  assert.equal(progress.appendOnlyMode, false);
  assert.equal(editedMessages.length, 1);
  assert.equal(sentMessages.length, 1);
  assert.equal(deletedMessages.length, 0);
  assert.equal(progress.pendingText, "Update 1");
  assert.match(reportedErrors[0], /message thread not found/u);
});

test("TelegramProgressMessage can dismiss the current progress bubble", async () => {
  const deletedMessages = [];
  const progress = new TelegramProgressMessage({
    api: {
      async sendMessage() {
        return { message_id: 41 };
      },
      async deleteMessage(payload) {
        deletedMessages.push(payload);
        return true;
      },
    },
    chatId: -1001234567890,
    messageThreadId: 55,
  });

  await progress.sendInitial("Start");
  const dismissed = await progress.dismiss();

  assert.equal(dismissed, true);
  assert.equal(deletedMessages.length, 1);
  assert.equal(deletedMessages[0].message_id, 41);
  assert.equal(progress.messageId, null);
});
