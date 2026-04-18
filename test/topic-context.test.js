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
    atlas_workspace_root: "/home/bloob/atlas",
    cwd: "/home/bloob/atlas",
  },
};

test("buildTopicContextPrompt stays compact and points to the topic context file", () => {
  const prompt = buildTopicContextPrompt(session, {
    topicContextPath:
      "/home/bloob/atlas/state/homelab/infra/automation/codex-telegram-gateway/sessions/-1003577434463/2203/telegram-topic-context.md",
  });

  assert.match(prompt, /Telegram topic routing context:/u);
  assert.match(prompt, /topic_id: 2203/u);
  assert.match(prompt, /session_key: -1003577434463:2203/u);
  assert.match(prompt, /cwd: \/home\/bloob\/atlas/u);
  assert.match(
    prompt,
    /For .*pitlane\/large_file, use container mirror path \/workspace\/atlas/u,
  );
  assert.match(prompt, /topic_context_file:/u);
  assert.match(prompt, /Read topic_context_file only if you need routing or file-send details/u);
  assert.match(prompt, /Default delivery target is this current Telegram topic/u);
  assert.match(prompt, /not the host workspace path/u);
  assert.doesNotMatch(prompt, /File delivery:/u);
  assert.doesNotMatch(prompt, /```telegram-file/u);
  assert.doesNotMatch(prompt, /chat_id:/u);
  assert.doesNotMatch(prompt, /topic_name:/u);
  assert.doesNotMatch(prompt, /raw Telegram Bot API/u);
});

test("buildTopicContextFileText keeps the detailed safe file-delivery instructions", () => {
  const text = buildTopicContextFileText(session, {
    topicContextPath:
      "/home/bloob/atlas/state/homelab/infra/automation/codex-telegram-gateway/sessions/-1003577434463/2203/telegram-topic-context.md",
  });

  assert.match(text, /# Telegram topic context/u);
  assert.match(text, /The live run prompt carries only a short Telegram routing stub/u);
  assert.match(text, /chat_id: -1003577434463/u);
  assert.match(text, /Container-backed MCP mirror root: \/workspace\/atlas/u);
  assert.match(text, /Current cwd inside container-backed MCP tools: \/workspace\/atlas/u);
  assert.match(text, /File delivery:/u);
  assert.match(text, /Example below is inert until you add action: send:/u);
  assert.match(text, /```telegram-file/u);
  assert.match(text, /path: <absolute-host-path-to-file>/u);
  assert.match(text, /translate host workspace paths into the \/workspace\/.+ mirror/u);
  assert.doesNotMatch(text, /^action: send$/mu);
});

test("buildTopicContextFileText normalizes mixed-case Windows workspace paths into the container mirror", () => {
  const text = buildTopicContextFileText({
    ...session,
    workspace_binding: {
      atlas_workspace_root: "C:\\Atlas",
      cwd: "c:\\atlas\\homelab\\infra",
    },
  });

  assert.match(text, /Host workspace root: C:\\Atlas/u);
  assert.match(text, /Container-backed MCP mirror root: \/workspace\/atlas/u);
  assert.match(
    text,
    /Current cwd inside container-backed MCP tools: \/workspace\/atlas\/homelab\/infra/u,
  );
});
