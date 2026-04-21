import fs from "node:fs/promises";
import process from "node:process";

import { DEFAULT_ENV_FILE, loadEnvFile } from "./env-file.js";
import {
  getDefaultCodexConfigPath,
  getDefaultCodexSessionsRoot,
  getDefaultRepoRoot,
  getDefaultStateRoot,
  getDefaultWorkspaceRoot,
  resolveRuntimeEnvFilePath,
} from "./default-paths.js";

const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const DEFAULT_TELEGRAM_POLL_TIMEOUT_SECS = 30;
const DEFAULT_MAX_PARALLEL_SESSIONS = 10;
const DEFAULT_PARKED_SESSION_RETENTION_HOURS = 168;
const DEFAULT_RETENTION_SWEEP_INTERVAL_SECS = 60;
const DEFAULT_CODEX_CONFIG_PATH = getDefaultCodexConfigPath();

function readRequired(rawEnv, key) {
  const value = rawEnv[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required runtime setting: ${key}`);
  }

  return value.trim();
}

function normalizeIntegerString(value, key) {
  if (!/^-?\d+$/u.test(value)) {
    throw new Error(`Expected ${key} to be an integer string, got: ${value}`);
  }

  return value;
}

function parseIntegerList(value, key) {
  if (!value) {
    return [];
  }

  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => normalizeIntegerString(entry, key)),
    ),
  ];
}

function parseTopicList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value, key, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (!/^\d+$/u.test(value)) {
    throw new Error(`Expected ${key} to be a positive integer, got: ${value}`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected ${key} to be > 0, got: ${value}`);
  }

  return parsed;
}

function parseOptionalBoolean(value, key) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected ${key} to be a boolean-like value, got: ${value}`);
}

function parseTomlScalar(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  if (/^-?\d+$/u.test(trimmed)) {
    return Number(trimmed);
  }

  return trimmed;
}

function parseMcpServerNames(text) {
  return [
    ...new Set(
      Array.from(
        String(text || "").matchAll(/^\s*\[mcp_servers\.([^\]]+)\]\s*$/gmu),
        (match) => String(match[1] || "").trim(),
      ).filter(Boolean),
    ),
  ];
}

export function parseCodexConfigProfile(text, configPath = DEFAULT_CODEX_CONFIG_PATH) {
  const readKey = (key) => {
    const match = text.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "mu"));
    if (!match) {
      return null;
    }

    return parseTomlScalar(match[1]);
  };

  return {
    configPath,
    model: readKey("model"),
    reasoningEffort: readKey("model_reasoning_effort"),
    contextWindow: readKey("model_context_window"),
    autoCompactTokenLimit: readKey("model_auto_compact_token_limit"),
    mcpServerNames: parseMcpServerNames(text),
  };
}

export function getDefaultCodexBinPath(platform = process.platform) {
  return platform === "win32" ? "codex.cmd" : "codex";
}

export async function loadCodexConfigProfile(configPath) {
  try {
    const text = await fs.readFile(configPath, "utf8");
    return parseCodexConfigProfile(text, configPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        configPath,
        model: null,
        reasoningEffort: null,
        contextWindow: null,
        autoCompactTokenLimit: null,
        mcpServerNames: [],
      };
    }

    throw error;
  }
}

export function buildRuntimeConfig(rawEnv, codexProfile = {}) {
  const repoRoot = rawEnv.REPO_ROOT?.trim() || getDefaultRepoRoot();
  const stateRoot = rawEnv.STATE_ROOT?.trim() || getDefaultStateRoot();
  const envFilePath = rawEnv.ENV_FILE?.trim() || DEFAULT_ENV_FILE;
  const atlasWorkspaceRoot =
    rawEnv.WORKSPACE_ROOT?.trim()
    || rawEnv.ATLAS_WORKSPACE_ROOT?.trim()
    || getDefaultWorkspaceRoot({ repoRoot });
  const telegramApiBaseUrl =
    rawEnv.TELEGRAM_API_BASE_URL?.trim() || DEFAULT_TELEGRAM_API_BASE_URL;
  const defaultSessionBindingPath =
    rawEnv.DEFAULT_SESSION_BINDING_PATH?.trim() || atlasWorkspaceRoot;
  const codexBinPath =
    rawEnv.CODEX_BIN_PATH?.trim() || getDefaultCodexBinPath();
  const codexConfigPath =
    rawEnv.CODEX_CONFIG_PATH?.trim() ||
    codexProfile.configPath ||
    DEFAULT_CODEX_CONFIG_PATH;
  const codexMcpServerNames = Array.isArray(codexProfile.mcpServerNames)
    ? [...codexProfile.mcpServerNames]
    : [];
  const codexSessionsRoot =
    rawEnv.CODEX_SESSIONS_ROOT?.trim() || getDefaultCodexSessionsRoot();
  const codexLimitsSessionsRoot =
    rawEnv.CODEX_LIMITS_SESSIONS_ROOT?.trim() || codexSessionsRoot;
  const codexLimitsCommand =
    rawEnv.CODEX_LIMITS_COMMAND?.trim() || null;
  const codexLimitsCacheTtlSecs = parsePositiveInteger(
    rawEnv.CODEX_LIMITS_CACHE_TTL_SECS,
    "CODEX_LIMITS_CACHE_TTL_SECS",
    30,
  );
  const codexLimitsCommandTimeoutSecs = parsePositiveInteger(
    rawEnv.CODEX_LIMITS_COMMAND_TIMEOUT_SECS,
    "CODEX_LIMITS_COMMAND_TIMEOUT_SECS",
    15,
  );

  const telegramBotToken = readRequired(rawEnv, "TELEGRAM_BOT_TOKEN");
  const legacyAllowedUserId = rawEnv.TELEGRAM_ALLOWED_USER_ID?.trim()
    ? normalizeIntegerString(
        readRequired(rawEnv, "TELEGRAM_ALLOWED_USER_ID"),
        "TELEGRAM_ALLOWED_USER_ID",
      )
    : null;
  const telegramAllowedUserIds = [
    ...new Set([
      ...parseIntegerList(
        rawEnv.TELEGRAM_ALLOWED_USER_IDS,
        "TELEGRAM_ALLOWED_USER_IDS",
      ),
      ...(legacyAllowedUserId ? [legacyAllowedUserId] : []),
    ]),
  ];
  if (telegramAllowedUserIds.length === 0) {
    throw new Error(
      "Missing required runtime setting: TELEGRAM_ALLOWED_USER_ID or TELEGRAM_ALLOWED_USER_IDS",
    );
  }
  const telegramAllowedBotIds = parseIntegerList(
    rawEnv.TELEGRAM_ALLOWED_BOT_IDS,
    "TELEGRAM_ALLOWED_BOT_IDS",
  );
  const telegramForumChatId = normalizeIntegerString(
    readRequired(rawEnv, "TELEGRAM_FORUM_CHAT_ID"),
    "TELEGRAM_FORUM_CHAT_ID",
  );
  const omniBotToken = rawEnv.OMNI_BOT_TOKEN?.trim() || null;
  const omniBotId = rawEnv.OMNI_BOT_ID?.trim()
    ? normalizeIntegerString(rawEnv.OMNI_BOT_ID.trim(), "OMNI_BOT_ID")
    : null;
  const spikeBotId = rawEnv.SPIKE_BOT_ID?.trim()
    ? normalizeIntegerString(rawEnv.SPIKE_BOT_ID.trim(), "SPIKE_BOT_ID")
    : null;
  const omniEnabledSetting = parseOptionalBoolean(
    rawEnv.OMNI_ENABLED,
    "OMNI_ENABLED",
  );
  const omniEnabled =
    omniEnabledSetting ?? Boolean(omniBotToken && omniBotId);
  if (omniBotToken && !omniBotId && omniEnabledSetting !== false) {
    throw new Error("Missing required runtime setting: OMNI_BOT_ID");
  }
  if (omniEnabled && (!omniBotToken || !omniBotId)) {
    throw new Error(
      "Omni is enabled but OMNI_BOT_TOKEN / OMNI_BOT_ID are not fully configured",
    );
  }
  const effectiveAllowedBotIds = [
    ...new Set([
      ...telegramAllowedBotIds,
      ...(omniEnabled && omniBotId ? [omniBotId] : []),
    ]),
  ];

  return {
    envFilePath,
    repoRoot,
    stateRoot,
    atlasWorkspaceRoot,
    defaultSessionBindingPath,
    codexBinPath,
    codexConfigPath,
    codexMcpServerNames,
    codexSessionsRoot,
    codexLimitsSessionsRoot,
    codexLimitsCommand,
    codexLimitsCacheTtlSecs,
    codexLimitsCommandTimeoutSecs,
    codexModel:
      rawEnv.CODEX_MODEL?.trim() ||
      codexProfile.model ||
      null,
    codexReasoningEffort:
      rawEnv.CODEX_REASONING_EFFORT?.trim() ||
      rawEnv.CODEX_THINKING_LEVEL?.trim() ||
      codexProfile.reasoningEffort ||
      null,
    codexContextWindow: parsePositiveInteger(
      rawEnv.CODEX_CONTEXT_WINDOW,
      "CODEX_CONTEXT_WINDOW",
      codexProfile.contextWindow ?? null,
    ),
    codexAutoCompactTokenLimit: parsePositiveInteger(
      rawEnv.CODEX_AUTO_COMPACT_TOKEN_LIMIT,
      "CODEX_AUTO_COMPACT_TOKEN_LIMIT",
      codexProfile.autoCompactTokenLimit ?? null,
    ),
    telegramApiBaseUrl,
    telegramPollTimeoutSecs: parsePositiveInteger(
      rawEnv.TELEGRAM_POLL_TIMEOUT_SECS,
      "TELEGRAM_POLL_TIMEOUT_SECS",
      DEFAULT_TELEGRAM_POLL_TIMEOUT_SECS,
    ),
    maxParallelSessions: parsePositiveInteger(
      rawEnv.MAX_PARALLEL_SESSIONS,
      "MAX_PARALLEL_SESSIONS",
      DEFAULT_MAX_PARALLEL_SESSIONS,
    ),
    parkedSessionRetentionHours: parsePositiveInteger(
      rawEnv.PARKED_SESSION_RETENTION_HOURS,
      "PARKED_SESSION_RETENTION_HOURS",
      DEFAULT_PARKED_SESSION_RETENTION_HOURS,
    ),
    retentionSweepIntervalSecs: parsePositiveInteger(
      rawEnv.RETENTION_SWEEP_INTERVAL_SECS,
      "RETENTION_SWEEP_INTERVAL_SECS",
      DEFAULT_RETENTION_SWEEP_INTERVAL_SECS,
    ),
    telegramBotToken,
    telegramAllowedUserId: telegramAllowedUserIds[0],
    telegramAllowedUserIds,
    telegramAllowedBotIds: effectiveAllowedBotIds,
    telegramForumChatId,
    telegramExpectedTopics: parseTopicList(rawEnv.TELEGRAM_EXPECTED_TOPICS),
    omniEnabled,
    omniBotToken,
    omniBotId,
    spikeBotId,
  };
}

export async function loadRuntimeConfig(options = {}) {
  const repoRoot = options.repoRoot || process.env.REPO_ROOT || getDefaultRepoRoot();
  const stateRoot = options.stateRoot || process.env.STATE_ROOT || getDefaultStateRoot();
  const envFilePath = await resolveRuntimeEnvFilePath({
    explicitEnvFilePath: options.envFilePath || process.env.ENV_FILE || null,
    repoRoot,
    stateRoot,
  });
  const fileEnv = await loadEnvFile(envFilePath);
  const mergedEnv = {
    ...fileEnv,
    ...process.env,
    ENV_FILE: envFilePath,
    REPO_ROOT: process.env.REPO_ROOT || fileEnv.REPO_ROOT || repoRoot,
    STATE_ROOT: process.env.STATE_ROOT || fileEnv.STATE_ROOT || stateRoot,
  };
  const codexConfigPath =
    mergedEnv.CODEX_CONFIG_PATH?.trim() || DEFAULT_CODEX_CONFIG_PATH;
  const codexProfile = await loadCodexConfigProfile(codexConfigPath);

  return buildRuntimeConfig(mergedEnv, codexProfile);
}
