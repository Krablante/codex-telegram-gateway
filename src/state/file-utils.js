import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { retryFilesystemOperation } from "../runtime/fs-retry.js";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildTempPath(filePath) {
  return `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildCorruptPath(filePath) {
  return `${filePath}.corrupt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function supportsPosixFileModes(platform = process.platform) {
  return platform !== "win32";
}

export async function quarantineCorruptFile(filePath) {
  try {
    await fs.rename(filePath, buildCorruptPath(filePath));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function ensureFileMode(
  filePath,
  mode,
  { platform = process.platform } = {},
) {
  if (!supportsPosixFileModes(platform)) {
    return;
  }

  try {
    await fs.chmod(filePath, mode);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function ensureDirectoryMode(
  dirPath,
  mode = PRIVATE_DIRECTORY_MODE,
  { platform = process.platform } = {},
) {
  if (!supportsPosixFileModes(platform)) {
    return;
  }

  try {
    await fs.chmod(dirPath, mode);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

export async function ensurePrivateDirectory(
  dirPath,
  { mode = PRIVATE_DIRECTORY_MODE, platform = process.platform } = {},
) {
  await fs.mkdir(
    dirPath,
    supportsPosixFileModes(platform)
      ? { recursive: true, mode }
      : { recursive: true },
  );
  await ensureDirectoryMode(dirPath, mode, { platform });
}

export async function writeTextAtomic(
  filePath,
  content,
  { mode = PRIVATE_FILE_MODE, platform = process.platform } = {},
) {
  const effectiveMode =
    mode !== null && supportsPosixFileModes(platform)
      ? mode
      : null;
  await ensurePrivateDirectory(path.dirname(filePath), { platform });
  const tempPath = buildTempPath(filePath);
  try {
    await fs.writeFile(
      tempPath,
      content,
      effectiveMode === null
        ? "utf8"
        : {
            encoding: "utf8",
            mode: effectiveMode,
          },
    );
    if (effectiveMode !== null) {
      await ensureFileMode(tempPath, effectiveMode, { platform });
    }
    await retryFilesystemOperation(
      () => fs.rename(tempPath, filePath),
      { platform },
    );
    if (effectiveMode !== null) {
      await ensureFileMode(filePath, effectiveMode, { platform });
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeTextAtomicIfChanged(
  filePath,
  content,
  options = {},
) {
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === content) {
      return false;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await writeTextAtomic(filePath, content, options);
  return true;
}

export async function appendTextFile(
  filePath,
  content,
  { mode = PRIVATE_FILE_MODE, platform = process.platform } = {},
) {
  await ensurePrivateDirectory(path.dirname(filePath), { platform });
  const effectiveMode =
    mode !== null && supportsPosixFileModes(platform)
      ? mode
      : undefined;
  await fs.appendFile(
    filePath,
    content,
    effectiveMode === undefined
      ? "utf8"
      : {
          encoding: "utf8",
          mode: effectiveMode,
        },
  );
  if (effectiveMode !== undefined) {
    await ensureFileMode(filePath, effectiveMode, { platform });
  }
}
