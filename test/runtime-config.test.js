import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseEnvText } from "../src/config/env-file.js";
import {
  getDefaultEnvFilePath,
  getDefaultStateRoot,
  getDefaultWorkspaceRoot,
  resolveRuntimeEnvFilePath,
} from "../src/config/default-paths.js";
import {
  buildRuntimeConfig,
  loadRuntimeConfig,
  parseCodexConfigProfile,
} from "../src/config/runtime-config.js";

function restoreEnvVar(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

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
    TELEGRAM_ALLOWED_BOT_IDS: "8603043042,8537834861",
    TELEGRAM_FORUM_CHAT_ID: "-1003577434463",
    TELEGRAM_EXPECTED_TOPICS: "General, Test topic 1, Test topic 2",
    TELEGRAM_POLL_TIMEOUT_SECS: "5",
    ATLAS_WORKSPACE_ROOT: "/workspace",
    DEFAULT_SESSION_BINDING_PATH: "/workspace",
    CODEX_SESSIONS_ROOT: "/tmp/codex-sessions",
    CODEX_MODEL: "gpt-5.4",
    CODEX_REASONING_EFFORT: "xhigh",
    CODEX_CONTEXT_WINDOW: "320000",
    CODEX_AUTO_COMPACT_TOKEN_LIMIT: "300000",
    OMNI_BOT_TOKEN: "omni-token",
    OMNI_BOT_ID: "8603043042",
    SPIKE_BOT_ID: "8537834861",
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
  assert.equal(config.telegramAllowedUserId, "5825672398");
  assert.deepEqual(config.telegramAllowedUserIds, ["5825672398"]);
  assert.deepEqual(config.telegramAllowedBotIds, [
    "8603043042",
    "8537834861",
  ]);
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
  assert.equal(config.omniBotToken, "omni-token");
  assert.equal(config.omniBotId, "8603043042");
  assert.equal(config.spikeBotId, "8537834861");
});

test("buildRuntimeConfig accepts WORKSPACE_ROOT as the preferred workspace alias", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "5825672398",
    TELEGRAM_FORUM_CHAT_ID: "-1003577434463",
    WORKSPACE_ROOT: "O:/workspace",
    DEFAULT_SESSION_BINDING_PATH: "O:/workspace/main-repo",
  });

  assert.equal(config.workspaceRoot, "O:/workspace");
  assert.equal(config.defaultSessionBindingPath, "O:/workspace/main-repo");
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

test("buildRuntimeConfig supports multi-user allowlists without the legacy single user key", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_IDS: "5825672398,123456789",
    TELEGRAM_ALLOWED_BOT_IDS: "8603043042",
    TELEGRAM_FORUM_CHAT_ID: "-1003577434463",
  });

  assert.deepEqual(config.telegramAllowedUserIds, [
    "5825672398",
    "123456789",
  ]);
  assert.equal(config.telegramAllowedUserId, "5825672398");
  assert.deepEqual(config.telegramAllowedBotIds, ["8603043042"]);
});

test("buildRuntimeConfig auto-adds Omni bot id to the trusted bot allowlist", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "5825672398",
    TELEGRAM_FORUM_CHAT_ID: "-1003577434463",
    OMNI_BOT_TOKEN: "omni-token",
    OMNI_BOT_ID: "8603043042",
  });

  assert.deepEqual(config.telegramAllowedBotIds, ["8603043042"]);
});

test("buildRuntimeConfig disables Omni by default when it is not configured", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "5825672398",
    TELEGRAM_FORUM_CHAT_ID: "-1003577434463",
  });

  assert.equal(config.omniEnabled, false);
  assert.equal(config.omniBotToken, null);
  assert.equal(config.omniBotId, null);
});

test("buildRuntimeConfig allows explicitly disabling Omni even when credentials exist", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "5825672398",
    TELEGRAM_FORUM_CHAT_ID: "-1003577434463",
    OMNI_ENABLED: "false",
    OMNI_BOT_TOKEN: "omni-token",
    OMNI_BOT_ID: "8603043042",
  });

  assert.equal(config.omniEnabled, false);
  assert.deepEqual(config.telegramAllowedBotIds, []);
});

test("buildRuntimeConfig requires OMNI_BOT_ID when OMNI_BOT_TOKEN is set", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "5825672398",
        TELEGRAM_FORUM_CHAT_ID: "-1003577434463",
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
        TELEGRAM_ALLOWED_USER_ID: "5825672398",
        TELEGRAM_FORUM_CHAT_ID: "-1003577434463",
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
`, "/home/operator/.codex/config.toml");

  assert.equal(profile.configPath, "/home/operator/.codex/config.toml");
  assert.equal(profile.model, "gpt-5.4");
  assert.equal(profile.reasoningEffort, "xhigh");
  assert.equal(profile.contextWindow, 320000);
  assert.equal(profile.autoCompactTokenLimit, 300000);
});

test("default path helpers switch to Windows-friendly state and workspace roots", () => {
  const stateRoot = getDefaultStateRoot({
    platform: "win32",
    homeDirectory: "C:/Users/konstantin",
    localAppData: "C:/Users/konstantin/AppData/Local",
  });
  const workspaceRoot = getDefaultWorkspaceRoot({
    platform: "win32",
    repoRoot: "O:/workspace/codex-telegram-gateway",
  });
  const envFilePath = getDefaultEnvFilePath({
    stateRoot,
  });

  assert.equal(
    path.win32.normalize(stateRoot),
    path.win32.join(
      "C:/Users/konstantin/AppData/Local",
      "codex-telegram-gateway",
    ),
  );
  assert.equal(
    path.win32.normalize(workspaceRoot),
    path.win32.normalize(
      path.win32.dirname("O:/workspace/codex-telegram-gateway"),
    ),
  );
  assert.equal(
    path.win32.normalize(envFilePath),
    path.win32.join(
      "C:/Users/konstantin/AppData/Local",
      "codex-telegram-gateway",
      "runtime.env",
    ),
  );
});

test("resolveRuntimeEnvFilePath prefers repo-local .env when the state env is missing", async () => {
  const repoRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-repo-"),
  );
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-state-"),
  );
  const repoEnvPath = path.join(repoRoot, ".env");
  await fs.writeFile(repoEnvPath, "TELEGRAM_BOT_TOKEN=secret\n", "utf8");

  const previousEnvFile = process.env.ENV_FILE;
  delete process.env.ENV_FILE;
  const resolved = await resolveRuntimeEnvFilePath({
    repoRoot,
    stateRoot,
  });
  restoreEnvVar("ENV_FILE", previousEnvFile);

  assert.equal(resolved, repoEnvPath);
});

test("loadRuntimeConfig reads a repo-local .env when ENV_FILE is unset", async () => {
  const repoRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-load-config-"),
  );
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-load-state-"),
  );
  await fs.writeFile(
    path.join(repoRoot, ".env"),
    [
      "TELEGRAM_BOT_TOKEN=secret-token",
      "TELEGRAM_ALLOWED_USER_ID=5825672398",
      "TELEGRAM_FORUM_CHAT_ID=-1003577434463",
      "WORKSPACE_ROOT=O:/workspace",
      "",
    ].join("\n"),
    "utf8",
  );

  const previousEnvFile = process.env.ENV_FILE;
  delete process.env.ENV_FILE;
  const config = await loadRuntimeConfig({
    repoRoot,
    stateRoot,
  });
  restoreEnvVar("ENV_FILE", previousEnvFile);

  assert.equal(config.envFilePath, path.join(repoRoot, ".env"));
  assert.equal(config.workspaceRoot, "O:/workspace");
});
