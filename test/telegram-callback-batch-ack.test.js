import test from "node:test";
import assert from "node:assert/strict";

import { ackBatchCallbackQueriesBestEffort } from "../src/telegram/callback-batch-ack.js";

test("ackBatchCallbackQueriesBestEffort acknowledges each unique callback id in batch order", async () => {
  const calls = [];

  const result = await ackBatchCallbackQueriesBestEffort(
    {
      async answerCallbackQuery(payload) {
        calls.push(payload);
        return true;
      },
    },
    [
      { update_id: 1, message: { message_id: 11 } },
      { update_id: 2, callback_query: { id: "cbq-1" } },
      { update_id: 3, callback_query: { id: "cbq-2" } },
      { update_id: 4, callback_query: { id: "cbq-1" } },
      { update_id: 5, callback_query: { id: "   " } },
    ],
  );

  assert.deepEqual(calls, [
    { callback_query_id: "cbq-1" },
    { callback_query_id: "cbq-2" },
  ]);
  assert.deepEqual(result, {
    attempted: 2,
    acknowledged: 2,
  });
});

test("ackBatchCallbackQueriesBestEffort ignores api failures and keeps the batch flowing", async () => {
  const calls = [];

  const result = await ackBatchCallbackQueriesBestEffort(
    {
      async answerCallbackQuery(payload) {
        calls.push(payload);
        if (payload.callback_query_id === "cbq-bad") {
          throw new Error("query is too old");
        }
        return true;
      },
    },
    [
      { update_id: 1, callback_query: { id: "cbq-ok" } },
      { update_id: 2, callback_query: { id: "cbq-bad" } },
    ],
  );

  assert.deepEqual(calls, [
    { callback_query_id: "cbq-ok" },
    { callback_query_id: "cbq-bad" },
  ]);
  assert.deepEqual(result, {
    attempted: 2,
    acknowledged: 1,
  });
});

test("ackBatchCallbackQueriesBestEffort is a no-op when api does not support callback acks", async () => {
  const result = await ackBatchCallbackQueriesBestEffort(
    {},
    [
      { update_id: 1, callback_query: { id: "cbq-1" } },
    ],
  );

  assert.deepEqual(result, {
    attempted: 0,
    acknowledged: 0,
  });
});
