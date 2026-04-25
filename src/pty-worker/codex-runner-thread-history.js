import path from "node:path";

const THREAD_HISTORY_PAGE_SIZE = 50;
const THREAD_HISTORY_MAX_PAGES = 200;

export function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectErrorTexts(error) {
  const values = [
    error?.message,
    error?.data?.message,
    error?.data?.error,
    error?.cause?.message,
  ];

  return values
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter(Boolean);
}

export function isIrrecoverableResumeError(error) {
  const code = Number(error?.code);
  if (code === 404 || code === -32602) {
    return true;
  }

  return collectErrorTexts(error).some((message) =>
    message.includes("thread not found")
    || message.includes("unknown thread")
    || message.includes("no such thread")
    || message.includes("missing thread")
    || message.includes("cannot resume thread"),
  );
}

export function isSteerRequestTimeoutError(error) {
  return String(error?.message || "").includes("Codex request turn/steer timed out");
}

export function isNoActiveTurnSteerError(error) {
  return collectErrorTexts(error).some((message) =>
    message.includes("no active turn to steer")
    || message.includes("no active turn")
    || message.includes("expected turn is not active"),
  );
}

function extractProviderSessionIdFromRolloutPath(rolloutPath) {
  const normalizedRolloutPath = normalizeOptionalText(rolloutPath);
  if (!normalizedRolloutPath) {
    return null;
  }

  const basename = path.basename(normalizedRolloutPath);
  const match = basename.match(/^rollout-(.+)\.jsonl$/u);
  return normalizeOptionalText(match?.[1] ?? null);
}

function classifyHistoricalThreadCandidate(thread, {
  knownRolloutPath,
  providerSessionId,
  sessionKeyMarker,
}) {
  const threadId = normalizeOptionalText(thread?.id);
  if (!threadId) {
    return null;
  }

  const threadRolloutPath = normalizeOptionalText(thread?.path);
  const preview = normalizeOptionalText(thread?.preview);
  if (
    knownRolloutPath
    && threadRolloutPath
    && threadRolloutPath === knownRolloutPath
  ) {
    return {
      rank: 3,
      threadId,
      rolloutPath: threadRolloutPath,
      providerSessionId:
        extractProviderSessionIdFromRolloutPath(threadRolloutPath)
        || providerSessionId,
    };
  }

  if (
    providerSessionId
    && threadRolloutPath
    && threadRolloutPath.includes(`rollout-${providerSessionId}`)
  ) {
    return {
      rank: 2,
      threadId,
      rolloutPath: threadRolloutPath,
      providerSessionId,
    };
  }

  if (sessionKeyMarker && preview?.includes(sessionKeyMarker)) {
    return {
      rank: 1,
      threadId,
      rolloutPath: threadRolloutPath,
      providerSessionId:
        extractProviderSessionIdFromRolloutPath(threadRolloutPath)
        || providerSessionId,
    };
  }

  return null;
}

export function findInProgressTurn(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (
      normalizeOptionalText(turn?.id)
      && normalizeOptionalText(turn?.status) === "inProgress"
    ) {
      return turn;
    }
  }

  return null;
}

export function findLatestTurn(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (normalizeOptionalText(turn?.id)) {
      return turn;
    }
  }

  return null;
}

export async function findLatestHistoricalThread({
  rpc,
  cwd,
  sessionKey,
  providerSessionId,
  knownRolloutPath = null,
}) {
  const normalizedSessionKey = normalizeOptionalText(sessionKey);
  const normalizedProviderSessionId = normalizeOptionalText(providerSessionId);
  const normalizedKnownRolloutPath = normalizeOptionalText(knownRolloutPath);
  if (
    !rpc
    || (!normalizedSessionKey && !normalizedProviderSessionId && !normalizedKnownRolloutPath)
  ) {
    return null;
  }

  const sessionKeyMarker = normalizedSessionKey
    ? `session_key: ${normalizedSessionKey}`
    : null;
  let bestCandidate = null;
  const seenThreadIds = new Set();
  const searchCwds = Array.from(new Set([
    normalizeOptionalText(cwd),
    null,
  ]));

  for (const searchCwd of searchCwds) {
    let cursor = null;
    for (let page = 0; page < THREAD_HISTORY_MAX_PAGES; page += 1) {
      const response = await rpc.request("thread/list", {
        archived: false,
        ...(searchCwd ? { cwd: searchCwd } : {}),
        cursor,
        limit: THREAD_HISTORY_PAGE_SIZE,
        sortKey: "updated_at",
      });
      const threads = Array.isArray(response?.data) ? response.data : [];
      for (const thread of threads) {
        const candidate = classifyHistoricalThreadCandidate(thread, {
          knownRolloutPath: normalizedKnownRolloutPath,
          providerSessionId: normalizedProviderSessionId,
          sessionKeyMarker,
        });
        if (!candidate || seenThreadIds.has(candidate.threadId)) {
          continue;
        }

        seenThreadIds.add(candidate.threadId);
        if (!bestCandidate || candidate.rank > bestCandidate.rank) {
          bestCandidate = candidate;
        }
        if (candidate.rank >= 3) {
          return candidate;
        }
      }

      cursor = normalizeOptionalText(response?.nextCursor);
      if (!cursor) {
        break;
      }
    }
  }

  return bestCandidate;
}
