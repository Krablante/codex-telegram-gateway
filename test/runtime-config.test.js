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
  getDefaultCodexBinPath,
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

test("parseEnvText strips a leading UTF-8 BOM so Windows-edited env files still load", () => {
  const env = parseEnvText("\uFEFFTELEGRAM_BOT_TOKEN=secret-token\r\nTELEGRAM_ALLOWED_USER_ID=123456789");

  assert.equal(env.TELEGRAM_BOT_TOKEN, "secret-token");
  assert.equal(env.TELEGRAM_ALLOWED_USER_ID, "123456789");
});

test("getDefaultCodexBinPath prefers codex.cmd on Windows", () => {
  assert.equal(getDefaultCodexBinPath("linux"), "codex");
  assert.equal(getDefaultCodexBinPath("win32"), "codex.cmd");
});

test("buildRuntimeConfig validates ids and splits expected topics", () => {
  const config = buildRuntimeConfig({
    ENV_FILE: "/tmp/runtime.env",
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "123456789",
    TELEGRAM_ALLOWED_BOT_IDS: "8603043042,8537834861",
    TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
    TELEGRAM_EXPECTED_TOPICS: "General, Test topic 1, Test topic 2",
    TELEGRAM_POLL_TIMEOUT_SECS: "5",
    WORKSPACE_ROOT: "/srv/codex-workspace",
    DEFAULT_SESSION_BINDING_PATH: "/srv/codex-workspace",
    CODEX_SESSIONS_ROOT: "/tmp/codex-sessions",
    CODEX_LIMITS_SESSIONS_ROOT: "/tmp/codex-limits",
    CODEX_LIMITS_COMMAND: "python3 /tmp/read-limits.py",
    CODEX_LIMITS_CACHE_TTL_SECS: "45",
    CODEX_LIMITS_COMMAND_TIMEOUT_SECS: "9",
    CODEX_GATEWAY_BACKEND: "app-server",
    CODEX_ENABLE_LEGACY_APP_SERVER: "1",
    CODEX_ALLOW_SYSTEM_TEMP_DELIVERY: "1",
    CODEX_MODEL: "gpt-5.4",
    CODEX_REASONING_EFFORT: "xhigh",
    CODEX_CONTEXT_WINDOW: "320000",
    CODEX_AUTO_COMPACT_TOKEN_LIMIT: "300000",
    CURRENT_HOST_ID: "controller",
    HOST_REGISTRY_PATH: "/tmp/hosts/registry.json",
    HOST_SYNC_INTERVAL_MINUTES: "20",
    HOST_SSH_CONNECT_TIMEOUT_SECS: "11",
    SPIKE_BOT_ID: "8537834861",
  });

  assert.equal(config.envFilePath, "/tmp/runtime.env");
  assert.equal(config.workspaceRoot, "/srv/codex-workspace");
  assert.equal(config.defaultSessionBindingPath, "/srv/codex-workspace");
  assert.equal(config.currentHostId, "controller");
  assert.equal(config.hostRegistryPath, "/tmp/hosts/registry.json");
  assert.equal(config.hostSyncIntervalMinutes, 20);
  assert.equal(config.hostSshConnectTimeoutSecs, 11);
  assert.equal(config.codexBinPath, getDefaultCodexBinPath());
  assert.equal(config.codexSessionsRoot, "/tmp/codex-sessions");
  assert.equal(config.codexLimitsSessionsRoot, "/tmp/codex-limits");
  assert.equal(config.codexLimitsCommand, "python3 /tmp/read-limits.py");
  assert.equal(config.codexLimitsCacheTtlSecs, 45);
  assert.equal(config.codexLimitsCommandTimeoutSecs, 9);
  assert.equal(config.codexGatewayBackend, "app-server");
  assert.equal(config.codexEnableLegacyAppServer, true);
  assert.equal(config.allowSystemTempDelivery, true);
  assert.equal(config.codexModel, "gpt-5.4");
  assert.equal(config.codexReasoningEffort, "xhigh");
  assert.equal(config.codexContextWindow, 320000);
  assert.equal(config.codexAutoCompactTokenLimit, 300000);
  assert.equal(config.telegramAllowedUserId, "123456789");
  assert.deepEqual(config.telegramAllowedUserIds, ["123456789"]);
  assert.deepEqual(config.telegramAllowedBotIds, [
    "8603043042",
    "8537834861",
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
  assert.equal(config.spikeBotId, "8537834861");
});

test("parseCodexConfigProfile extracts MCP server names from the Codex config", () => {
  const profile = parseCodexConfigProfile(`
model = "gpt-5.4"

[mcp_servers.requests]
command = "docker"

[mcp_servers.pitlane]
command = "docker"

[mcp_servers.requests]
command = "docker"
`);

  assert.deepEqual(profile.mcpServerNames, ["requests", "pitlane"]);
});

test("buildRuntimeConfig keeps the parsed Codex config path and MCP server list", () => {
  const config = buildRuntimeConfig(
    {
      TELEGRAM_BOT_TOKEN: "secret-token",
      TELEGRAM_ALLOWED_USER_ID: "123456789",
      TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
    },
    {
      configPath: "/home/operator/.codex/config.toml",
      mcpServerNames: ["pitlane", "requests", "tavily"],
    },
  );

  assert.equal(config.codexConfigPath, "/home/operator/.codex/config.toml");
  assert.deepEqual(config.codexMcpServerNames, [
    "pitlane",
    "requests",
    "tavily",
  ]);
});

test("buildRuntimeConfig accepts WORKSPACE_ROOT as the preferred workspace alias", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "123456789",
    TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
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
        TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
      }),
    /TELEGRAM_ALLOWED_USER_ID/u,
  );
});

test("buildRuntimeConfig supports multi-user allowlists without the legacy single user key", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_IDS: "123456789,123456790",
    TELEGRAM_ALLOWED_BOT_IDS: "8603043042",
    TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
  });

  assert.deepEqual(config.telegramAllowedUserIds, [
    "123456789",
    "123456790",
  ]);
  assert.equal(config.telegramAllowedUserId, "123456789");
  assert.deepEqual(config.telegramAllowedBotIds, ["8603043042"]);
});

test("buildRuntimeConfig keeps explicit trusted bot allowlists separate from SPIKE_BOT_ID", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "123456789",
    TELEGRAM_ALLOWED_BOT_IDS: "8603043042",
    TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
    SPIKE_BOT_ID: "8537834861",
  });

  assert.deepEqual(config.telegramAllowedBotIds, ["8603043042"]);
  assert.equal(config.spikeBotId, "8537834861");
});

test("buildRuntimeConfig defaults Codex gateway backend to exec-json", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "123456789",
    TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
  });

  assert.equal(config.codexGatewayBackend, "exec-json");
});

test("buildRuntimeConfig rejects unknown Codex gateway backends", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "123456789",
        TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
        CODEX_GATEWAY_BACKEND: "websocket-zoo",
      }),
    /CODEX_GATEWAY_BACKEND/u,
  );
});

test("buildRuntimeConfig rejects legacy app-server backend unless explicitly enabled", () => {
  assert.throws(
    () =>
      buildRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret-token",
        TELEGRAM_ALLOWED_USER_ID: "123456789",
        TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
        CODEX_GATEWAY_BACKEND: "app-server",
      }),
    /CODEX_ENABLE_LEGACY_APP_SERVER/u,
  );
});

test("buildRuntimeConfig leaves SPIKE_BOT_ID optional", () => {
  const config = buildRuntimeConfig({
    TELEGRAM_BOT_TOKEN: "secret-token",
    TELEGRAM_ALLOWED_USER_ID: "123456789",
    TELEGRAM_FORUM_CHAT_ID: "-1001234567890",
  });

  assert.equal(config.spikeBotId, null);
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

test("parseCodexConfigProfile tolerates leading indentation around top-level keys", () => {
  const profile = parseCodexConfigProfile(`
  model = "gpt-5.4"
  model_reasoning_effort = "high"
  model_context_window = 320000
  model_auto_compact_token_limit = 300000
`);

  assert.equal(profile.model, "gpt-5.4");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.contextWindow, 320000);
  assert.equal(profile.autoCompactTokenLimit, 300000);
});

test("parseCodexConfigProfile ignores profile table values and unquotes MCP server names", () => {
  const profile = parseCodexConfigProfile(`
model = "gpt-5.5"
model_reasoning_effort = "xhigh"

[profiles.stale]
model = "gpt-5.4"
model_reasoning_effort = "low"

[mcp_servers."agent-secret-broker"]
command = "broker"

[mcp_servers.pitlane]
command = "pitlane"
`);

  assert.equal(profile.model, "gpt-5.5");
  assert.equal(profile.reasoningEffort, "xhigh");
  assert.deepEqual(profile.mcpServerNames, ["agent-secret-broker", "pitlane"]);
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

test("resolveRuntimeEnvFilePath uses repo-local .env only when fallback is allowed", async () => {
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
    allowRepoEnvFallback: true,
    repoRoot,
    stateRoot,
  });

  assert.equal(resolved, repoEnvPath);

  const lockedDown = await resolveRuntimeEnvFilePath({
    allowRepoEnvFallback: false,
    repoRoot,
    stateRoot,
  });
  restoreEnvVar("ENV_FILE", previousEnvFile);
  assert.equal(lockedDown, path.join(stateRoot, "runtime.env"));
});

test("resolveRuntimeEnvFilePath prefers repo-local .env on Windows and state runtime.env on Linux", async () => {
  const repoRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-env-repo-"),
  );
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-env-state-"),
  );
  const repoEnvPath = path.join(repoRoot, ".env");
  const stateEnvPath = path.join(stateRoot, "runtime.env");
  await fs.writeFile(repoEnvPath, "TELEGRAM_BOT_TOKEN=repo\n", "utf8");
  await fs.writeFile(stateEnvPath, "TELEGRAM_BOT_TOKEN=state\n", "utf8");

  const previousEnvFile = process.env.ENV_FILE;
  delete process.env.ENV_FILE;
  try {
    assert.equal(
      await resolveRuntimeEnvFilePath({
        platform: "win32",
        repoRoot,
        stateRoot,
      }),
      repoEnvPath,
    );
    assert.equal(
      await resolveRuntimeEnvFilePath({
        platform: "linux",
        repoRoot,
        stateRoot,
        allowRepoEnvFallback: true,
      }),
      stateEnvPath,
    );
  } finally {
    restoreEnvVar("ENV_FILE", previousEnvFile);
  }
});

test("loadRuntimeConfig reads a repo-local .env when explicitly allowed", async () => {
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
      "TELEGRAM_ALLOWED_USER_ID=123456789",
      "TELEGRAM_FORUM_CHAT_ID=-1001234567890",
      "WORKSPACE_ROOT=O:/workspace",
      "",
    ].join("\n"),
    "utf8",
  );

  const previousEnvFile = process.env.ENV_FILE;
  delete process.env.ENV_FILE;
  const config = await loadRuntimeConfig({
    allowRepoEnvFallback: true,
    repoRoot,
    stateRoot,
  });
  restoreEnvVar("ENV_FILE", previousEnvFile);

  assert.equal(config.envFilePath, path.join(repoRoot, ".env"));
  assert.equal(config.workspaceRoot, "O:/workspace");
});

test("loadRuntimeConfig uses shell STATE_ROOT to discover the canonical runtime env", async () => {
  const repoRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-load-config-"),
  );
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-state-root-"),
  );
  const runtimeEnvPath = path.join(stateRoot, "runtime.env");
  await fs.writeFile(
    runtimeEnvPath,
    [
      "TELEGRAM_BOT_TOKEN=secret-token",
      "TELEGRAM_ALLOWED_USER_ID=123456789",
      "TELEGRAM_FORUM_CHAT_ID=-1001234567890",
      "WORKSPACE_ROOT=/srv/workspace",
      "",
    ].join("\n"),
    "utf8",
  );

  const previousEnvFile = process.env.ENV_FILE;
  const previousStateRoot = process.env.STATE_ROOT;
  delete process.env.ENV_FILE;
  process.env.STATE_ROOT = stateRoot;

  const config = await loadRuntimeConfig({
    repoRoot,
  });

  restoreEnvVar("ENV_FILE", previousEnvFile);
  restoreEnvVar("STATE_ROOT", previousStateRoot);

  assert.equal(config.envFilePath, runtimeEnvPath);
  assert.equal(config.stateRoot, stateRoot);
  assert.equal(config.workspaceRoot, "/srv/workspace");
});

test("loadRuntimeConfig lets shell STATE_ROOT override the env file value", async () => {
  const repoRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-load-config-"),
  );
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-shell-state-root-"),
  );
  const runtimeEnvPath = path.join(stateRoot, "runtime.env");
  await fs.writeFile(
    runtimeEnvPath,
    [
      "TELEGRAM_BOT_TOKEN=secret-token",
      "TELEGRAM_ALLOWED_USER_ID=123456789",
      "TELEGRAM_FORUM_CHAT_ID=-1001234567890",
      "STATE_ROOT=/tmp/file-state-root",
      "WORKSPACE_ROOT=/srv/workspace",
      "",
    ].join("\n"),
    "utf8",
  );

  const previousEnvFile = process.env.ENV_FILE;
  const previousStateRoot = process.env.STATE_ROOT;
  process.env.ENV_FILE = runtimeEnvPath;
  process.env.STATE_ROOT = "/tmp/shell-state-root";

  const config = await loadRuntimeConfig({
    repoRoot,
  });

  restoreEnvVar("ENV_FILE", previousEnvFile);
  restoreEnvVar("STATE_ROOT", previousStateRoot);

  assert.equal(config.envFilePath, runtimeEnvPath);
  assert.equal(config.stateRoot, "/tmp/shell-state-root");
});
