import fs from "node:fs/promises";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { writeTextAtomic } from "../state/file-utils.js";
import {
  ensureTelegramUserBootstrapFiles,
  loadTelegramUserEnvFile,
  parseTelegramUserConfig,
  resolveTelegramUserPaths,
  TELEGRAM_USER_PRIVATE_FILE_MODE,
} from "./config.js";

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export async function loadTelegramUserBootstrap({
  envFilePath = process.env.TELEGRAM_USER_ENV_FILE || null,
  sessionFilePath = process.env.TELEGRAM_USER_SESSION_FILE || null,
  accountFilePath = process.env.TELEGRAM_USER_ACCOUNT_FILE || null,
} = {}) {
  const runtimeConfig = await loadRuntimeConfig();
  const paths = resolveTelegramUserPaths({
    stateRoot: runtimeConfig.stateRoot,
    envFilePath,
    sessionFilePath,
    accountFilePath,
  });
  const bootstrap = await ensureTelegramUserBootstrapFiles(paths);
  const rawEnv = await loadTelegramUserEnvFile(paths.envFilePath);
  let userConfig = null;
  let userConfigError = null;
  if (rawEnv && !bootstrap.envTemplateCreated) {
    try {
      userConfig = parseTelegramUserConfig(rawEnv, paths);
    } catch (error) {
      userConfigError = error;
    }
  }

  return {
    runtimeConfig,
    paths,
    userConfig,
    userConfigError,
    envTemplateCreated: bootstrap.envTemplateCreated,
  };
}

export async function readTelegramUserSession(paths) {
  try {
    return normalizeText(await fs.readFile(paths.sessionFilePath, "utf8")) || "";
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

export async function writeTelegramUserSession(paths, {
  sessionString,
  account,
}) {
  await writeTextAtomic(
    paths.sessionFilePath,
    `${normalizeText(sessionString) || ""}\n`,
    { mode: TELEGRAM_USER_PRIVATE_FILE_MODE },
  );
  await writeTextAtomic(
    paths.accountFilePath,
    `${JSON.stringify(account, null, 2)}\n`,
    { mode: TELEGRAM_USER_PRIVATE_FILE_MODE },
  );
}

export function buildTelegramUserAccountSnapshot(me) {
  return {
    id: String(me?.id ?? ""),
    username: normalizeText(me?.username),
    phone: normalizeText(me?.phone),
    first_name: normalizeText(me?.firstName),
    last_name: normalizeText(me?.lastName),
    saved_at: new Date().toISOString(),
  };
}
