import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APP_DIR_NAME = "codex-telegram-gateway";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function isWindows(platform = process.platform) {
  return platform === "win32";
}

function getWindowsLocalAppData({
  homeDirectory = os.homedir(),
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  return localAppData?.trim() || path.join(homeDirectory, "AppData", "Local");
}

function getXdgConfigHome({
  homeDirectory = os.homedir(),
  xdgConfigHome = process.env.XDG_CONFIG_HOME,
} = {}) {
  return xdgConfigHome?.trim() || path.join(homeDirectory, ".config");
}

function getXdgStateHome({
  homeDirectory = os.homedir(),
  xdgStateHome = process.env.XDG_STATE_HOME,
} = {}) {
  return xdgStateHome?.trim() || path.join(homeDirectory, ".local", "state");
}

export function getDefaultRepoRoot() {
  return DEFAULT_REPO_ROOT;
}

export function getDefaultStateRoot(options = {}) {
  if (isWindows(options.platform)) {
    return path.join(getWindowsLocalAppData(options), APP_DIR_NAME);
  }

  return path.join(getXdgStateHome(options), APP_DIR_NAME);
}

export function getDefaultWorkspaceRoot(options = {}) {
  if (isWindows(options.platform)) {
    return path.dirname(options.repoRoot || getDefaultRepoRoot());
  }

  return options.homeDirectory || os.homedir();
}

export function getDefaultConfigRoot(options = {}) {
  if (isWindows(options.platform)) {
    return path.join(getWindowsLocalAppData(options), APP_DIR_NAME);
  }

  return path.join(getXdgConfigHome(options), APP_DIR_NAME);
}

export function getDefaultEnvFilePath(options = {}) {
  return path.join(
    options.stateRoot || options.configRoot || getDefaultConfigRoot(options),
    "runtime.env",
  );
}

export function getRepoEnvFilePath(options = {}) {
  return path.join(options.repoRoot || getDefaultRepoRoot(), ".env");
}

export function getDefaultCodexConfigPath({
  homeDirectory = os.homedir(),
} = {}) {
  return path.join(homeDirectory, ".codex", "config.toml");
}

export function getDefaultCodexSessionsRoot({
  homeDirectory = os.homedir(),
} = {}) {
  return path.join(homeDirectory, ".codex", "sessions");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRuntimeEnvFilePath({
  explicitEnvFilePath = process.env.ENV_FILE,
  repoRoot = getDefaultRepoRoot(),
  configRoot = getDefaultConfigRoot(),
  stateRoot = null,
} = {}) {
  const explicit = explicitEnvFilePath?.trim();
  if (explicit) {
    return explicit;
  }

  const defaultEnvFilePath = getDefaultEnvFilePath({ configRoot, stateRoot });
  if (await fileExists(defaultEnvFilePath)) {
    return defaultEnvFilePath;
  }

  const repoEnvFilePath = getRepoEnvFilePath({ repoRoot });
  if (await fileExists(repoEnvFilePath)) {
    return repoEnvFilePath;
  }

  return defaultEnvFilePath;
}
