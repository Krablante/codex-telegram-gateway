import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

import { ensurePrivateDirectory, writeTextAtomic } from "../state/file-utils.js";
import { getCodexSpaceLayout } from "./codex-space.js";
import { runHostBash, shellQuote } from "./host-command-runner.js";

const MODELS_CACHE_FILE_NAME = "models_cache.json";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function expandHomePath(value, homeDir = null) {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }

  const resolvedHomeDir =
    normalizeOptionalText(homeDir)
    || normalizeOptionalText(process.env.HOME)
    || os.homedir();
  if (normalized === "~") {
    return resolvedHomeDir;
  }
  if (normalized.startsWith("~/")) {
    return resolvedHomeDir
      ? path.join(resolvedHomeDir, normalized.slice(2))
      : normalized;
  }

  return normalized;
}

export function getModelsCachePathForConfigPath(configPath) {
  const normalized = normalizeOptionalText(configPath);
  if (!normalized) {
    return null;
  }

  return path.join(path.dirname(normalized), MODELS_CACHE_FILE_NAME);
}

export function getCodexSpaceRootFromRegistryPath(registryPath) {
  const normalized = normalizeOptionalText(registryPath);
  if (!normalized) {
    return null;
  }

  return path.join(path.dirname(path.resolve(normalized)), "..", "codex-space");
}

export function getHostModelsCacheMirrorPath(codexSpaceRoot, hostId) {
  const normalizedHostId = normalizeOptionalText(hostId);
  if (!codexSpaceRoot || !normalizedHostId) {
    return null;
  }

  const hostLayout = getCodexSpaceLayout(codexSpaceRoot, normalizedHostId);
  return path.join(hostLayout.hostRendered, MODELS_CACHE_FILE_NAME);
}

async function removeMirror(snapshotPath) {
  if (!snapshotPath) {
    return;
  }

  await fs.rm(snapshotPath, { force: true });
}

async function writeMirror(snapshotPath, text) {
  const parsed = JSON.parse(text);
  await ensurePrivateDirectory(path.dirname(snapshotPath));
  await writeTextAtomic(
    snapshotPath,
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
}

function buildRemoteModelsCacheScript(configPath) {
  return [
    "set -euo pipefail",
    `config_path=${shellQuote(configPath)}`,
    'if [[ "$config_path" == "~" ]]; then config_path="$HOME"; elif [[ "$config_path" == "~/"* ]]; then config_path="$HOME/${config_path:2}"; fi',
    'cache_path="$(dirname "$config_path")/models_cache.json"',
    'if [[ -f "$cache_path" ]]; then cat "$cache_path"; fi',
  ].join("; ");
}

export async function captureHostModelsCacheSnapshot({
  codexSpaceRoot,
  connectTimeoutSecs,
  currentHostId,
  execFileImpl = execFile,
  host,
}) {
  const hostId = normalizeOptionalText(host?.host_id);
  const configPath = normalizeOptionalText(host?.codex_config_path);
  const snapshotPath = getHostModelsCacheMirrorPath(codexSpaceRoot, hostId);

  if (!hostId || !snapshotPath || !configPath) {
    await removeMirror(snapshotPath);
    return {
      hostId,
      snapshotPath,
      status: "missing-config",
    };
  }

  let rawText;
  if (hostId === normalizeOptionalText(currentHostId)) {
    const localCachePath = getModelsCachePathForConfigPath(expandHomePath(configPath));
    if (!localCachePath) {
      await removeMirror(snapshotPath);
      return {
        hostId,
        snapshotPath,
        status: "missing-config",
      };
    }
    try {
      rawText = await fs.readFile(localCachePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        await removeMirror(snapshotPath);
        return {
          hostId,
          snapshotPath,
          status: "missing",
        };
      }
      throw error;
    }
  } else {
    const { stdout } = await runHostBash({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      script: buildRemoteModelsCacheScript(configPath),
      maxBufferBytes: 8 * 1024 * 1024,
      timeoutMs: Math.max(connectTimeoutSecs * 1000, 5000),
    });
    rawText = stdout;
  }

  const trimmed = String(rawText || "").trim();
  if (!trimmed) {
    await removeMirror(snapshotPath);
    return {
      hostId,
      snapshotPath,
      status: "missing",
    };
  }

  try {
    await writeMirror(snapshotPath, trimmed);
  } catch (error) {
    await removeMirror(snapshotPath);
    throw new Error(
      `Invalid models cache for host ${hostId}: ${error.message}`,
      { cause: error },
    );
  }

  return {
    hostId,
    snapshotPath,
    status: "captured",
  };
}
