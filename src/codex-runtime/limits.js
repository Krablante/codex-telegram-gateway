import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { signalChildProcessTree } from "../runtime/process-tree.js";
import { spawnRuntimeCommand } from "../runtime/spawn-command.js";

const DEFAULT_CACHE_TTL_MS = 30 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 1000;
const MAX_CANDIDATE_FILES = 200;
const UNSUPPORTED_SHELL_OPERATOR_TOKENS = new Set([
  "|",
  "||",
  "&&",
  ";",
  "<",
  ">",
  ">>",
  "1>",
  "1>>",
  "2>",
  "2>>",
  "&",
]);

function coerceFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function coerceInteger(value) {
  const numeric = coerceFiniteNumber(value);
  return Number.isInteger(numeric) ? numeric : null;
}

function coerceBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return null;
}

function normalizeText(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function normalizeRateLimitWindow(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const usedPercent = coerceFiniteNumber(
    raw.used_percent ?? raw.usedPercent ?? null,
  );
  const windowMinutes = coerceInteger(
    raw.window_minutes ?? raw.windowDurationMins ?? null,
  );
  const resetsAt = coerceInteger(raw.resets_at ?? raw.resetsAt ?? null);

  if (usedPercent === null && windowMinutes === null && resetsAt === null) {
    return null;
  }

  return {
    usedPercent,
    windowMinutes,
    resetsAt,
  };
}

export function normalizeLimitsSnapshot(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const primary = normalizeRateLimitWindow(raw.primary);
  const secondary = normalizeRateLimitWindow(raw.secondary);
  const planType = normalizeText(raw.plan_type ?? raw.planType ?? null);
  const limitId = normalizeText(raw.limit_id ?? raw.limitId ?? null);
  const limitName = normalizeText(raw.limit_name ?? raw.limitName ?? null);
  const credits = raw.credits ?? null;
  const unlimited =
    coerceBoolean(raw.unlimited ?? raw.isUnlimited ?? null)
    ?? coerceBoolean(credits?.unlimited ?? credits?.isUnlimited ?? null)
    ?? false;

  if (!primary && !secondary && !planType && !limitId && !limitName && !credits && !unlimited) {
    return null;
  }

  return {
    limitId,
    limitName,
    planType,
    credits,
    unlimited,
    primary,
    secondary,
  };
}

function formatTimestamp(timestamp) {
  const normalized = coerceInteger(timestamp);
  if (normalized === null) {
    return null;
  }

  return new Date(normalized * 1000).toISOString();
}

function buildWindowSummary(rawWindow, label) {
  if (!rawWindow) {
    return null;
  }

  const usedPercent = coerceFiniteNumber(rawWindow.usedPercent);
  const remainingPercent = usedPercent === null
    ? null
    : Math.max(0, Math.min(100, 100 - usedPercent));
  return {
    label,
    usedPercent,
    remainingPercent,
    windowMinutes: coerceInteger(rawWindow.windowMinutes),
    resetsAt: coerceInteger(rawWindow.resetsAt),
    resetsAtIso: formatTimestamp(rawWindow.resetsAt),
  };
}

export function buildCodexLimitsSummary(
  snapshot,
  {
    capturedAt = null,
    source = null,
  } = {},
) {
  const normalized = normalizeLimitsSnapshot(snapshot);
  if (!normalized) {
    return {
      available: false,
      capturedAt: normalizeText(capturedAt),
      source: normalizeText(source),
      planType: null,
      limitName: null,
      unlimited: false,
      windows: [],
      primary: null,
      secondary: null,
    };
  }

  const windows = [
    buildWindowSummary(normalized.primary, "5h"),
    buildWindowSummary(normalized.secondary, "7d"),
  ].filter(Boolean);

  return {
    available: normalized.unlimited || windows.length > 0,
    capturedAt: normalizeText(capturedAt),
    source: normalizeText(source),
    planType: normalized.planType,
    limitName: normalized.limitName ?? normalized.limitId,
    credits: normalized.credits ?? null,
    unlimited: normalized.unlimited === true,
    primary: windows.find((window) => window.label === "5h") ?? null,
    secondary: windows.find((window) => window.label === "7d") ?? null,
    windows,
  };
}

function isEnglish(language) {
  return String(language ?? "").trim().toLowerCase() === "eng";
}

function formatPercent(value) {
  const normalized = coerceFiniteNumber(value);
  if (normalized === null) {
    return "unknown";
  }

  return `${Math.round(normalized)}%`;
}

function formatResetTime(isoText) {
  const normalized = normalizeText(isoText);
  if (!normalized) {
    return "unknown";
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return normalized;
  }

  return date.toISOString().replace(".000Z", " UTC");
}

export function buildCodexLimitsStatusLines(
  summary,
  language = "rus",
) {
  if (summary?.unlimited) {
    return [
      `${isEnglish(language) ? "limits" : "лимиты"}: ${
        isEnglish(language) ? "unlimited" : "безлимит"
      }`,
    ];
  }

  if (!summary?.available) {
    return [
      `${isEnglish(language) ? "limits" : "лимиты"}: ${
        isEnglish(language) ? "unavailable" : "недоступны"
      }`,
    ];
  }

  return summary.windows.map((window) =>
    `${
      isEnglish(language) ? `limits ${window.label}` : `лимиты ${window.label}`
    }: ${formatPercent(window.remainingPercent)} ${
      isEnglish(language) ? "left" : "осталось"
    } -> ${formatResetTime(window.resetsAtIso)}`);
}

export function buildCodexLimitsMenuLines(
  summary,
  language = "rus",
) {
  if (summary?.unlimited) {
    return [
      `${isEnglish(language) ? "limits" : "лимиты"}: ${
        isEnglish(language) ? "unlimited" : "безлимит"
      }`,
    ];
  }

  if (!summary?.available) {
    return [
      `${isEnglish(language) ? "limits" : "лимиты"}: ${
        isEnglish(language) ? "unavailable" : "недоступны"
      }`,
    ];
  }

  return summary.windows.map((window) =>
    `${
      isEnglish(language) ? `limits ${window.label}` : `лимиты ${window.label}`
    }: ${formatPercent(window.remainingPercent)} ${
      isEnglish(language) ? "left" : "осталось"
    }`);
}

export function formatCodexLimitsMessage(
  summary,
  language = "rus",
) {
  const english = isEnglish(language);
  if (summary?.unlimited) {
    return [
      english ? "Codex limits" : "Лимиты Codex",
      "",
      `${english ? "mode" : "режим"}: ${english ? "unlimited" : "безлимит"}`,
      ...(summary.planType
        ? [`${english ? "plan" : "план"}: ${summary.planType}`]
        : []),
      ...(summary.limitName
        ? [`${english ? "limit" : "лимит"}: ${summary.limitName}`]
        : []),
      ...(summary.source
        ? [`source: ${summary.source}`]
        : []),
      ...(summary.capturedAt
        ? [
            `${english ? "captured" : "снято"}: ${formatResetTime(summary.capturedAt)}`,
          ]
        : []),
    ].join("\n");
  }

  if (!summary?.available) {
    return [
      english ? "Codex limits" : "Лимиты Codex",
      "",
      english
        ? "No readable Codex limits snapshot is available right now."
        : "Сейчас нет читаемого snapshot с лимитами Codex.",
      ...(summary?.source
        ? [
            "",
            `source: ${summary.source}`,
          ]
        : []),
    ].join("\n");
  }

  const lines = [
    english ? "Codex limits" : "Лимиты Codex",
    "",
    ...(summary.planType
      ? [`${english ? "plan" : "план"}: ${summary.planType}`]
      : []),
    ...(summary.limitName
      ? [`${english ? "limit" : "лимит"}: ${summary.limitName}`]
      : []),
    ...(summary.source
      ? [`source: ${summary.source}`]
      : []),
    ...(summary.capturedAt
      ? [
          `${english ? "captured" : "снято"}: ${formatResetTime(summary.capturedAt)}`,
        ]
      : []),
    "",
  ];

  for (const window of summary.windows) {
    lines.push(
      `${window.label}: ${formatPercent(window.remainingPercent)} ${
        english ? "left" : "осталось"
      }`,
    );
    lines.push(
      `${
        english ? `${window.label} reset` : `${window.label} сброс`
      }: ${formatResetTime(window.resetsAtIso)}`,
    );
  }

  return lines.join("\n");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectJsonlFiles(root, files) {
  if (!root || !(await fileExists(root))) {
    return;
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(entryPath, files);
      continue;
    }
    if (path.extname(entry.name).toLowerCase() !== ".jsonl") {
      continue;
    }
    const stats = await fs.stat(entryPath);
    files.push({
      path: entryPath,
      modifiedMs: stats.mtimeMs,
    });
  }
}

function extractSnapshotFromEnvelope(envelope) {
  const payload = envelope?.payload;
  const info = payload?.info;
  return normalizeLimitsSnapshot(
    payload?.rate_limits
      ?? payload?.rateLimits
      ?? info?.rate_limits
      ?? info?.rateLimits
      ?? null,
  );
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

function mergeWindows(primaryWindow, nextWindow) {
  if (!primaryWindow) {
    return nextWindow ?? null;
  }
  if (!nextWindow) {
    return primaryWindow;
  }

  return {
    usedPercent:
      coerceFiniteNumber(nextWindow.usedPercent) !== null
      && (
        coerceFiniteNumber(primaryWindow.usedPercent) === null
        || nextWindow.usedPercent > primaryWindow.usedPercent
      )
        ? nextWindow.usedPercent
        : primaryWindow.usedPercent,
    windowMinutes:
      coerceInteger(primaryWindow.windowMinutes)
      ?? coerceInteger(nextWindow.windowMinutes),
    resetsAt:
      coerceInteger(primaryWindow.resetsAt)
      ?? coerceInteger(nextWindow.resetsAt),
  };
}

function mergeSnapshots(snapshots, fallback) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return fallback;
  }

  const merged = {
    ...fallback,
    unlimited: fallback?.unlimited === true,
    primary: mergeWindows(
      fallback.primary,
      null,
    ),
    secondary: mergeWindows(
      fallback.secondary,
      null,
    ),
  };

  for (const snapshot of snapshots) {
    merged.primary = mergeWindows(merged.primary, snapshot.primary);
    merged.secondary = mergeWindows(merged.secondary, snapshot.secondary);
    if (!merged.limitId && snapshot.limitId) {
      merged.limitId = snapshot.limitId;
    }
    if (!merged.limitName && snapshot.limitName) {
      merged.limitName = snapshot.limitName;
    }
    if (!merged.planType && snapshot.planType) {
      merged.planType = snapshot.planType;
    }
    if (!merged.credits && snapshot.credits) {
      merged.credits = snapshot.credits;
    }
    if (snapshot.unlimited === true) {
      merged.unlimited = true;
    }
  }

  return merged;
}

function selectAuthoritativeSnapshot(records) {
  const snapshots = Array.isArray(records)
    ? records.filter((record) => record?.snapshot)
    : [];
  if (snapshots.length === 0) {
    return null;
  }

  snapshots.sort((left, right) => {
    const leftCapturedAt = Date.parse(left.capturedAt ?? "") || 0;
    const rightCapturedAt = Date.parse(right.capturedAt ?? "") || 0;
    return rightCapturedAt - leftCapturedAt;
  });

  const newest = snapshots[0];
  const primaryReset = coerceInteger(newest.snapshot?.primary?.resetsAt);
  const secondaryReset = coerceInteger(newest.snapshot?.secondary?.resetsAt);

  const sameWindowSnapshots = snapshots
    .filter((record) =>
      coerceInteger(record.snapshot?.primary?.resetsAt) === primaryReset
      && coerceInteger(record.snapshot?.secondary?.resetsAt) === secondaryReset)
    .map((record) => record.snapshot);

  return {
    capturedAt: newest.capturedAt ?? null,
    snapshot: mergeSnapshots(sameWindowSnapshots, newest.snapshot),
  };
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
  candidates.sort((left, right) => right.modifiedMs - left.modifiedMs);

  const records = [];
  for (const candidate of candidates.slice(0, MAX_CANDIDATE_FILES)) {
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

    if (char === "'" || char === "\"") {
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

function parseCommandArgv(command) {
  const commandText = normalizeText(command);
  if (!commandText) {
    throw new Error("Codex limits command is empty");
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

async function runCommand(command, timeoutMs) {
  const { file, args } = parseCommandArgv(command);
  return new Promise((resolve, reject) => {
    const child = spawnRuntimeCommand(file, args, {
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
      signalChildProcessTree(child, "SIGTERM");
      reject(new Error(`Codex limits command timed out after ${timeoutMs}ms`));
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

function normalizeCommandSnapshotPayload(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const snapshot = normalizeLimitsSnapshot(
    raw.snapshot
      ?? raw.limits
      ?? raw.rate_limits
      ?? raw.rateLimits
      ?? raw,
  );
  if (!snapshot) {
    return null;
  }

  return {
    snapshot,
    capturedAt:
      normalizeText(raw.captured_at)
      ?? normalizeText(raw.capturedAt)
      ?? null,
    source:
      normalizeText(raw.source)
      ?? normalizeText(raw.host)
      ?? "command",
  };
}

async function readSnapshotFromCommand(command, timeoutMs) {
  const output = await runCommand(command, timeoutMs);
  if (!output) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(output);
  } catch (error) {
    throw new Error(`Codex limits command returned invalid JSON: ${error.message}`);
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
        value = await readSnapshotFromCommand(this.command, this.commandTimeoutMs);
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

export function getDefaultCodexHome({
  homeDirectory = os.homedir(),
  env = process.env,
  platform = process.platform,
} = {}) {
  if (env.CODEX_HOME) {
    return env.CODEX_HOME;
  }

  if (platform === "win32" && env.USERPROFILE) {
    return path.join(env.USERPROFILE, ".codex");
  }

  return path.join(homeDirectory, ".codex");
}
