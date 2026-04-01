import fs from "node:fs/promises";
import path from "node:path";

function normalizeUsageCount(value) {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.trunc(value);
}

export function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const inputTokens = normalizeUsageCount(usage.input_tokens);
  const cachedInputTokens = normalizeUsageCount(
    usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens,
  );
  const outputTokens = normalizeUsageCount(usage.output_tokens);
  const reasoningTokens = normalizeUsageCount(
    usage.reasoning_output_tokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      usage.reasoning_tokens,
  );
  const totalTokens = normalizeUsageCount(
    usage.total_tokens ??
      (inputTokens === null && outputTokens === null
        ? null
        : (inputTokens ?? 0) + (outputTokens ?? 0)),
  );

  if (
    inputTokens === null &&
    cachedInputTokens === null &&
    outputTokens === null &&
    reasoningTokens === null &&
    totalTokens === null
  ) {
    return null;
  }

  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: totalTokens,
  };
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
  const rolloutPath =
    typeof snapshot.rollout_path === "string"
      ? snapshot.rollout_path
      : typeof snapshot.rolloutPath === "string"
        ? snapshot.rolloutPath
        : null;

  if (lastTokenUsage === null && modelContextWindow === null) {
    return null;
  }

  return {
    captured_at: capturedAt,
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

async function findRolloutPathInDay(dayPath, threadId) {
  const entries = await fs.readdir(dayPath, { withFileTypes: true });
  const file = entries.find(
    (entry) =>
      entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`),
  );
  return file ? path.join(dayPath, file.name) : null;
}

async function findRolloutPathByThreadId(sessionsRoot, threadId) {
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
          threadId,
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
  sessionsRoot,
  knownRolloutPath = null,
}) {
  if (!threadId || !sessionsRoot) {
    return {
      rolloutPath: null,
      snapshot: null,
    };
  }

  const rolloutPath =
    knownRolloutPath && (await fileExists(knownRolloutPath))
      ? knownRolloutPath
      : await findRolloutPathByThreadId(sessionsRoot, threadId);

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

  for (const line of lines) {
    let event = null;
    try {
      event = JSON.parse(line);
    } catch {
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
      model_context_window: taskStartedWindow,
      rollout_path: rolloutPath,
    });
  }

  return {
    rolloutPath,
    snapshot: latestSnapshot,
  };
}
