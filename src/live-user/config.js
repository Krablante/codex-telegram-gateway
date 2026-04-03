import fs from "node:fs/promises";
import path from "node:path";

import { parseEnvText } from "../config/env-file.js";
import { ensureFileMode, writeTextAtomic } from "../state/file-utils.js";

export const LIVE_USER_TESTING_DIR_NAME = "live-user-testing";
export const TELEGRAM_USER_ENV_FILE_NAME = "telegram-user.env";
export const TELEGRAM_USER_SESSION_FILE_NAME = "telegram-user-session.txt";
export const TELEGRAM_USER_ACCOUNT_FILE_NAME = "telegram-user-account.json";
export const TELEGRAM_USER_PRIVATE_FILE_MODE = 0o600;

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function parsePositiveInteger(value, key) {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new Error(`Missing required Telegram user setting: ${key}`);
  }
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`Expected ${key} to be a positive integer, got: ${normalized}`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected ${key} to be > 0, got: ${normalized}`);
  }

  return parsed;
}

export function resolveTelegramUserPaths({
  stateRoot,
  envFilePath = null,
  sessionFilePath = null,
  accountFilePath = null,
} = {}) {
  const normalizedStateRoot = normalizeText(stateRoot);
  if (!normalizedStateRoot) {
    throw new Error("Missing required Telegram user setting: stateRoot");
  }

  const liveUserRoot = path.join(normalizedStateRoot, LIVE_USER_TESTING_DIR_NAME);

  return {
    liveUserRoot,
    envFilePath:
      normalizeText(envFilePath)
      || path.join(liveUserRoot, TELEGRAM_USER_ENV_FILE_NAME),
    sessionFilePath:
      normalizeText(sessionFilePath)
      || path.join(liveUserRoot, TELEGRAM_USER_SESSION_FILE_NAME),
    accountFilePath:
      normalizeText(accountFilePath)
      || path.join(liveUserRoot, TELEGRAM_USER_ACCOUNT_FILE_NAME),
  };
}

export function buildTelegramUserEnvTemplate(paths) {
  return [
    "# Telegram user-account bootstrap for live E2E/stress testing.",
    "# Fill API credentials from https://my.telegram.org/apps",
    "# Keep this file under state only; do not move it into git.",
    `# Session file: ${paths.sessionFilePath}`,
    `# Account metadata file: ${paths.accountFilePath}`,
    "",
    "TELEGRAM_USER_API_ID=",
    "TELEGRAM_USER_API_HASH=",
    "# Optional. If empty, the login CLI will ask for the phone number interactively.",
    "TELEGRAM_USER_PHONE=",
    "",
  ].join("\n");
}

export async function ensureTelegramUserBootstrapFiles(paths) {
  await fs.mkdir(paths.liveUserRoot, { recursive: true });
  await Promise.all([
    ensureFileMode(paths.envFilePath, TELEGRAM_USER_PRIVATE_FILE_MODE),
    ensureFileMode(paths.sessionFilePath, TELEGRAM_USER_PRIVATE_FILE_MODE),
    ensureFileMode(paths.accountFilePath, TELEGRAM_USER_PRIVATE_FILE_MODE),
  ]);

  try {
    await fs.access(paths.envFilePath);
    return { envTemplateCreated: false };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await writeTextAtomic(
    paths.envFilePath,
    buildTelegramUserEnvTemplate(paths),
    { mode: TELEGRAM_USER_PRIVATE_FILE_MODE },
  );
  return { envTemplateCreated: true };
}

export async function loadTelegramUserEnvFile(envFilePath) {
  try {
    const text = await fs.readFile(envFilePath, "utf8");
    return parseEnvText(text);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export function parseTelegramUserConfig(rawEnv, paths) {
  const apiHash = normalizeText(rawEnv?.TELEGRAM_USER_API_HASH);
  if (!apiHash) {
    throw new Error(
      `Missing required Telegram user setting: TELEGRAM_USER_API_HASH in ${paths.envFilePath}`,
    );
  }

  return {
    apiId: parsePositiveInteger(rawEnv?.TELEGRAM_USER_API_ID, "TELEGRAM_USER_API_ID"),
    apiHash,
    phoneNumber: normalizeText(rawEnv?.TELEGRAM_USER_PHONE),
    envFilePath: paths.envFilePath,
    sessionFilePath: paths.sessionFilePath,
    accountFilePath: paths.accountFilePath,
  };
}
