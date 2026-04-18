import fs from "node:fs/promises";
import path from "node:path";

import {
  normalizeTokenUsage,
  normalizeUsageCount,
} from "../codex-runtime/token-usage.js";

function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function normalizeContextSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const lastTokenUsage = normalizeTokenUsage(
    snapshot.last_token_usage ?? snapshot.lastTokenUsage ?? snapshot.usage,
  );
  const modelContextWindow = normalizeUsageCount(
    snapshot.model_context_window ??
      snapshot.modelContextWindow ??
      snapshot.context_window,
  );
  const capturedAt =
    typeof snapshot.captured_at === "string"
      ? snapshot.captured_at
      : typeof snapshot.capturedAt === "string"
        ? snapshot.capturedAt
        : null;
  const sessionId =
    typeof snapshot.session_id === "string"
      ? snapshot.session_id
      : typeof snapshot.sessionId === "string"
        ? snapshot.sessionId
        : null;
  const threadId =
    typeof snapshot.thread_id === "string"
      ? snapshot.thread_id
      : typeof snapshot.threadId === "string"
        ? snapshot.threadId
        : null;
  const rolloutPath =
    typeof snapshot.rollout_path === "string"
      ? snapshot.rollout_path
      : typeof snapshot.rolloutPath === "string"
        ? snapshot.rolloutPath
        : null;

  if (
    lastTokenUsage === null &&
    modelContextWindow === null &&
    sessionId === null &&
    threadId === null &&
    rolloutPath === null
  ) {
    return null;
  }

  return {
    captured_at: capturedAt,
    session_id: sessionId,
    thread_id: threadId,
    model_context_window: modelContextWindow,
    last_token_usage: lastTokenUsage,
    rollout_path: rolloutPath,
  };
}

export function buildLegacyContextSnapshot({ usage, contextWindow } = {}) {
  return normalizeContextSnapshot({
    model_context_window: contextWindow ?? null,
    last_token_usage: usage ?? null,
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function findRolloutPathInDay(dayPath, suffix) {
  const entries = await fs.readdir(dayPath, { withFileTypes: true });
  const file = entries.find(
    (entry) =>
      entry.isFile() && entry.name.endsWith(`${suffix}.jsonl`),
  );
  return file ? path.join(dayPath, file.name) : null;
}

async function findRolloutPathBySuffix(sessionsRoot, suffix) {
  if (!suffix) {
    return null;
  }

  let years = [];
  try {
    years = await fs.readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const yearDirs = years
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => right.name.localeCompare(left.name));

  for (const year of yearDirs) {
    const yearPath = path.join(sessionsRoot, year.name);
    const months = await fs.readdir(yearPath, { withFileTypes: true });
    const monthDirs = months
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => right.name.localeCompare(left.name));

    for (const month of monthDirs) {
      const monthPath = path.join(yearPath, month.name);
      const days = await fs.readdir(monthPath, { withFileTypes: true });
      const dayDirs = days
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => right.name.localeCompare(left.name));

      for (const day of dayDirs) {
        const rolloutPath = await findRolloutPathInDay(
          path.join(monthPath, day.name),
          suffix,
        );
        if (rolloutPath) {
          return rolloutPath;
        }
      }
    }
  }

  return null;
}

export async function readLatestContextSnapshot({
  threadId,
  providerSessionId = null,
  sessionsRoot,
  knownRolloutPath = null,
}) {
  const normalizedThreadId = normalizeOptionalText(threadId);
  const normalizedProviderSessionId = normalizeOptionalText(providerSessionId);

  if ((!normalizedThreadId && !normalizedProviderSessionId) || !sessionsRoot) {
    return {
      rolloutPath: null,
      snapshot: null,
    };
  }

  const rolloutPath =
    knownRolloutPath && (await fileExists(knownRolloutPath))
      ? knownRolloutPath
      : await findRolloutPathBySuffix(
          sessionsRoot,
          normalizedProviderSessionId,
        ) || await findRolloutPathBySuffix(sessionsRoot, normalizedThreadId);

  if (!rolloutPath) {
    return {
      rolloutPath: null,
      snapshot: null,
    };
  }

  const text = await fs.readFile(rolloutPath, "utf8");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let taskStartedWindow = null;
  let latestSnapshot = null;
  let discoveredSessionId = normalizedProviderSessionId;

  for (const line of lines) {
    let event = null;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "session_meta") {
      const nextSessionId = normalizeOptionalText(event.payload?.id);
      if (nextSessionId) {
        discoveredSessionId = nextSessionId;
      }
      continue;
    }

    if (event.type !== "event_msg" || !event.payload) {
      continue;
    }

    if (event.payload.type === "task_started") {
      const nextWindow = normalizeUsageCount(event.payload.model_context_window);
      if (nextWindow !== null) {
        taskStartedWindow = nextWindow;
      }
      continue;
    }

    if (event.payload.type !== "token_count" || !event.payload.info) {
      continue;
    }

    const snapshot = normalizeContextSnapshot({
      captured_at: event.timestamp ?? null,
      session_id: discoveredSessionId,
      thread_id: normalizedThreadId,
      model_context_window:
        event.payload.info.model_context_window ?? taskStartedWindow,
      last_token_usage: event.payload.info.last_token_usage,
      rollout_path: rolloutPath,
    });
    if (snapshot) {
      latestSnapshot = snapshot;
    }
  }

  if (!latestSnapshot && taskStartedWindow !== null) {
    latestSnapshot = normalizeContextSnapshot({
      session_id: discoveredSessionId,
      thread_id: normalizedThreadId,
      model_context_window: taskStartedWindow,
      rollout_path: rolloutPath,
    });
  }

  if (!latestSnapshot && (discoveredSessionId || normalizedThreadId || rolloutPath)) {
    latestSnapshot = normalizeContextSnapshot({
      session_id: discoveredSessionId,
      thread_id: normalizedThreadId,
      rollout_path: rolloutPath,
    });
  }

  return {
    rolloutPath,
    snapshot: latestSnapshot,
  };
}
