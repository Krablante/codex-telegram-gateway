import {
  accessSync,
  constants as fsConstants,
  statSync,
} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const WINDOWS_DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

function normalizeExecutableName(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function getPathModule(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function getWindowsEnvValue(env, key) {
  const matchingEntry = Object.entries(env ?? {})
    .filter(([candidate]) => String(candidate).toLowerCase() === key)
    .sort(([left], [right]) => left.localeCompare(right))
    .at(0);

  return typeof matchingEntry?.[1] === "string"
    ? matchingEntry[1]
    : "";
}

export function getExecutableSearchPathValue(
  env = process.env,
  platform = process.platform,
) {
  if (platform !== "win32") {
    return env?.PATH ?? "";
  }

  return getWindowsEnvValue(env, "path");
}

function splitPathValue(pathValue, platform) {
  const delimiter = platform === "win32" ? ";" : ":";
  return String(pathValue ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getExecutableVariants(executable, platform, env) {
  if (platform !== "win32") {
    return [executable];
  }

  if (path.win32.extname(executable)) {
    return [executable];
  }

  const extensions = getWindowsEnvValue(env, "pathext")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const pathExtensions = extensions.length > 0
    ? extensions
    : WINDOWS_DEFAULT_PATHEXT;

  return [
    executable,
    ...pathExtensions.map((extension) => `${executable}${extension}`),
  ];
}

function hasDirectoryComponent(executable) {
  return /[\\/]/u.test(executable);
}

function buildFileSystemLookupPaths(filePath, platform) {
  const candidates = [filePath];
  if (platform === "win32") {
    const hostNormalized = filePath.replace(/[\\/]/gu, path.sep);
    if (!candidates.includes(hostNormalized)) {
      candidates.push(hostNormalized);
    }
  }

  return candidates;
}

export function buildExecutableCandidatePaths(
  executable,
  options = {},
) {
  const {
    cwd = process.cwd(),
    preferredDirectories = [],
    platform = process.platform,
    env = process.env,
  } = options;
  const pathValue = options.pathValue ?? getExecutableSearchPathValue(env, platform);
  const normalized = normalizeExecutableName(executable);
  if (!normalized) {
    return [];
  }

  const pathModule = getPathModule(platform);
  const variants = getExecutableVariants(normalized, platform, env);

  if (pathModule.isAbsolute(normalized) || hasDirectoryComponent(normalized)) {
    const resolvedBase = pathModule.isAbsolute(normalized)
      ? normalized
      : pathModule.resolve(cwd, normalized);
    const resolvedVariants = getExecutableVariants(resolvedBase, platform, env);
    return [...new Set(resolvedVariants)];
  }

  const searchDirectories = [
    ...new Set([
      ...preferredDirectories.filter(Boolean),
      ...splitPathValue(pathValue, platform),
    ]),
  ];

  return searchDirectories.flatMap((directory) =>
    variants.map((variant) => pathModule.join(directory, variant)));
}

async function isExecutableFile(filePath, platform) {
  for (const candidatePath of buildFileSystemLookupPaths(filePath, platform)) {
    try {
      const stats = await fs.stat(candidatePath);
      if (!stats.isFile()) {
        continue;
      }

      await fs.access(
        candidatePath,
        platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
      );
      return true;
    } catch {}
  }

  return false;
}

function isExecutableFileSync(filePath, platform) {
  for (const candidatePath of buildFileSystemLookupPaths(filePath, platform)) {
    try {
      const stats = statSync(candidatePath);
      if (!stats.isFile()) {
        continue;
      }

      accessSync(
        candidatePath,
        platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
      );
      return true;
    } catch {}
  }

  return false;
}

export async function resolveExecutablePath(
  executable,
  options = {},
) {
  const normalized = normalizeExecutableName(executable);
  if (!normalized) {
    throw new Error("Executable path is empty");
  }

  const platform = options.platform ?? process.platform;
  const candidates = buildExecutableCandidatePaths(normalized, {
    ...options,
    platform,
  });

  for (const candidate of candidates) {
    if (await isExecutableFile(candidate, platform)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve executable: ${normalized}`);
}

export function resolveExecutablePathSync(
  executable,
  options = {},
) {
  const normalized = normalizeExecutableName(executable);
  if (!normalized) {
    throw new Error("Executable path is empty");
  }

  const platform = options.platform ?? process.platform;
  const candidates = buildExecutableCandidatePaths(normalized, {
    ...options,
    platform,
  });

  for (const candidate of candidates) {
    if (isExecutableFileSync(candidate, platform)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve executable: ${normalized}`);
}
