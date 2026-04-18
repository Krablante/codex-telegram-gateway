import test from "node:test";
import assert from "node:assert/strict";

import { getTopicIdFromMessage } from "../src/session-manager/session-key.js";

test("getTopicIdFromMessage treats General thread id 0 as non-topic", () => {
  assert.equal(
    getTopicIdFromMessage({
      message_thread_id: 0,
    }),
    null,
  );
  assert.equal(
    getTopicIdFromMessage({
      message_thread_id: 2203,
    }),
    "2203",
  );
});
