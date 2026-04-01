import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTopicContextFileText,
  buildTopicContextPrompt,
} from "../src/session-manager/topic-context.js";

const session = {
  session_key: "-1003577434463:2203",
  chat_id: "-1003577434463",
  topic_id: "2203",
  topic_name: "codex-telegram",
  workspace_binding: {
    cwd: "/home/bloob/atlas",
  },
};

test("buildTopicContextPrompt stays compact and points to the topic context file", () => {
  const prompt = buildTopicContextPrompt(session, {
    topicContextPath:
      "/home/bloob/atlas/state/homelab/infra/automation/codex-telegram-gateway/sessions/-1003577434463/2203/telegram-topic-context.md",
  });

  assert.match(prompt, /Telegram topic routing context:/u);
  assert.match(prompt, /topic_context_file:/u);
  assert.match(prompt, /read topic_context_file/u);
  assert.match(prompt, /telegram-file/u);
  assert.doesNotMatch(prompt, /File delivery:/u);
  assert.doesNotMatch(prompt, /```telegram-file/u);
  assert.doesNotMatch(prompt, /chat_id:/u);
});

test("buildTopicContextFileText keeps the detailed safe file-delivery instructions", () => {
  const text = buildTopicContextFileText(session, {
    topicContextPath:
      "/home/bloob/atlas/state/homelab/infra/automation/codex-telegram-gateway/sessions/-1003577434463/2203/telegram-topic-context.md",
  });

  assert.match(text, /# Telegram topic context/u);
  assert.match(text, /chat_id: -1003577434463/u);
  assert.match(text, /File delivery:/u);
  assert.match(text, /Example below is inert until you add action: send:/u);
  assert.match(text, /```telegram-file/u);
  assert.match(text, /path: \/tmp\/report\.txt/u);
  assert.doesNotMatch(text, /^action: send$/mu);
});
