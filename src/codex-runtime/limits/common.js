export const DEFAULT_CACHE_TTL_MS = 30 * 1000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 1000;
export const COMMAND_TIMEOUT_KILL_GRACE_MS = 250;
export const MAX_CANDIDATE_FILES = 200;
export const UNSUPPORTED_SHELL_OPERATOR_TOKENS = new Set([
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

export function coerceFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function coerceInteger(value) {
  const numeric = coerceFiniteNumber(value);
  return Number.isInteger(numeric) ? numeric : null;
}

export function coerceBoolean(value) {
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

export function normalizeText(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

export function formatTimestamp(timestamp) {
  const normalized = coerceInteger(timestamp);
  if (normalized === null) {
    return null;
  }

  return new Date(normalized * 1000).toISOString();
}

export function isEnglish(language) {
  return String(language ?? "").trim().toLowerCase() === "eng";
}

export function formatPercent(value) {
  const normalized = coerceFiniteNumber(value);
  if (normalized === null) {
    return "unknown";
  }

  return `${Math.round(normalized)}%`;
}

export function formatResetTime(isoText) {
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
