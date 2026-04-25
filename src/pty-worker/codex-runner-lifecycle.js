import { signalChildProcessTree } from "../runtime/process-tree.js";
import { readLatestContextSnapshot } from "../session-manager/context-snapshot.js";
import { hasChildExited } from "./codex-runner-common.js";
import {
  extractRolloutTaskStartedTurnId,
  readRolloutDelta,
  summarizeRolloutLine,
  watchRolloutForTaskComplete,
} from "./codex-runner-recovery.js";
import { normalizeOptionalText } from "./codex-runner-thread-history.js";

const ROLLOUT_REPLAY_OVERLAP_BYTES = 64 * 1024;

function getRequestedThreadId(context) {
  return context.state.latestThreadId || context.state.primaryThreadId || context.sessionThreadId || null;
}

function stopChild(context) {
  if (hasChildExited(context.child)) {
    return;
  }

  signalChildProcessTree(context.child, "SIGTERM");
  setTimeout(() => {
    if (!hasChildExited(context.child)) {
      signalChildProcessTree(context.child, "SIGKILL");
    }
  }, context.appServerShutdownGraceMs).unref();
}

export function shutdownTransport(context) {
  if (context.state.shuttingDown) {
    return;
  }

  context.state.shuttingDown = true;
  try {
    context.state.rpc?.close();
  } catch {}
  stopChild(context);
}

export function clearPendingTurnCompletion(context) {
  context.state.pendingTurnCompletion = false;
  if (!context.state.pendingTurnCompletionTimer) {
    return;
  }

  clearTimeout(context.state.pendingTurnCompletionTimer);
  context.state.pendingTurnCompletionTimer = null;
}

export function buildTransportResumeReplacement(
  context,
  requestedThreadId = getRequestedThreadId(context),
) {
  return {
    requestedThreadId,
    replacementThreadId: null,
    reason: "transport-disconnect",
  };
}

export function finishCompletedTurn(context) {
  context.state.allowRolloutWatcherDuringRecovery = false;
  clearPendingTurnCompletion(context);
  shutdownTransport(context);
  context.finish({
    exitCode: 0,
    signal: null,
    providerSessionId: context.state.latestProviderSessionId,
    rolloutPath: context.state.rolloutPath,
    contextSnapshot: context.state.latestContextSnapshot,
    threadId: context.state.latestThreadId,
    warnings: context.state.warnings,
    resumeReplacement: null,
  });
}

export function finishInterruptedTurn(context, {
  threadId = context.state.latestThreadId,
  interruptReason = context.state.interruptRequested ? "user" : null,
  abortReason = null,
  resumeReplacement = null,
} = {}) {
  context.state.allowRolloutWatcherDuringRecovery = false;
  clearPendingTurnCompletion(context);
  shutdownTransport(context);
  context.finish({
    exitCode: null,
    signal: "SIGINT",
    providerSessionId: context.state.latestProviderSessionId,
    rolloutPath: context.state.rolloutPath,
    contextSnapshot: context.state.latestContextSnapshot,
    threadId,
    warnings: context.state.warnings,
    interrupted: true,
    interruptReason,
    abortReason,
    resumeReplacement,
  });
}

export function finishAbortedTurn(context, {
  threadId = context.state.latestThreadId,
  interruptReason = context.state.interruptRequested ? "user" : null,
  abortReason = null,
  resumeReplacement = null,
} = {}) {
  const normalizedAbortReason = normalizeOptionalText(abortReason);
  if (context.state.interruptRequested || normalizedAbortReason === "interrupted") {
    finishInterruptedTurn(context, {
      threadId,
      interruptReason,
      abortReason: normalizedAbortReason,
      resumeReplacement,
    });
    return;
  }

  context.state.allowRolloutWatcherDuringRecovery = false;
  clearPendingTurnCompletion(context);
  shutdownTransport(context);
  context.finish({
    exitCode: 1,
    signal: null,
    providerSessionId: context.state.latestProviderSessionId,
    rolloutPath: context.state.rolloutPath,
    contextSnapshot: context.state.latestContextSnapshot,
    threadId,
    warnings: normalizedAbortReason
      ? [...context.state.warnings, `Codex turn aborted (${normalizedAbortReason})`]
      : context.state.warnings,
    interrupted: false,
    interruptReason: null,
    abortReason: normalizedAbortReason,
    resumeReplacement: null,
  });
}

export async function publishRuntimeState(context, payload = {}) {
  if (typeof context.onRuntimeState !== "function") {
    return;
  }

  await context.onRuntimeState({
    threadId: payload.threadId ?? context.state.latestThreadId ?? null,
    activeTurnId: payload.activeTurnId ?? context.state.activeTurnId ?? null,
    providerSessionId: payload.providerSessionId ?? context.state.latestProviderSessionId ?? null,
    rolloutPath: payload.rolloutPath ?? context.state.rolloutPath ?? null,
    contextSnapshot: payload.contextSnapshot ?? context.state.latestContextSnapshot ?? null,
  });
}

export function scheduleCompletedTurnFinish(context) {
  if (context.state.sawPrimaryFinalAnswer) {
    finishCompletedTurn(context);
    return;
  }

  context.state.pendingTurnCompletion = true;
  if (context.state.pendingTurnCompletionTimer) {
    return;
  }

  context.state.pendingTurnCompletionTimer = setTimeout(() => {
    context.state.pendingTurnCompletionTimer = null;
    finishCompletedTurn(context);
  }, context.turnCompletionFinalMessageGraceMs);
}

export function startRolloutTaskCompleteWatcher(context) {
  if (context.state.rolloutTaskCompleteWatcher) {
    return;
  }

  context.state.rolloutTaskCompleteWatcher = Promise.resolve()
    .then(() => watchRolloutForTaskComplete({
      codexSessionsRoot: context.codexSessionsRoot,
      rolloutPollIntervalMs: context.rolloutPollIntervalMs,
      getSettled: () => context.state.settled,
      getWatchingDisabled: () =>
        context.state.shuttingDown
        || (context.state.recoveringFromDisconnect && !context.state.allowRolloutWatcherDuringRecovery),
      getActiveTurnId: () => context.state.activeTurnId,
      getHasPrimaryFinalAnswer: () => context.state.sawPrimaryFinalAnswer,
      getPrimaryThreadId: () => context.state.primaryThreadId,
      getProviderSessionId: () => context.state.latestProviderSessionId,
      getLatestThreadId: () => context.state.latestThreadId,
      getRolloutPath: () => context.state.rolloutPath,
      setContextSnapshot: (value) => {
        context.state.latestContextSnapshot = value;
      },
      setProviderSessionId: (value) => {
        context.state.latestProviderSessionId = value || context.state.latestProviderSessionId;
      },
      setRolloutPath: (value) => {
        context.state.rolloutPath = value;
      },
      getRolloutObservedOffset: () => context.state.rolloutObservedOffset,
      rememberSummary: (summary, ids) => context.summaryTracker.rememberSummary(summary, ids),
      emitSummary: (summary) => emitFallbackSummary(context, summary),
      onTaskComplete: async () => {
        if (
          context.state.settled
          || context.state.shuttingDown
          || (context.state.recoveringFromDisconnect && !context.state.allowRolloutWatcherDuringRecovery)
        ) {
          return;
        }

        finishCompletedTurn(context);
      },
    }))
    .catch(() => {});
}

export function isPrimaryThreadEvent(context, threadId) {
  if (!threadId) {
    return true;
  }

  if (!context.state.primaryThreadId) {
    context.state.primaryThreadId = threadId;
    context.state.latestThreadId = threadId;
    return true;
  }

  return threadId === context.state.primaryThreadId;
}

export function rememberSummary(context, summary) {
  return context.summaryTracker.rememberSummary(summary, {
    primaryThreadId: context.state.primaryThreadId,
    latestThreadId: context.state.latestThreadId,
  });
}

export async function emitFallbackSummary(context, summary) {
  if (!summary) {
    return;
  }

  summary.isPrimaryThreadEvent = true;
  await context.onEvent?.(summary, null);
}

export async function replayRolloutGapAfterReconnect(context) {
  const threadId = getRequestedThreadId(context);
  if (!threadId) {
    return { completed: false };
  }

  const previousRolloutPath = context.state.rolloutPath;
  const latestContext = await readLatestContextSnapshot({
    threadId,
    providerSessionId: context.state.latestProviderSessionId,
    sessionsRoot: context.codexSessionsRoot,
    knownRolloutPath: context.state.rolloutPath,
  });
  context.state.rolloutPath = latestContext.rolloutPath || context.state.rolloutPath;
  context.state.latestContextSnapshot = latestContext.snapshot || context.state.latestContextSnapshot;
  context.state.latestProviderSessionId =
    latestContext.snapshot?.session_id || context.state.latestProviderSessionId;
  if (!context.state.rolloutPath) {
    return { completed: false };
  }

  const rolloutPathChanged = Boolean(
    previousRolloutPath
    && context.state.rolloutPath
    && previousRolloutPath !== context.state.rolloutPath,
  );
  const observedOffset =
    !rolloutPathChanged && Number.isInteger(context.state.rolloutObservedOffset)
      ? Math.max(0, context.state.rolloutObservedOffset)
      : 0;
  const replayOffset = Math.max(0, observedOffset - ROLLOUT_REPLAY_OVERLAP_BYTES);
  let delta;
  try {
    delta = await readRolloutDelta({
      filePath: context.state.rolloutPath,
      offset: replayOffset,
      carryover: Buffer.alloc(0),
      flushTailAtEof: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { completed: false };
    }
    throw error;
  }
  context.state.rolloutObservedOffset = delta.nextOffset;

  let replayActiveTurnId = context.state.activeTurnId;
  let terminalSummary = null;
  let terminalKind = null;
  for (const line of delta.lines) {
    const taskStarted = extractRolloutTaskStartedTurnId(line.text);
    if (taskStarted.seen) {
      terminalSummary = null;
      terminalKind = null;
      replayActiveTurnId = taskStarted.turnId || replayActiveTurnId;
      continue;
    }

    const summary = summarizeRolloutLine(line.text, {
      primaryThreadId: context.state.primaryThreadId || context.state.latestThreadId || threadId,
      activeTurnId: replayActiveTurnId,
    });
    if (!summary) {
      continue;
    }
    if (
      (summary.eventType === "turn.aborted" || summary.eventType === "rollout.task_complete")
      && replayActiveTurnId
      && summary.turnId
      && summary.turnId !== replayActiveTurnId
    ) {
      continue;
    }
    if (!context.summaryTracker.rememberSummary(summary, {
      primaryThreadId: context.state.primaryThreadId,
      latestThreadId: context.state.latestThreadId,
    })) {
      continue;
    }

    await emitFallbackSummary(context, summary);
    if (summary.eventType === "turn.aborted") {
      terminalSummary = summary;
      terminalKind = "aborted";
      continue;
    }

    if (summary.messagePhase === "final_answer") {
      terminalSummary = summary;
      terminalKind = "completed";
    }
  }

  if (terminalSummary && terminalKind === "aborted") {
    context.state.activeTurnId = null;
    finishAbortedTurn(context, {
      threadId: terminalSummary.threadId || context.state.latestThreadId || threadId,
      interruptReason: context.state.interruptRequested ? "user" : "upstream",
      abortReason: terminalSummary.abortReason || null,
      resumeReplacement: context.state.interruptRequested
        ? null
        : buildTransportResumeReplacement(
            context,
            terminalSummary.threadId || context.state.latestThreadId || threadId,
          ),
    });
    return { completed: true };
  }

  if (terminalSummary && terminalKind === "completed") {
    finishCompletedTurn(context);
    return { completed: true };
  }

  return { completed: false };
}
