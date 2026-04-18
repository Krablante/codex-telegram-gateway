import test from "node:test";
import assert from "node:assert/strict";

import { safeSendMessage } from "../src/telegram/topic-delivery.js";

test("safeSendMessage preserves handled non-parked lifecycle outcomes", async () => {
  const session = {
    chat_id: "-1003577434463",
    topic_id: 2203,
  };
  const result = await safeSendMessage(
    {
      async sendMessage() {
        throw new Error("topic missing");
      },
    },
    { chat_id: -1003577434463, text: "test" },
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
      chat_id: -1003577434463,
      text: "test",
      message_thread_id: 2203,
      reply_to_message_id: 701,
    },
    null,
    null,
  );

  assert.deepEqual(calls, [
    {
      chat_id: -1003577434463,
      text: "test",
      message_thread_id: 2203,
      reply_to_message_id: 701,
    },
    {
      chat_id: -1003577434463,
      text: "test",
      message_thread_id: 2203,
    },
  ]);
  assert.deepEqual(result, {
    delivered: true,
    session: null,
  });
});
