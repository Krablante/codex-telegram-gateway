import test from "node:test";
import assert from "node:assert/strict";

import { summarizeForumTopic } from "../src/live-user/forum-topics.js";

test("summarizeForumTopic uses forum topic id as stable session topic id", () => {
  const summary = summarizeForumTopic({
    className: "ForumTopic",
    id: 11317,
    topMessage: 11319,
    title: "Live User New",
    closed: false,
    hidden: false,
  });

  assert.deepEqual(summary, {
    forumTopicId: 11317,
    topicId: 11317,
    title: "Live User New",
    topMessage: 11319,
    closed: false,
    hidden: false,
  });
});

test("summarizeForumTopic ignores non forum-topic objects", () => {
  assert.equal(summarizeForumTopic({ className: "Channel" }), null);
  assert.equal(summarizeForumTopic({ className: "ForumTopic", id: 0 }), null);
});
