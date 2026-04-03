import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_ENV_FILE, loadEnvFile } from "./env-file.js";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const DEFAULT_STATE_ROOT = process.env.XDG_STATE_HOME?.trim()
  ? path.join(
      process.env.XDG_STATE_HOME.trim(),
      "codex-telegram-gateway",
    )
  : path.join(
      os.homedir(),
      ".local",
      "state",
      "codex-telegram-gateway",
    );
const DEFAULT_WORKSPACE_ROOT = os.homedir();
const DEFAULT_CODEX_SESSIONS_ROOT = `${os.homedir()}/.codex/sessions`;
const DEFAULT_TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const DEFAULT_TELEGRAM_POLL_TIMEOUT_SECS = 30;
const DEFAULT_CODEX_BIN_PATH = "codex";
const DEFAULT_MAX_PARALLEL_SESSIONS = 10;
const DEFAULT_PARKED_SESSION_RETENTION_HOURS = 168;
const DEFAULT_RETENTION_SWEEP_INTERVAL_SECS = 60;
const DEFAULT_CODEX_CONFIG_PATH = `${os.homedir()}/.codex/config.toml`;

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
  };
}

async function loadCodexConfigProfile(configPath) {
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
      };
    }

    throw error;
  }
}

export function buildRuntimeConfig(rawEnv, codexProfile = {}) {
  const envFilePath = rawEnv.ENV_FILE?.trim() || DEFAULT_ENV_FILE;
  const repoRoot = rawEnv.REPO_ROOT?.trim() || DEFAULT_REPO_ROOT;
  const stateRoot = rawEnv.STATE_ROOT?.trim() || DEFAULT_STATE_ROOT;
  const workspaceRoot =
    rawEnv.WORKSPACE_ROOT?.trim() ||
    rawEnv.ATLAS_WORKSPACE_ROOT?.trim() ||
    DEFAULT_WORKSPACE_ROOT;
  const telegramApiBaseUrl =
    rawEnv.TELEGRAM_API_BASE_URL?.trim() || DEFAULT_TELEGRAM_API_BASE_URL;
  const defaultSessionBindingPath =
    rawEnv.DEFAULT_SESSION_BINDING_PATH?.trim() || workspaceRoot;
  const codexBinPath =
    rawEnv.CODEX_BIN_PATH?.trim() || DEFAULT_CODEX_BIN_PATH;
  const codexConfigPath =
    rawEnv.CODEX_CONFIG_PATH?.trim() ||
    codexProfile.configPath ||
    DEFAULT_CODEX_CONFIG_PATH;
  const codexSessionsRoot =
    rawEnv.CODEX_SESSIONS_ROOT?.trim() || DEFAULT_CODEX_SESSIONS_ROOT;

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
    workspaceRoot,
    defaultSessionBindingPath,
    codexBinPath,
    codexConfigPath,
    codexSessionsRoot,
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
  const envFilePath = options.envFilePath || process.env.ENV_FILE || DEFAULT_ENV_FILE;
  const fileEnv = await loadEnvFile(envFilePath);
  const mergedEnv = {
    ...fileEnv,
    ...process.env,
    ENV_FILE: envFilePath,
  };
  const codexConfigPath =
    mergedEnv.CODEX_CONFIG_PATH?.trim() || DEFAULT_CODEX_CONFIG_PATH;
  const codexProfile = await loadCodexConfigProfile(codexConfigPath);

  return buildRuntimeConfig(mergedEnv, codexProfile);
}
