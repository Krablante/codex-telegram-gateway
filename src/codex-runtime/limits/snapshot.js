import {
  coerceBoolean,
  coerceFiniteNumber,
  coerceInteger,
  formatTimestamp,
  normalizeText,
} from "./common.js";

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

export function extractSnapshotFromEnvelope(envelope) {
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

export function selectAuthoritativeSnapshot(records) {
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

export function normalizeCommandSnapshotPayload(raw) {
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
