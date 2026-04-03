import test from "node:test";
import assert from "node:assert/strict";

import { parseEnvText } from "../src/config/env-file.js";
import { buildRuntimeConfig, parseCodexConfigProfile } from "../src/config/runtime-config.js";

test("parseEnvText reads comments, exports, and quoted values", () => {
  const env = parseEnvText(`
# comment
export TELEGRAM_ALLOWED_USER_ID=123456789
TELEGRAM_BOT_TOKEN="secret-token"
TELEGRAM_FORUM_CHAT_ID='-1001234567890'
TELEGRAM_EXPECTED_TOPICS=General, Test topic 1 , Test topic 2
`);

  assert.equal(env.TELEGRAM_ALLOWED_USER_ID, "123456789");
  assert.equal(env.TELEGRAM_BOT_TOKEN, "secret-token");
  assert.equal(env.TELEGRAM_FORUM_CHAT_ID, "-1001234567890");
  assert.equal(
    env.TELEGRAM_EXPECTED_TOPICS,
    "General, Test topic 1 , Test topic 2",
  );
});

test("buildRuntimeConfig validates ids and splits expected topics", () => {
  const config = buildRuntimeConfig({
    ENV_FILE: "/tmp/runtime.env",
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "123456789",
    TELEGRAM_ALLOWED_BOT_IDS: "222333444,333444555",
    TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
    TELEGRAM_EXPECTED_TOPICS: "General, Test topic 1, Test topic 2",
    TELEGRAM_POLL_TIMEOUT_SECS: "5",
    WORKSPACE_ROOT: "/workspace",
    DEFAULT_SESSION_BINDING_PATH: "/workspace",
    CODEX_SESSIONS_ROOT: "/tmp/codex-sessions",
    CODEX_MODEL: "gpt-5.4",
    CODEX_REASONING_EFFORT: "xhigh",
    CODEX_CONTEXT_WINDOW: "320000",
    CODEX_AUTO_COMPACT_TOKEN_LIMIT: "300000",
    OMNI_BOT_TOKEN: "omni-token",
    OMNI_BOT_ID: "222333444",
    SPIKE_BOT_ID: "333444555",
  });

  assert.equal(config.envFilePath, "/tmp/runtime.env");
  assert.equal(config.workspaceRoot, "/workspace");
  assert.equal(config.defaultSessionBindingPath, "/workspace");
  assert.equal(config.codexBinPath, "codex");
  assert.equal(config.codexSessionsRoot, "/tmp/codex-sessions");
  assert.equal(config.codexModel, "gpt-5.4");
  assert.equal(config.codexReasoningEffort, "xhigh");
  assert.equal(config.codexContextWindow, 320000);
  assert.equal(config.codexAutoCompactTokenLimit, 300000);
  assert.equal(config.telegramAllowedUserId, "123456789");
  assert.deepEqual(config.telegramAllowedUserIds, ["123456789"]);
  assert.deepEqual(config.telegramAllowedBotIds, [
    "222333444",
    "333444555",
  ]);
  assert.equal(config.telegramForumChatId, "-1001234567890");
  assert.equal(config.telegramPollTimeoutSecs, 5);
  assert.equal(config.maxParallelSessions, 10);
  assert.equal(config.parkedSessionRetentionHours, 168);
  assert.equal(config.retentionSweepIntervalSecs, 60);
  assert.deepEqual(config.telegramExpectedTopics, [
    "General",
    "Test topic 1",
    "Test topic 2",
  ]);
  assert.equal(config.omniBotToken, "omni-token");
  assert.equal(config.omniBotId, "222333444");
  assert.equal(config.spikeBotId, "333444555");
});

test("buildRuntimeConfig still accepts the legacy Atlas workspace alias", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "123456789",
    TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
    ATLAS_WORKSPACE_ROOT: "/workspace/legacy-root",
  });

  assert.equal(config.workspaceRoot, "/workspace/legacy-root");
  assert.equal(config.defaultSessionBindingPath, "/workspace/legacy-root");
});

test("buildRuntimeConfig rejects malformed ids", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "not-a-number",
        TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
      }),
    /TELEGRAM_ALLOWED_USER_ID/u,
  );
});

test("buildRuntimeConfig supports multi-user allowlists without the legacy single user key", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_IDS: "123456789,987654321",
    TELEGRAM_ALLOWED_BOT_IDS: "222333444",
    TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
  });

  assert.deepEqual(config.telegramAllowedUserIds, [
    "123456789",
    "987654321",
  ]);
  assert.equal(config.telegramAllowedUserId, "123456789");
  assert.deepEqual(config.telegramAllowedBotIds, ["222333444"]);
});

test("buildRuntimeConfig auto-adds Omni bot id to the trusted bot allowlist", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "123456789",
    TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
    OMNI_BOT_TOKEN: "omni-token",
    OMNI_BOT_ID: "222333444",
  });

  assert.deepEqual(config.telegramAllowedBotIds, ["222333444"]);
});

test("buildRuntimeConfig disables Omni by default when it is not configured", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "123456789",
    TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
  });

  assert.equal(config.omniEnabled, false);
  assert.equal(config.omniBotToken, null);
  assert.equal(config.omniBotId, null);
});

test("buildRuntimeConfig allows explicitly disabling Omni even when credentials exist", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "123456789",
    TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
    OMNI_ENABLED: "false",
    OMNI_BOT_TOKEN: "omni-token",
    OMNI_BOT_ID: "222333444",
  });

  assert.equal(config.omniEnabled, false);
  assert.deepEqual(config.telegramAllowedBotIds, []);
});

test("buildRuntimeConfig requires OMNI_BOT_ID when OMNI_BOT_TOKEN is set", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "123456789",
        TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
        OMNI_BOT_TOKEN: "omni-token",
      }),
    /OMNI_BOT_ID/u,
  );
});

test("buildRuntimeConfig requires Omni credentials when OMNI_ENABLED is forced on", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "123456789",
        TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
        OMNI_ENABLED: "true",
      }),
    /Omni is enabled/u,
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
