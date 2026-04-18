import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { appendCodexRuntimeConfigArgs } from "../codex-runtime/config-args.js";
import { spawnRuntimeCommand } from "../runtime/spawn-command.js";
import { signalChildProcessTree } from "../runtime/process-tree.js";
import { readLatestContextSnapshot } from "../session-manager/context-snapshot.js";
import {
  hasChildExited,
  isRelevantWarning,
  summarizeCodexEvent,
} from "./codex-runner-common.js";
import {
  createSummaryTracker,
  followRolloutAfterDisconnect,
  readRolloutDelta,
  summarizeRolloutLine,
  watchRolloutForTaskComplete,
} from "./codex-runner-recovery.js";
import {
  createJsonRpcClient,
  openWebSocket,
  waitForListenUrl,
} from "./codex-runner-transport.js";

const APP_SERVER_BOOT_TIMEOUT_MS = 15000;
const APP_SERVER_HOST = "127.0.0.1";
const APP_SERVER_SHUTDOWN_GRACE_MS = 5000;
const ROLLOUT_DISCOVERY_TIMEOUT_MS = 5000;
const ROLLOUT_POLL_INTERVAL_MS = 1000;
const ROLLOUT_STALL_AFTER_CHILD_EXIT_MS = 5000;
const ROLLOUT_STALL_WITHOUT_CHILD_EXIT_MS = 30000;
const TRANSPORT_REATTACH_RETRY_DELAY_MS = 50;
const TRANSPORT_REATTACH_TIMEOUT_MS = 1500;
const STEER_ACTIVE_TURN_REFRESH_RETRY_DELAYS_MS = [150, 350, 750, 1500];
const TURN_COMPLETION_FINAL_MESSAGE_GRACE_MS = 1000;
const THREAD_HISTORY_PAGE_SIZE = 50;
const THREAD_HISTORY_MAX_PAGES = 200;
const CODEX_SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");

export { hasChildExited, summarizeCodexEvent } from "./codex-runner-common.js";
export { waitForListenUrl } from "./codex-runner-transport.js";

export function buildCodexArgs({
  listenUrl = `ws://${APP_SERVER_HOST}:0`,
  model = null,
  reasoningEffort = null,
  sandboxMode = "danger-full-access",
  approvalPolicy = "never",
} = {}) {
  const args = [
    "app-server",
    "--listen",
    listenUrl,
  ];
  return appendCodexRuntimeConfigArgs(args, {
    model,
    reasoningEffort,
    sandboxMode,
    approvalPolicy,
  });
}

export function buildTurnInput({
  prompt = "",
  imagePaths = [],
}) {
  const input = [];
  const normalizedPrompt = String(prompt || "");
  if (normalizedPrompt.trim()) {
    input.push({
      type: "text",
      text: normalizedPrompt,
    });
  }

  for (const imagePath of imagePaths) {
    input.push({
      type: "localImage",
      path: imagePath,
    });
  }

  return input;
}

function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function sleep(ms) {
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

function isIrrecoverableResumeError(error) {
  const code = Number(error?.code);
  if (code === 404 || code === -32602) {
    return true;
  }

  return collectErrorTexts(error).some((message) =>
    message.includes("thread not found") ||
    message.includes("unknown thread") ||
    message.includes("no such thread") ||
    message.includes("missing thread") ||
    message.includes("cannot resume thread"),
  );
}

function isNoActiveTurnSteerError(error) {
  return collectErrorTexts(error).some((message) =>
    message.includes("no active turn to steer") ||
    message.includes("no active turn") ||
    message.includes("expected turn is not active"),
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

function findInProgressTurn(thread) {
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

function findLatestTurn(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (normalizeOptionalText(turn?.id)) {
      return turn;
    }
  }

  return null;
}

async function findLatestHistoricalThread({
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

export function runCodexTask({
  codexBinPath,
  cwd,
  prompt,
  sessionKey = null,
  sessionThreadId = null,
  providerSessionId = null,
  skipThreadHistoryLookup = false,
  imagePaths = [],
  onEvent,
  onWarning,
  onRuntimeState = null,
  spawnImpl,
  openWebSocketImpl = openWebSocket,
  codexSessionsRoot = CODEX_SESSIONS_ROOT,
  appServerBootTimeoutMs = APP_SERVER_BOOT_TIMEOUT_MS,
  rolloutDiscoveryTimeoutMs = ROLLOUT_DISCOVERY_TIMEOUT_MS,
  rolloutPollIntervalMs = ROLLOUT_POLL_INTERVAL_MS,
  rolloutStallAfterChildExitMs = ROLLOUT_STALL_AFTER_CHILD_EXIT_MS,
  rolloutStallWithoutChildExitMs = ROLLOUT_STALL_WITHOUT_CHILD_EXIT_MS,
  transportReattachRetryDelayMs = TRANSPORT_REATTACH_RETRY_DELAY_MS,
  transportReattachTimeoutMs = TRANSPORT_REATTACH_TIMEOUT_MS,
  model = null,
  reasoningEffort = null,
  platform = process.platform,
}) {
  const args = buildCodexArgs({
    model,
    reasoningEffort,
  });
  const child = spawnRuntimeCommand(codexBinPath, args, {
    cwd,
    env: process.env,
    platform,
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32",
    spawnImpl,
  });

  const stdoutReader = readline.createInterface({ input: child.stdout });
  const stderrReader = readline.createInterface({ input: child.stderr });
  const warnings = [];
  const initialInput = buildTurnInput({ prompt, imagePaths });
  let latestThreadId = sessionThreadId;
  let primaryThreadId = sessionThreadId;
  let latestProviderSessionId = providerSessionId;
  let activeTurnId = null;
  let listenUrl = null;
  let rolloutPath = null;
  let rolloutObservedOffset = null;
  let latestContextSnapshot = null;
  let resumeReplacement = null;
  let rpc = null;
  let shuttingDown = false;
  let settled = false;
  let recoveringFromDisconnect = false;
  let allowRolloutWatcherDuringRecovery = false;
  let interruptRequested = false;
  let recoveryChildExit = null;
  let flushChain = Promise.resolve();
  let notificationChain = Promise.resolve();
  const pendingSteerInputs = [];
  let sawPrimaryFinalAnswer = false;
  let pendingTurnCompletion = false;
  let pendingTurnCompletionTimer = null;
  let rolloutTaskCompleteWatcher = null;
  let finishedResolve = () => {};
  let finishedReject = () => {};
  const summaryTracker = createSummaryTracker();

  const finished = new Promise((resolve, reject) => {
    finishedResolve = resolve;
    finishedReject = reject;
  });

  const finish = (payload) => {
    if (settled) {
      return;
    }

    settled = true;
    finishedResolve(payload);
  };

  const fail = (error) => {
    if (settled) {
      return;
    }

    settled = true;
    finishedReject(error);
  };

  const stopChild = () => {
    if (hasChildExited(child)) {
      return;
    }

    signalChildProcessTree(child, "SIGTERM");

    setTimeout(() => {
      if (!hasChildExited(child)) {
        signalChildProcessTree(child, "SIGKILL");
      }
    }, APP_SERVER_SHUTDOWN_GRACE_MS).unref();
  };

  const shutdownTransport = () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    try {
      rpc?.close();
    } catch {}
    stopChild();
  };

  const clearPendingTurnCompletion = () => {
    pendingTurnCompletion = false;
    if (!pendingTurnCompletionTimer) {
      return;
    }

    clearTimeout(pendingTurnCompletionTimer);
    pendingTurnCompletionTimer = null;
  };

  const finishCompletedTurn = () => {
    allowRolloutWatcherDuringRecovery = false;
    clearPendingTurnCompletion();
    shutdownTransport();
    finish({
      exitCode: 0,
      signal: null,
      providerSessionId: latestProviderSessionId,
      rolloutPath,
      contextSnapshot: latestContextSnapshot,
      threadId: latestThreadId,
      warnings,
      resumeReplacement: null,
    });
  };

  const buildTransportResumeReplacement = (
    requestedThreadId = latestThreadId || primaryThreadId || sessionThreadId || null,
  ) => ({
    requestedThreadId,
    replacementThreadId: null,
    reason: "transport-disconnect",
  });

  const finishInterruptedTurn = ({
    threadId = latestThreadId,
    interruptReason = interruptRequested ? "user" : null,
    abortReason = null,
    resumeReplacement = null,
  } = {}) => {
    allowRolloutWatcherDuringRecovery = false;
    clearPendingTurnCompletion();
    shutdownTransport();
    finish({
      exitCode: null,
      signal: "SIGINT",
      providerSessionId: latestProviderSessionId,
      rolloutPath,
      contextSnapshot: latestContextSnapshot,
      threadId,
      warnings,
      interrupted: true,
      interruptReason,
      abortReason,
      resumeReplacement,
    });
  };

  const finishAbortedTurn = ({
    threadId = latestThreadId,
    interruptReason = interruptRequested ? "user" : null,
    abortReason = null,
    resumeReplacement = null,
  } = {}) => {
    const normalizedAbortReason = normalizeOptionalText(abortReason);
    if (interruptRequested || normalizedAbortReason === "interrupted") {
      finishInterruptedTurn({
        threadId,
        interruptReason,
        abortReason: normalizedAbortReason,
        resumeReplacement,
      });
      return;
    }

    allowRolloutWatcherDuringRecovery = false;
    clearPendingTurnCompletion();
    shutdownTransport();
    finish({
      exitCode: 1,
      signal: null,
      providerSessionId: latestProviderSessionId,
      rolloutPath,
      contextSnapshot: latestContextSnapshot,
      threadId,
      warnings: normalizedAbortReason
        ? [...warnings, `Codex turn aborted (${normalizedAbortReason})`]
        : warnings,
      interrupted: false,
      interruptReason: null,
      abortReason: normalizedAbortReason,
      resumeReplacement: null,
    });
  };

  const publishRuntimeState = async (payload = {}) => {
    if (typeof onRuntimeState !== "function") {
      return;
    }

    await onRuntimeState({
      threadId: payload.threadId ?? latestThreadId ?? null,
      activeTurnId: payload.activeTurnId ?? activeTurnId ?? null,
      providerSessionId: payload.providerSessionId ?? latestProviderSessionId ?? null,
      rolloutPath: payload.rolloutPath ?? rolloutPath ?? null,
      contextSnapshot: payload.contextSnapshot ?? latestContextSnapshot ?? null,
    });
  };

  const scheduleCompletedTurnFinish = () => {
    if (sawPrimaryFinalAnswer) {
      finishCompletedTurn();
      return;
    }

    pendingTurnCompletion = true;
    if (pendingTurnCompletionTimer) {
      return;
    }

    pendingTurnCompletionTimer = setTimeout(() => {
      pendingTurnCompletionTimer = null;
      finishCompletedTurn();
    }, TURN_COMPLETION_FINAL_MESSAGE_GRACE_MS);
  };

  const threadParams = {
    cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  };

  const refreshActiveTurnFromThreadResume = async () => {
    if (!rpc || !latestThreadId) {
      return null;
    }

    try {
      const resumed = await rpc.request("thread/resume", {
        ...threadParams,
        threadId: latestThreadId,
      });
      latestThreadId = normalizeOptionalText(resumed?.thread?.id) || latestThreadId;
      primaryThreadId = primaryThreadId || latestThreadId;
      const resumedOpenTurn = findInProgressTurn(resumed?.thread);
      const resumedLatestTurn = findLatestTurn(resumed?.thread);
      activeTurnId =
        normalizeOptionalText(resumedOpenTurn?.id)
        || (
          normalizeOptionalText(resumedLatestTurn?.status) === "inProgress"
            ? normalizeOptionalText(resumedLatestTurn?.id)
            : null
        )
        || null;
      await publishRuntimeState({
        threadId: latestThreadId,
        activeTurnId,
        providerSessionId: latestProviderSessionId,
        rolloutPath,
        contextSnapshot: latestContextSnapshot,
      });
      return activeTurnId;
    } catch {
      return null;
    }
  };

  const startRolloutTaskCompleteWatcher = () => {
    if (rolloutTaskCompleteWatcher) {
      return;
    }

    rolloutTaskCompleteWatcher = Promise.resolve()
      .then(() => watchRolloutForTaskComplete({
        codexSessionsRoot,
        rolloutPollIntervalMs,
        getSettled: () => settled,
        getWatchingDisabled: () =>
          shuttingDown
          || (recoveringFromDisconnect && !allowRolloutWatcherDuringRecovery),
        getActiveTurnId: () => activeTurnId,
        getHasPrimaryFinalAnswer: () => sawPrimaryFinalAnswer,
        getPrimaryThreadId: () => primaryThreadId,
        getProviderSessionId: () => latestProviderSessionId,
        getLatestThreadId: () => latestThreadId,
        getRolloutPath: () => rolloutPath,
        setContextSnapshot: (value) => {
          latestContextSnapshot = value;
        },
        setProviderSessionId: (value) => {
          latestProviderSessionId = value || latestProviderSessionId;
        },
        setRolloutPath: (value) => {
          rolloutPath = value;
        },
        getRolloutObservedOffset: () => rolloutObservedOffset,
        rememberSummary: (summary, ids) => summaryTracker.rememberSummary(summary, ids),
        emitSummary: emitFallbackSummary,
        onTaskComplete: async () => {
          if (
            settled ||
            shuttingDown ||
            (recoveringFromDisconnect && !allowRolloutWatcherDuringRecovery)
          ) {
            return;
          }

          finishCompletedTurn();
        },
      }))
      .catch(() => {});
  };

  const isPrimaryThreadEvent = (threadId) => {
    if (!threadId) {
      return true;
    }

    if (!primaryThreadId) {
      primaryThreadId = threadId;
      latestThreadId = threadId;
      return true;
    }

    return threadId === primaryThreadId;
  };

  const rememberSummary = (summary) => {
    return summaryTracker.rememberSummary(summary, {
      primaryThreadId,
      latestThreadId,
    });
  };

  const emitFallbackSummary = async (summary) => {
    if (!summary) {
      return;
    }

    summary.isPrimaryThreadEvent = true;
    await onEvent?.(summary, null);
  };

  const replayRolloutGapAfterReconnect = async () => {
    const threadId = primaryThreadId || latestThreadId || sessionThreadId || null;
    if (!threadId) {
      return { completed: false };
    }

    const latestContext = await readLatestContextSnapshot({
      threadId,
      providerSessionId: latestProviderSessionId,
      sessionsRoot: codexSessionsRoot,
      knownRolloutPath: rolloutPath,
    });
    rolloutPath = latestContext.rolloutPath || rolloutPath;
    latestContextSnapshot = latestContext.snapshot || latestContextSnapshot;
    latestProviderSessionId =
      latestContext.snapshot?.session_id || latestProviderSessionId;
    if (!rolloutPath) {
      return { completed: false };
    }

    let delta = null;
    try {
      delta = await readRolloutDelta({
        filePath: rolloutPath,
        offset: 0,
        carryover: Buffer.alloc(0),
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { completed: false };
      }
      throw error;
    }
    rolloutObservedOffset = delta.nextOffset;

    for (const line of delta.lines) {
      const summary = summarizeRolloutLine(line.text, {
        primaryThreadId: primaryThreadId || latestThreadId || threadId,
        activeTurnId,
      });
      if (!summary) {
        continue;
      }
      if (!summaryTracker.rememberSummary(summary, { primaryThreadId, latestThreadId })) {
        continue;
      }

      await emitFallbackSummary(summary);
      if (summary.eventType === "turn.aborted") {
        activeTurnId = null;
        finishAbortedTurn({
          threadId: summary.threadId || latestThreadId || threadId,
          interruptReason: interruptRequested ? "user" : "upstream",
          abortReason: summary.abortReason || null,
          resumeReplacement: interruptRequested
            ? null
            : buildTransportResumeReplacement(
                summary.threadId || latestThreadId || threadId,
              ),
        });
        return { completed: true };
      }

      if (summary.messagePhase === "final_answer") {
        finishCompletedTurn();
        return { completed: true };
      }
    }

    return { completed: false };
  };

  const flushPendingSteers = async () => {
    if (!rpc || !latestThreadId || !activeTurnId || pendingSteerInputs.length === 0) {
      return { ok: true, reason: "steer-buffered", inputCount: pendingSteerInputs.length };
    }

    const input = pendingSteerInputs.splice(0, pendingSteerInputs.length);
    let lastNoActiveTurnError = null;

    for (let attempt = 0; attempt <= STEER_ACTIVE_TURN_REFRESH_RETRY_DELAYS_MS.length; attempt += 1) {
      const expectedTurnId = activeTurnId;
      if (!rpc || !latestThreadId || !expectedTurnId) {
        if (attempt >= STEER_ACTIVE_TURN_REFRESH_RETRY_DELAYS_MS.length) {
          break;
        }
        await sleep(STEER_ACTIVE_TURN_REFRESH_RETRY_DELAYS_MS[attempt]);
        await refreshActiveTurnFromThreadResume();
        continue;
      }

      try {
        const steerResponse = await rpc.request("turn/steer", {
          threadId: latestThreadId,
          expectedTurnId,
          input,
        });
        activeTurnId =
          steerResponse?.turn?.id
          || steerResponse?.turnId
          || expectedTurnId;

        return {
          ok: true,
          reason: "steered",
          inputCount: input.length,
          turnId: activeTurnId,
          threadId: latestThreadId,
        };
      } catch (error) {
        if (!isNoActiveTurnSteerError(error)) {
          pendingSteerInputs.unshift(...input);
          throw error;
        }

        lastNoActiveTurnError = error;
        activeTurnId = null;
        if (attempt >= STEER_ACTIVE_TURN_REFRESH_RETRY_DELAYS_MS.length) {
          break;
        }
        await sleep(STEER_ACTIVE_TURN_REFRESH_RETRY_DELAYS_MS[attempt]);
        await refreshActiveTurnFromThreadResume();
      }
    }

    pendingSteerInputs.unshift(...input);
    throw lastNoActiveTurnError || new Error("no active turn to steer");
  };

  const queueSteer = (input = []) => {
    const normalizedInput = Array.isArray(input) ? input.filter(Boolean) : [];
    if (normalizedInput.length === 0) {
      return Promise.resolve({ ok: false, reason: "empty" });
    }

    pendingSteerInputs.push(...normalizedInput);

    if (recoveringFromDisconnect) {
      return Promise.resolve({
        ok: true,
        reason: "steer-buffered",
        inputCount: normalizedInput.length,
      });
    }

    if (!rpc || !latestThreadId || !activeTurnId) {
      return Promise.resolve({
        ok: true,
        reason: "steer-buffered",
        inputCount: normalizedInput.length,
      });
    }

    flushChain = flushChain
      .catch(() => {})
      .then(() => flushPendingSteers());
    return flushChain.catch((error) => ({
      ok: false,
      reason: "steer-failed",
      error,
    }));
  };

  stdoutReader.on("line", () => {});

  stderrReader.on("line", (line) => {
    if (!line || isRelevantWarning(line)) {
      return;
    }

    warnings.push(line);
    onWarning?.(line);
  });

  child.on("error", (error) => {
    fail(error);
  });

  child.on("close", (code, signal) => {
    if (settled) {
      return;
    }

    if (recoveringFromDisconnect) {
      recoveryChildExit = {
        code,
        signal,
      };
      if (interruptRequested) {
        finishInterruptedTurn();
      }
      return;
    }

    if (resumeReplacement) {
      finish({
        exitCode: code ?? 0,
        signal,
        threadId: latestThreadId,
        warnings,
        resumeReplacement,
      });
      return;
    }

    if (interruptRequested) {
      finishInterruptedTurn({
        threadId: latestThreadId || primaryThreadId || sessionThreadId || null,
        interruptReason: "user",
        abortReason: "interrupted",
        resumeReplacement: null,
      });
      return;
    }

    if (shuttingDown) {
      return;
    }

    notificationChain = notificationChain
      .catch(() => {})
      .then(() => {
        if (settled || shuttingDown || pendingTurnCompletion) {
          return;
        }

        finish({
          exitCode: code ?? 1,
          signal,
          threadId: latestThreadId,
          warnings,
          resumeReplacement: null,
        });
      });
  });

  const handleNotification = async (event) => {
    const summary = summarizeCodexEvent(event);
    const eventThreadId = summary?.threadId || event?.params?.threadId || null;
    const primaryEvent = isPrimaryThreadEvent(eventThreadId);

    if (summary) {
      summary.isPrimaryThreadEvent = primaryEvent;
    }

    if (summary?.threadId && primaryEvent) {
      latestThreadId = summary.threadId;
    }
    if (
      summary?.kind === "agent_message" &&
      summary?.messagePhase === "final_answer" &&
      primaryEvent
    ) {
      sawPrimaryFinalAnswer = true;
    }
    if (summary?.eventType === "turn.started" && summary.turnId && primaryEvent) {
      activeTurnId = summary.turnId;
      flushChain = flushChain
        .catch(() => {})
        .then(() => flushPendingSteers());
    } else if (summary?.eventType === "turn.completed" && primaryEvent) {
      activeTurnId = null;
    }

    if (summary) {
      rememberSummary(summary);
      try {
        await onEvent?.(summary, event);
      } catch {}
    }

    if (
      pendingTurnCompletion &&
      summary?.kind === "agent_message" &&
      summary?.messagePhase === "final_answer" &&
      primaryEvent
    ) {
      finishCompletedTurn();
      return;
    }

    if (event.method === "turn/completed" && primaryEvent) {
      if (summary?.turnStatus === "interrupted") {
        finishAbortedTurn({
          threadId: summary.threadId || latestThreadId,
          interruptReason: interruptRequested ? "user" : "upstream",
          abortReason: "interrupted",
          resumeReplacement: interruptRequested
            ? null
            : buildTransportResumeReplacement(
                summary.threadId || latestThreadId || primaryThreadId || sessionThreadId || null,
              ),
        });
        return;
      }

      if (summary?.turnStatus === "failed") {
        const failureMessage =
          normalizeOptionalText(summary?.turnError?.message)
          || normalizeOptionalText(summary?.turnError)
          || "Codex turn failed";
        shutdownTransport();
        fail(new Error(failureMessage));
        return;
      }

      scheduleCompletedTurnFinish();
    }
  };

  const connectRpcTransport = async () => {
    const ws = await openWebSocketImpl(listenUrl);
    rpc = createJsonRpcClient(ws, {
      onNotification: (event) => {
        notificationChain = notificationChain
          .catch(() => {})
          .then(() => handleNotification(event));
      },
      onDisconnect: (error) => {
        if (
          shuttingDown ||
          settled ||
          recoveringFromDisconnect ||
          pendingTurnCompletion
        ) {
          return;
        }

        recoveringFromDisconnect = true;
        allowRolloutWatcherDuringRecovery = false;
        rpc = null;
        Promise.resolve()
          .then(async () => {
            const requestedThreadId =
              latestThreadId || primaryThreadId || sessionThreadId || null;
            const reattachStartedAt = Date.now();
            while (
              !settled &&
              !shuttingDown &&
              !interruptRequested &&
              !hasChildExited(child) &&
              listenUrl &&
              requestedThreadId &&
              Date.now() - reattachStartedAt < transportReattachTimeoutMs
            ) {
              try {
                await connectRpcTransport();
                const resumed = await rpc.request("thread/resume", {
                  ...threadParams,
                  threadId: requestedThreadId,
                });
                latestThreadId = resumed?.thread?.id || requestedThreadId;
                primaryThreadId = primaryThreadId || latestThreadId;
                const resumedOpenTurn = findInProgressTurn(resumed?.thread);
                const resumedLatestTurn = findLatestTurn(resumed?.thread);
                activeTurnId =
                  normalizeOptionalText(resumedOpenTurn?.id)
                  || (
                    normalizeOptionalText(resumedLatestTurn?.status) === "inProgress"
                      ? normalizeOptionalText(resumedLatestTurn?.id)
                      : null
                  )
                  || null;
                await publishRuntimeState({
                  threadId: latestThreadId,
                  activeTurnId,
                  providerSessionId: latestProviderSessionId,
                  rolloutPath,
                  contextSnapshot: latestContextSnapshot,
                });
                const replay = await replayRolloutGapAfterReconnect();
                if (replay.completed || settled) {
                  return;
                }
                if (!activeTurnId) {
                  const resumedTurnStatus = normalizeOptionalText(resumedLatestTurn?.status);
                  if (resumedTurnStatus === "completed") {
                    allowRolloutWatcherDuringRecovery = true;
                    rolloutTaskCompleteWatcher = null;
                    startRolloutTaskCompleteWatcher();
                    scheduleCompletedTurnFinish();
                    return;
                  }

                  if (resumedTurnStatus === "interrupted") {
                    finishInterruptedTurn({
                      threadId: latestThreadId,
                      interruptReason: interruptRequested ? "user" : "upstream",
                      abortReason: "transport_lost",
                      resumeReplacement: interruptRequested
                        ? null
                        : buildTransportResumeReplacement(latestThreadId),
                    });
                    return;
                  }

                  if (resumedTurnStatus === "failed") {
                    const failureMessage =
                      normalizeOptionalText(resumedLatestTurn?.error?.message)
                      || normalizeOptionalText(resumedLatestTurn?.error)
                      || "Codex turn failed after transport reattach";
                    shutdownTransport();
                    fail(new Error(failureMessage));
                    return;
                  }
                }
                allowRolloutWatcherDuringRecovery = true;
                rolloutTaskCompleteWatcher = null;
                startRolloutTaskCompleteWatcher();
                flushChain = flushChain
                  .catch(() => {})
                  .then(() => flushPendingSteers());
                return;
              } catch {
                try {
                  rpc?.close();
                } catch {}
                rpc = null;
                if (hasChildExited(child) || interruptRequested) {
                  break;
                }
                await new Promise((resolve) => {
                  setTimeout(resolve, transportReattachRetryDelayMs);
                });
              }
            }

            activeTurnId = null;
            await followRolloutAfterDisconnect({
              disconnectError: error,
              codexSessionsRoot,
              rolloutDiscoveryTimeoutMs,
              rolloutPollIntervalMs,
              rolloutStallAfterChildExitMs,
              rolloutStallWithoutChildExitMs,
              getSettled: () => settled,
              getRecoveryChildExit: () => recoveryChildExit,
              getActiveTurnId: () => activeTurnId,
              getPrimaryThreadId: () => primaryThreadId,
              getProviderSessionId: () => latestProviderSessionId,
              getLatestThreadId: () => latestThreadId,
              getRolloutPath: () => rolloutPath,
              setContextSnapshot: (value) => {
                latestContextSnapshot = value;
              },
              setProviderSessionId: (value) => {
                latestProviderSessionId = value || latestProviderSessionId;
              },
              setRolloutPath: (value) => {
                rolloutPath = value;
              },
              getRolloutObservedOffset: () => rolloutObservedOffset,
              isInterruptRequested: () => interruptRequested,
              rememberSummary: (summary, ids) => summaryTracker.rememberSummary(summary, ids),
              emitSummary: emitFallbackSummary,
              onFinalAnswer: async () => {
                shutdownTransport();
                finish({
                  exitCode: 0,
                  signal: null,
                  providerSessionId: latestProviderSessionId,
                  rolloutPath,
                  contextSnapshot: latestContextSnapshot,
                  threadId: latestThreadId,
                  warnings,
                  resumeReplacement: null,
                });
              },
              onTurnAborted: async (summary) => {
                activeTurnId = null;
                finishAbortedTurn({
                  threadId: summary?.threadId || latestThreadId,
                  interruptReason: interruptRequested ? "user" : "upstream",
                  abortReason: summary?.abortReason || null,
                  resumeReplacement:
                    !interruptRequested && summary?.abortReason === "interrupted"
                      ? buildTransportResumeReplacement(
                          summary?.threadId || latestThreadId || primaryThreadId || sessionThreadId || null,
                        )
                      : null,
                });
              },
            });
          })
          .catch((disconnectError) => {
            if (settled) {
              return;
            }
            const recoveryThreadId =
              latestThreadId || primaryThreadId || sessionThreadId || null;
            if (!interruptRequested && recoveryThreadId) {
              finishInterruptedTurn({
                threadId: recoveryThreadId,
                interruptReason: "upstream",
                abortReason: "transport_lost",
                resumeReplacement: buildTransportResumeReplacement(recoveryThreadId),
              });
              return;
            }
            shutdownTransport();
            fail(disconnectError);
          })
          .finally(() => {
            recoveringFromDisconnect = false;
          });
      },
    });

    await rpc.request("initialize", {
      clientInfo: {
        name: "codex-telegram-gateway",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    rpc.notify("initialized");
  };

  const startup = (async () => {
    listenUrl = await waitForListenUrl(stdoutReader, stderrReader, child, {
      timeoutMs: appServerBootTimeoutMs,
    });
    await connectRpcTransport();
    let resumeThreadId = normalizeOptionalText(sessionThreadId);
    const normalizedSessionKey = normalizeOptionalText(sessionKey);
    const continuityHintsPresent = Boolean(
      resumeThreadId || latestProviderSessionId || rolloutPath || normalizedSessionKey,
    );
    if (!skipThreadHistoryLookup) {
      try {
        const historicalThread = await findLatestHistoricalThread({
          rpc,
          cwd,
          sessionKey,
          providerSessionId: latestProviderSessionId,
          knownRolloutPath: rolloutPath,
        });
        if (historicalThread?.threadId) {
          resumeThreadId = historicalThread.threadId;
        }
        if (historicalThread?.rolloutPath) {
          rolloutPath = historicalThread.rolloutPath;
        }
        if (historicalThread?.providerSessionId) {
          latestProviderSessionId = historicalThread.providerSessionId;
        }
      } catch (error) {
        if (continuityHintsPresent) {
          throw new Error(
            `Codex thread history lookup failed before resume: ${error.message}`,
          );
        }
      }
    }
    let threadResponse = null;
    try {
      threadResponse = resumeThreadId
        ? await rpc.request("thread/resume", {
            ...threadParams,
            threadId: resumeThreadId,
          })
        : await rpc.request("thread/start", threadParams);
    } catch (error) {
      if (resumeThreadId && isIrrecoverableResumeError(error)) {
        resumeReplacement = {
          requestedThreadId: resumeThreadId,
          replacementThreadId: null,
          reason: "missing-thread",
        };
        shutdownTransport();
        finish({
          exitCode: 0,
          signal: null,
          providerSessionId: latestProviderSessionId,
          rolloutPath,
          contextSnapshot: latestContextSnapshot,
          threadId: latestThreadId,
          warnings,
          resumeReplacement,
        });
        return;
      }

      throw error;
    }

    latestThreadId = threadResponse?.thread?.id || latestThreadId;
    primaryThreadId = latestThreadId;
    const latestContext = await readLatestContextSnapshot({
      threadId: primaryThreadId,
      providerSessionId: latestProviderSessionId,
      sessionsRoot: codexSessionsRoot,
      knownRolloutPath: rolloutPath,
    });
    rolloutPath = latestContext.rolloutPath || rolloutPath;
    latestContextSnapshot = latestContext.snapshot || latestContextSnapshot;
    latestProviderSessionId =
      latestContext.snapshot?.session_id || latestProviderSessionId;
    if (rolloutPath) {
      try {
        rolloutObservedOffset = await fs.stat(rolloutPath).then((stats) => stats.size);
      } catch {}
    }
    await publishRuntimeState({
      threadId: latestThreadId,
      providerSessionId: latestProviderSessionId,
      rolloutPath,
      contextSnapshot: latestContextSnapshot,
    });

    const openTurn = resumeThreadId
      ? findInProgressTurn(threadResponse?.thread)
      : null;
    if (openTurn) {
      activeTurnId = normalizeOptionalText(openTurn.id) || activeTurnId;
      await publishRuntimeState({
        threadId: latestThreadId,
        activeTurnId,
        providerSessionId: latestProviderSessionId,
        rolloutPath,
        contextSnapshot: latestContextSnapshot,
      });
      startRolloutTaskCompleteWatcher();
      flushChain = flushChain
        .catch(() => {})
        .then(() => flushPendingSteers());
      return;
    }

    const turnResponse = await rpc.request("turn/start", {
      threadId: latestThreadId,
      input: initialInput,
    });
    activeTurnId = turnResponse?.turn?.id || activeTurnId;
    await publishRuntimeState({
      threadId: latestThreadId,
      activeTurnId,
      providerSessionId: latestProviderSessionId,
      rolloutPath,
      contextSnapshot: latestContextSnapshot,
    });
    startRolloutTaskCompleteWatcher();
    flushChain = flushChain
      .catch(() => {})
      .then(() => flushPendingSteers());
  })();

  startup.catch((error) => {
    shutdownTransport();
    if (interruptRequested) {
      finishInterruptedTurn({
        threadId: latestThreadId || primaryThreadId || sessionThreadId || null,
        interruptReason: "user",
        abortReason: "interrupted",
        resumeReplacement: null,
      });
      return;
    }
    fail(error);
  });

  return {
    child,
    finished,
    steer({ input } = {}) {
      return queueSteer(input);
    },
    interrupt({ threadId = latestThreadId, turnId = activeTurnId } = {}) {
      interruptRequested = true;
      if (!rpc || !threadId || !turnId) {
        return Promise.resolve(false);
      }

      return rpc.request("turn/interrupt", {
        threadId,
        turnId,
      })
        .then(() => true)
        .catch(() => false);
    },
  };
}
