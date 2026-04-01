import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { parseEnvText } from "../src/config/env-file.js";
import { buildRuntimeConfig, parseCodexConfigProfile } from "../src/config/runtime-config.js";

test("parseEnvText reads comments, exports, and quoted values", () => {
  const env = parseEnvText(`
# comment
export TELEGRAM_ALLOWED_USER_ID=5825672398
TELEGRAM_BOT_TOKEN="secret-token"
TELEGRAM_FORUM_CHAT_ID='-1003577434463'
TELEGRAM_EXPECTED_TOPICS=General, Test topic 1 , Test topic 2
`);

  assert.equal(env.TELEGRAM_ALLOWED_USER_ID, "5825672398");
  assert.equal(env.TELEGRAM_BOT_TOKEN, "secret-token");
  assert.equal(env.TELEGRAM_FORUM_CHAT_ID, "-1003577434463");
  assert.equal(
    env.TELEGRAM_EXPECTED_TOPICS,
    "General, Test topic 1 , Test topic 2",
  );
});

test("buildRuntimeConfig validates ids and splits expected topics", () => {
  const config = buildRuntimeConfig({
    ENV_FILE: "/tmp/runtime.env",
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "5825672398",
    TELEGRAM_FORUM_CHAT_ID: "-1003577434463",
    TELEGRAM_EXPECTED_TOPICS: "General, Test topic 1, Test topic 2",
    TELEGRAM_POLL_TIMEOUT_SECS: "5",
    ATLAS_WORKSPACE_ROOT: "/home/bloob/atlas",
    DEFAULT_SESSION_BINDING_PATH: "/home/bloob/atlas",
    CODEX_SESSIONS_ROOT: "/tmp/codex-sessions",
    CODEX_MODEL: "gpt-5.4",
    CODEX_REASONING_EFFORT: "xhigh",
    CODEX_CONTEXT_WINDOW: "320000",
    CODEX_AUTO_COMPACT_TOKEN_LIMIT: "300000",
  });

  assert.equal(config.envFilePath, "/tmp/runtime.env");
  assert.equal(config.workspaceRoot, "/home/bloob/atlas");
  assert.equal(config.atlasWorkspaceRoot, "/home/bloob/atlas");
  assert.equal(config.defaultSessionBindingPath, "/home/bloob/atlas");
  assert.equal(config.codexBinPath, "codex");
  assert.equal(config.codexSessionsRoot, "/tmp/codex-sessions");
  assert.equal(config.codexModel, "gpt-5.4");
  assert.equal(config.codexReasoningEffort, "xhigh");
  assert.equal(config.codexContextWindow, 320000);
  assert.equal(config.codexAutoCompactTokenLimit, 300000);
  assert.equal(config.telegramAllowedUserId, "5825672398");
  assert.equal(config.telegramForumChatId, "-1003577434463");
  assert.equal(config.telegramPollTimeoutSecs, 5);
  assert.equal(config.maxParallelSessions, 10);
  assert.equal(config.parkedSessionRetentionHours, 168);
  assert.equal(config.retentionSweepIntervalSecs, 60);
  assert.deepEqual(config.telegramExpectedTopics, [
    "General",
    "Test topic 1",
    "Test topic 2",
  ]);
});

test("buildRuntimeConfig accepts WORKSPACE_ROOT as the public-facing alias", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "5825672398",
    TELEGRAM_FORUM_CHAT_ID: "-1003577434463",
    WORKSPACE_ROOT: "/tmp/workspace-root",
  });

  assert.equal(config.workspaceRoot, "/tmp/workspace-root");
  assert.equal(config.atlasWorkspaceRoot, "/tmp/workspace-root");
  assert.equal(config.defaultSessionBindingPath, "/tmp/workspace-root");
});

test("buildRuntimeConfig rejects malformed ids", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "not-a-number",
        TELEGRAM_FORUM_CHAT_ID: "-1003577434463",
      }),
    /TELEGRAM_ALLOWED_USER_ID/u,
  );
});

test("parseCodexConfigProfile reads model and context numbers from codex toml", () => {
  const profile = parseCodexConfigProfile(`
model = "gpt-5.4"
model_reasoning_effort = "xhigh"
model_context_window = 320000
model_auto_compact_token_limit = 300000
`, "/home/bloob/.codex/config.toml");

  assert.equal(profile.configPath, "/home/bloob/.codex/config.toml");
  assert.equal(profile.model, "gpt-5.4");
  assert.equal(profile.reasoningEffort, "xhigh");
  assert.equal(profile.contextWindow, 320000);
  assert.equal(profile.autoCompactTokenLimit, 300000);
});
