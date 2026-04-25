import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { signalChildProcessTree } from "../../runtime/process-tree.js";
import { spawnRuntimeCommand } from "../../runtime/spawn-command.js";
import {
  COMMAND_TIMEOUT_KILL_GRACE_MS,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_CANDIDATE_FILES,
  UNSUPPORTED_SHELL_OPERATOR_TOKENS,
  normalizeText,
} from "./common.js";
import {
  buildCodexLimitsSummary,
  extractSnapshotFromEnvelope,
  normalizeCommandSnapshotPayload,
  selectAuthoritativeSnapshot,
} from "./snapshot.js";

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function rememberCandidateFile(files, candidate, maxFiles = MAX_CANDIDATE_FILES) {
  files.push(candidate);
  files.sort((left, right) => right.modifiedMs - left.modifiedMs);
  if (files.length > maxFiles) {
    files.length = maxFiles;
  }
}

async function collectJsonlFiles(root, files, { maxFiles = MAX_CANDIDATE_FILES } = {}) {
  if (!root || !(await fileExists(root))) {
    return;
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(entryPath, files, { maxFiles });
      continue;
    }
    if (path.extname(entry.name).toLowerCase() !== ".jsonl") {
      continue;
    }
    const stats = await fs.stat(entryPath);
    rememberCandidateFile(files, {
      path: entryPath,
      modifiedMs: stats.mtimeMs,
    }, maxFiles);
  }
}

async function parseSnapshotsFromFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const snapshots = [];
  for (const line of raw.split(/\r?\n/gu)) {
    if (!line.trim()) {
      continue;
    }

    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch {
      continue;
    }

    const snapshot = extractSnapshotFromEnvelope(envelope);
    if (!snapshot) {
      continue;
    }

    snapshots.push({
      capturedAt:
        normalizeText(envelope?.timestamp)
        ?? normalizeText(envelope?.payload?.timestamp)
        ?? null,
      snapshot,
    });
  }

  return snapshots;
}

async function readSnapshotFromSessionsRoot(sessionsRoot) {
  const normalizedSessionsRoot = normalizeText(sessionsRoot);
  if (!normalizedSessionsRoot) {
    return null;
  }

  const archivedRoot = path.join(
    path.dirname(normalizedSessionsRoot),
    "archived_sessions",
  );
  const candidates = [];
  await collectJsonlFiles(normalizedSessionsRoot, candidates);
  await collectJsonlFiles(archivedRoot, candidates);

  const records = [];
  for (const candidate of candidates) {
    records.push(...(await parseSnapshotsFromFile(candidate.path)));
  }

  const selected = selectAuthoritativeSnapshot(records);
  if (!selected?.snapshot) {
    return null;
  }

  return {
    snapshot: selected.snapshot,
    capturedAt: selected.capturedAt,
    source: normalizedSessionsRoot,
  };
}

function normalizeCommandArgv(rawArgv) {
  if (!Array.isArray(rawArgv) || rawArgv.length === 0) {
    throw new Error("Codex limits command must be a non-empty JSON array of strings");
  }

  if (rawArgv.some((value) => typeof value !== "string")) {
    throw new Error("Codex limits command JSON array must contain only strings");
  }

  if (!normalizeText(rawArgv[0])) {
    throw new Error("Codex limits command executable must be a non-empty string");
  }

  return rawArgv;
}

function tokenizeLegacyCommand(commandText) {
  const tokens = [];
  let current = "";
  let quote = null;
  let tokenStarted = false;

  for (const char of commandText) {
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      tokenStarted = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (quote) {
    throw new Error(
      "Codex limits command contains an unterminated quote; prefer JSON array syntax",
    );
  }

  if (tokenStarted) {
    tokens.push(current);
  }

  return tokens;
}

function usesInlineEnvAssignments(tokens) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/u.test(token)) {
      return true;
    }
    break;
  }

  return false;
}

function parseCommandArgv(command, { platform = process.platform } = {}) {
  const commandText = normalizeText(command);
  if (!commandText) {
    throw new Error("Codex limits command is empty");
  }

  if (platform === "win32" && !commandText.startsWith("[")) {
    throw new Error(
      "Codex limits command on Windows must use JSON array argv syntax; legacy string parsing is POSIX-only.",
    );
  }

  const argv = commandText.startsWith("[")
    ? normalizeCommandArgv(JSON.parse(commandText))
    : tokenizeLegacyCommand(commandText);

  if (argv.length === 0 || !normalizeText(argv[0])) {
    throw new Error("Codex limits command executable is missing");
  }

  if (usesInlineEnvAssignments(argv)) {
    throw new Error(
      "Codex limits command no longer supports inline env assignments; use a wrapper script or JSON array argv",
    );
  }

  if (argv.some((token) => UNSUPPORTED_SHELL_OPERATOR_TOKENS.has(token))) {
    throw new Error(
      "Codex limits command no longer supports implicit shell operators; use a wrapper script or explicit shell argv",
    );
  }

  return {
    file: argv[0],
    args: argv.slice(1),
  };
}

async function runCommand(command, timeoutMs, platform = process.platform) {
  const { file, args } = parseCommandArgv(command, { platform });
  return new Promise((resolve, reject) => {
    const child = spawnRuntimeCommand(file, args, {
      platform,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      void (async () => {
        try {
          signalChildProcessTree(child, "SIGTERM");
          await new Promise((resolveGrace) => setTimeout(resolveGrace, COMMAND_TIMEOUT_KILL_GRACE_MS));
          signalChildProcessTree(child, "SIGKILL");
        } catch {}
        reject(new Error(`Codex limits command timed out after ${timeoutMs}ms`));
      })();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim()
              || `Codex limits command exited with status ${code}`,
          ),
        );
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function readSnapshotFromCommand(
  command,
  timeoutMs,
  platform = process.platform,
) {
  const output = await runCommand(command, timeoutMs, platform);
  if (!output) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(output);
  } catch (error) {
    throw new Error(`Codex limits command returned invalid JSON: ${error.message}`, {
      cause: error,
    });
  }

  return normalizeCommandSnapshotPayload(payload);
}

function getConfiguredSourceLabel({ command = null, sessionsRoot = null } = {}) {
  if (normalizeText(command)) {
    return "command";
  }

  return normalizeText(sessionsRoot);
}

export class CodexLimitsService {
  constructor({
    sessionsRoot = null,
    command = null,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    now = () => Date.now(),
    platform = process.platform,
  } = {}) {
    this.sessionsRoot = normalizeText(sessionsRoot);
    this.command = normalizeText(command);
    this.cacheTtlMs = Number.isInteger(cacheTtlMs) && cacheTtlMs > 0
      ? cacheTtlMs
      : DEFAULT_CACHE_TTL_MS;
    this.commandTimeoutMs =
      Number.isInteger(commandTimeoutMs) && commandTimeoutMs > 0
        ? commandTimeoutMs
        : DEFAULT_COMMAND_TIMEOUT_MS;
    this.now = now;
    this.platform = platform;
    this.cachedRecord = null;
    this.inFlightPromise = null;
  }

  async getSummary({ force = false, allowStale = false } = {}) {
    const record = await this.getSnapshotRecord({ force, allowStale });
    return buildCodexLimitsSummary(record?.snapshot ?? null, {
      capturedAt: record?.capturedAt ?? null,
      source: record?.source ?? null,
    });
  }

  async getSnapshotRecord({ force = false, allowStale = false } = {}) {
    if (!force && this.cachedRecord && this.isCacheFresh(this.cachedRecord)) {
      return this.cachedRecord.value;
    }

    if (!force && this.inFlightPromise) {
      if (allowStale && this.cachedRecord?.value) {
        return this.cachedRecord.value;
      }
      return this.inFlightPromise;
    }

    if (!force && allowStale && this.cachedRecord?.value) {
      this.refreshInBackground();
      return this.cachedRecord.value;
    }

    this.inFlightPromise = this.refresh();
    try {
      return await this.inFlightPromise;
    } finally {
      this.inFlightPromise = null;
    }
  }

  refreshInBackground() {
    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = this.refresh()
      .catch(() => this.cachedRecord?.value ?? null)
      .finally(() => {
        this.inFlightPromise = null;
      });
    return this.inFlightPromise;
  }

  isCacheFresh(record) {
    return (this.now() - record.fetchedAt) < this.cacheTtlMs;
  }

  async refresh() {
    const source = getConfiguredSourceLabel({
      command: this.command,
      sessionsRoot: this.sessionsRoot,
    });
    let value = null;
    try {
      if (this.command) {
        value = await readSnapshotFromCommand(
          this.command,
          this.commandTimeoutMs,
          this.platform,
        );
      } else if (this.sessionsRoot) {
        value = await readSnapshotFromSessionsRoot(this.sessionsRoot);
      }
    } catch {
      value = {
        snapshot: null,
        capturedAt: null,
        source,
      };
    }

    if (!value && source) {
      value = {
        snapshot: null,
        capturedAt: null,
        source,
      };
    }

    this.cachedRecord = {
      fetchedAt: this.now(),
      value,
    };
    return value;
  }
}
