import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTopicContextFileText,
  buildTopicContextPrompt,
} from "../src/session-manager/topic-context.js";

const session = {
  session_key: "-1001234567890:2203",
  chat_id: "-1001234567890",
  topic_id: "2203",
  topic_name: "codex-telegram",
  workspace_binding: {
    cwd: "/workspace",
  },
};

test("buildTopicContextPrompt stays compact and points to the topic context file", () => {
  const prompt = buildTopicContextPrompt(session, {
    topicContextPath:
      "/workspace/state/projects/codex-telegram-gateway/sessions/-1001234567890/2203/telegram-topic-context.md",
  });

  assert.match(prompt, /Telegram topic routing context:/u);
  assert.match(prompt, /topic_id: 2203/u);
  assert.match(prompt, /cwd: \/workspace/u);
  assert.match(prompt, /topic_context_file:/u);
  assert.match(prompt, /Read topic_context_file only if you need routing or file-send details/u);
  assert.match(prompt, /Default delivery target is this current Telegram topic/u);
  assert.doesNotMatch(prompt, /File delivery:/u);
  assert.doesNotMatch(prompt, /```telegram-file/u);
  assert.doesNotMatch(prompt, /chat_id:/u);
  assert.doesNotMatch(prompt, /session_key:/u);
  assert.doesNotMatch(prompt, /topic_name:/u);
  assert.doesNotMatch(prompt, /raw Telegram Bot API/u);
});

test("buildTopicContextFileText keeps the detailed safe file-delivery instructions", () => {
  const text = buildTopicContextFileText(session, {
    topicContextPath:
      "/workspace/state/projects/codex-telegram-gateway/sessions/-1001234567890/2203/telegram-topic-context.md",
  });

  assert.match(text, /# Telegram topic context/u);
  assert.match(text, /The live run prompt carries only a short Telegram routing stub/u);
  assert.match(text, /chat_id: -1001234567890/u);
  assert.match(text, /File delivery:/u);
  assert.match(text, /Example below is inert until you add action: send:/u);
  assert.match(text, /```telegram-file/u);
  assert.match(text, /path: \/tmp\/report\.txt/u);
  assert.doesNotMatch(text, /^action: send$/mu);
});
