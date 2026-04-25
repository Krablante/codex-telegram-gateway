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
  execution_host_id: "worker-a",
  workspace_binding: {
    workspace_root: "/srv/codex-workspace",
    cwd: "/srv/codex-workspace",
  },
};

test("buildTopicContextPrompt stays compact and points to the topic context file", () => {
  const prompt = buildTopicContextPrompt(session, {
    topicContextPath:
      "/srv/codex-workspace/state/codex-telegram-gateway/sessions/-1001234567890/2203/telegram-topic-context.md",
    fileDeliveryRoots: [
      "/srv/codex-workspace",
      "/srv/codex-workspace/state/codex-telegram-gateway/sessions/-1001234567890/2203",
      "/tmp",
    ],
  });

  assert.match(prompt, /Context:/u);
  assert.match(prompt, /Telegram topic 2203 \(-1001234567890:2203\)/u);
  assert.match(prompt, /bound host: worker-a/u);
  assert.match(prompt, /workspace cwd: \/srv\/codex-workspace/u);
  assert.match(prompt, /telegram-file paths must be absolute paths on the bound host worker-a/u);
  assert.match(prompt, /write short natural-language progress notes/u);
  assert.match(prompt, /allowed telegram-file send roots:/u);
  assert.match(
    prompt,
    /for container-backed MCP use the workspace mirror root: \/workspace\/codex-workspace/u,
  );
  assert.match(prompt, /topic context file:/u);
  assert.match(prompt, /read the topic context file only when you need extra routing, delivery, or continuity details/u);
  assert.doesNotMatch(prompt, /File delivery:/u);
  assert.doesNotMatch(prompt, /```telegram-file/u);
  assert.doesNotMatch(prompt, /chat_id:/u);
  assert.doesNotMatch(prompt, /topic_name:/u);
  assert.doesNotMatch(prompt, /raw Telegram Bot API/u);
});

test("buildTopicContextPrompt keeps remote host-bound delivery guidance inline", () => {
  const prompt = buildTopicContextPrompt(session, {
    executionCwd: "/home/worker-b/workspace/work/public/project",
    fileDeliveryRoots: [
      "/home/worker-b/workspace/work/public/project",
      "/home/worker-b/workspace/state/codex-telegram-gateway",
      "/tmp",
    ],
    topicContextFileOnControlPlane: true,
  });

  assert.match(prompt, /workspace cwd: \/home\/worker-b\/workspace\/work\/public\/project/u);
  assert.match(prompt, /telegram-file paths must be absolute paths on the bound host worker-a/u);
  assert.match(
    prompt,
    /allowed telegram-file send roots: .*\/home\/worker-b\/workspace\/work\/public\/project.*\/home\/worker-b\/workspace\/state\/codex-telegram-gateway.*\/tmp/u,
  );
  assert.match(
    prompt,
    /topic context file stays on the Telegram control-plane host for this remote run/u,
  );
  assert.doesNotMatch(prompt, /topic context file: .*telegram-topic-context\.md/u);
});

test("buildTopicContextPrompt can append a Work Style section to base instructions", () => {
  const prompt = buildTopicContextPrompt(session, {
    workStyleText: "TOPIC\nKeep it short in this thread.",
  });

  assert.match(prompt, /Context:/u);
  assert.match(prompt, /\n\nWork Style:\nTOPIC\nKeep it short in this thread\./u);
});

test("buildTopicContextFileText keeps the detailed safe file-delivery instructions", () => {
  const text = buildTopicContextFileText(session, {
    topicContextPath:
      "/srv/codex-workspace/state/codex-telegram-gateway/sessions/-1001234567890/2203/telegram-topic-context.md",
  });

  assert.match(text, /# Telegram topic context/u);
  assert.match(text, /The live user-turn prompt stays small/u);
  assert.match(text, /Thread developer instructions carry the short Telegram routing contract/u);
  assert.match(text, /chat_id: -1001234567890/u);
  assert.match(text, /Container-backed MCP mirror root: \/workspace\/codex-workspace/u);
  assert.match(text, /Current cwd inside container-backed MCP tools: \/workspace\/codex-workspace/u);
  assert.match(text, /File delivery:/u);
  assert.match(text, /path: must resolve on the bound execution host/u);
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
      workspace_root: "C:\\Workspace",
      cwd: "c:\\workspace\\project",
    },
  });

  assert.match(text, /Host workspace root: C:\\Workspace/u);
  assert.match(text, /Container-backed MCP mirror root: \/workspace\/workspace/u);
  assert.match(
    text,
    /Current cwd inside container-backed MCP tools: \/workspace\/workspace\/project/u,
  );
});
