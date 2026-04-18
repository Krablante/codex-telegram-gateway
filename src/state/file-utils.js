import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { retryFilesystemOperation } from "../runtime/fs-retry.js";

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function buildTempPath(filePath) {
  return `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildCorruptPath(filePath) {
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

export async function writeTextAtomic(
  filePath,
  content,
  { mode = null, platform = process.platform } = {},
) {
  const effectiveMode =
    mode !== null && supportsPosixFileModes(platform)
      ? mode
      : null;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = buildTempPath(filePath);
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
}
