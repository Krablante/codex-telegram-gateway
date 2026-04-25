import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  safeSendDocumentToTopic,
  safeSendPhotoToTopic,
  safeSendMessage,
} from "../src/telegram/topic-delivery.js";

test("safeSendMessage preserves handled non-parked lifecycle outcomes", async () => {
  const session = {
    chat_id: "-1001234567890",
    topic_id: 2203,
  };
  const result = await safeSendMessage(
    {
      async sendMessage() {
        throw new Error("topic missing");
      },
    },
    { chat_id: -1001234567890, text: "test" },
    session,
    {
      async handleTransportError() {
        return {
          handled: true,
          parked: false,
          session,
        };
      },
    },
  );

  assert.deepEqual(result, {
    delivered: false,
    parked: false,
    session,
  });
});

test("safeSendMessage retries once without reply_to_message_id when the target is gone", async () => {
  const calls = [];
  const result = await safeSendMessage(
    {
      async sendMessage(params) {
        calls.push({ ...params });
        if (calls.length === 1) {
          throw new Error("Bad Request: message to be replied not found");
        }
        return { message_id: 5 };
      },
    },
    {
      chat_id: -1001234567890,
      text: "test",
      message_thread_id: 2203,
      reply_to_message_id: 701,
    },
    null,
    null,
  );

  assert.deepEqual(calls, [
    {
      chat_id: -1001234567890,
      text: "test",
      message_thread_id: 2203,
      reply_to_message_id: 701,
    },
    {
      chat_id: -1001234567890,
      text: "test",
      message_thread_id: 2203,
    },
  ]);
  assert.deepEqual(result, {
    delivered: true,
    session: null,
  });
});

test("safeSendDocumentToTopic forwards content type and retries without reply_to_message_id", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-topic-delivery-"),
  );
  const filePath = path.join(tmpDir, "out.txt");
  await fs.writeFile(filePath, "artifact\n", "utf8");
  const calls = [];
  const result = await safeSendDocumentToTopic(
    {
      async sendDocument(params) {
        calls.push(params);
        if (calls.length === 1) {
          throw new Error("Bad Request: message to be replied not found");
        }
        return { message_id: 6 };
      },
    },
    {
      chat: { id: -1001234567890 },
      message_thread_id: 2203,
    },
    {
      filePath,
      fileName: "out.txt",
      caption: "artifact",
      contentType: "text/plain",
      replyToMessageId: 701,
    },
    null,
    null,
  );

  assert.deepEqual(calls, [
    {
      chat_id: -1001234567890,
      message_thread_id: 2203,
      reply_to_message_id: 701,
      caption: "artifact",
      document: {
        filePath,
        fileName: "out.txt",
        contentType: "text/plain",
      },
    },
    {
      chat_id: -1001234567890,
      message_thread_id: 2203,
      caption: "artifact",
      document: {
        filePath,
        fileName: "out.txt",
        contentType: "text/plain",
      },
    },
  ]);
  assert.deepEqual(result, {
    delivered: true,
    sizeBytes: 9,
  });
});

test("safeSendPhotoToTopic forwards content type and retries without reply_to_message_id", async () => {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-topic-photo-delivery-"),
  );
  const filePath = path.join(tmpDir, "out.png");
  await fs.writeFile(filePath, "png-data\n", "utf8");
  const calls = [];
  const result = await safeSendPhotoToTopic(
    {
      async sendPhoto(params) {
        calls.push(params);
        if (calls.length === 1) {
          throw new Error("Bad Request: message to be replied not found");
        }
        return { message_id: 7 };
      },
    },
    {
      chat: { id: -1001234567890 },
      message_thread_id: 2203,
    },
    {
      filePath,
      fileName: "out.png",
      caption: "preview",
      contentType: "image/png",
      replyToMessageId: 701,
    },
    null,
    null,
  );

  assert.deepEqual(calls, [
    {
      chat_id: -1001234567890,
      message_thread_id: 2203,
      reply_to_message_id: 701,
      caption: "preview",
      photo: {
        filePath,
        fileName: "out.png",
        contentType: "image/png",
      },
    },
    {
      chat_id: -1001234567890,
      message_thread_id: 2203,
      caption: "preview",
      photo: {
        filePath,
        fileName: "out.png",
        contentType: "image/png",
      },
    },
  ]);
  assert.deepEqual(result, {
    delivered: true,
    sizeBytes: 9,
  });
});
