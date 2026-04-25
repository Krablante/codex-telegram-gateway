import {
  hasChildExited,
  isRelevantWarning,
  summarizeCodexEvent,
} from "./codex-runner-common.js";
import { followRolloutAfterDisconnect } from "./codex-runner-recovery.js";
import { createJsonRpcClient } from "./codex-runner-transport.js";
import {
  buildTransportResumeReplacement,
  clearPendingTurnCompletion,
  finishAbortedTurn,
  finishCompletedTurn,
  emitFallbackSummary,
  finishInterruptedTurn,
  isPrimaryThreadEvent,
  publishRuntimeState,
  rememberSummary,
  replayRolloutGapAfterReconnect,
  scheduleCompletedTurnFinish,
  shutdownTransport,
  startRolloutTaskCompleteWatcher,
} from "./codex-runner-lifecycle.js";
import { schedulePendingSteerFlush } from "./codex-runner-steer.js";
import {
  findInProgressTurn,
  findLatestTurn,
  normalizeOptionalText,
  sleep,
} from "./codex-runner-thread-history.js";

export function attachChildProcessHandlers(context) {
  context.stdoutReader.on("line", () => {});

  context.stderrReader.on("line", (line) => {
    if (!line || isRelevantWarning(line)) {
      return;
    }

    context.state.warnings.push(line);
    context.onWarning?.(line);
  });

  context.child.on("error", (error) => {
    context.fail(error);
  });

  context.child.on("close", (code, signal) => {
    if (context.state.settled) {
      return;
    }

    if (context.state.recoveringFromDisconnect) {
      context.state.recoveryChildExit = { code, signal };
      if (context.state.interruptRequested) {
        finishInterruptedTurn(context);
      }
      return;
    }

    if (context.state.resumeReplacement) {
      context.finish({
        exitCode: code ?? 0,
        signal,
        threadId: context.state.latestThreadId,
        warnings: context.state.warnings,
        resumeReplacement: context.state.resumeReplacement,
      });
      return;
    }

    if (context.state.interruptRequested) {
      finishInterruptedTurn(context, {
        threadId: context.state.latestThreadId || context.state.primaryThreadId || context.sessionThreadId || null,
        interruptReason: "user",
        abortReason: "interrupted",
        resumeReplacement: null,
      });
      return;
    }

    if (context.state.shuttingDown) {
      return;
    }

    context.state.notificationChain = context.state.notificationChain
      .catch(() => {})
      .then(async () => {
        if (
          context.state.settled
          || context.state.shuttingDown
          || context.state.pendingTurnCompletion
        ) {
          return;
        }

        if (code === 0 && !signal) {
          try {
            const replay = await replayRolloutGapAfterReconnect(context);
            if (replay.completed || context.state.settled) {
              return;
            }
          } catch (error) {
            const message =
              normalizeOptionalText(error?.message)
              || "Unknown replay error";
            const warning = `Rollout replay after graceful app-server exit failed: ${message}`;
            context.state.warnings.push(warning);
            context.onWarning?.(warning);
          }

          if (context.state.sawPrimaryFinalAnswer) {
            finishCompletedTurn(context);
            return;
          }

          const recoveryThreadId =
            context.state.latestThreadId
            || context.state.primaryThreadId
            || context.sessionThreadId
            || null;
          if (recoveryThreadId) {
            finishInterruptedTurn(context, {
              threadId: recoveryThreadId,
              interruptReason: "upstream",
              abortReason: "transport_lost",
              resumeReplacement: buildTransportResumeReplacement(
                context,
                recoveryThreadId,
              ),
            });
            return;
          }
        }

        context.finish({
          exitCode: code ?? 1,
          signal,
          threadId: context.state.latestThreadId,
          warnings: context.state.warnings,
          resumeReplacement: null,
        });
      });
  });
}

async function handleNotification(context, event) {
  const summary = summarizeCodexEvent(event);
  const eventThreadId = summary?.threadId || event?.params?.threadId || null;
  const primaryEvent = isPrimaryThreadEvent(context, eventThreadId);

  if (summary) {
    summary.isPrimaryThreadEvent = primaryEvent;
  }

  if (summary?.threadId && primaryEvent) {
    context.state.latestThreadId = summary.threadId;
  }
  if (
    summary?.kind === "agent_message"
    && summary?.messagePhase === "final_answer"
    && primaryEvent
  ) {
    context.state.sawPrimaryFinalAnswer = true;
  }
  if (summary?.eventType === "turn.started" && summary.turnId && primaryEvent) {
    clearPendingTurnCompletion(context);
    context.state.sawPrimaryFinalAnswer = false;
    context.state.activeTurnId = summary.turnId;
    schedulePendingSteerFlush(context);
  } else if (summary?.eventType === "turn.completed" && primaryEvent) {
    context.state.activeTurnId = null;
  }

  if (summary) {
    rememberSummary(context, summary);
    try {
      await context.onEvent?.(summary, event);
    } catch (error) {
      context.onWarning?.(`event handler failed: ${error?.message || error}`);
    }
  }

  if (
    context.state.pendingTurnCompletion
    && summary?.kind === "agent_message"
    && summary?.messagePhase === "final_answer"
    && primaryEvent
  ) {
    finishCompletedTurn(context);
    return;
  }

  if (event.method === "turn/completed" && primaryEvent) {
    if (summary?.turnStatus === "interrupted") {
      finishAbortedTurn(context, {
        threadId: summary.threadId || context.state.latestThreadId,
        interruptReason: context.state.interruptRequested ? "user" : "upstream",
        abortReason: "interrupted",
        resumeReplacement: context.state.interruptRequested
          ? null
          : buildTransportResumeReplacement(
              context,
              summary.threadId
                || context.state.latestThreadId
                || context.state.primaryThreadId
                || context.sessionThreadId
                || null,
            ),
      });
      return;
    }

    if (summary?.turnStatus === "failed") {
      const failureMessage =
        normalizeOptionalText(summary?.turnError?.message)
        || normalizeOptionalText(summary?.turnError)
        || "Codex turn failed";
      shutdownTransport(context);
      context.fail(new Error(failureMessage));
      return;
    }

    scheduleCompletedTurnFinish(context);
  }
}

export async function connectRpcTransport(context) {
  const ws = await context.openWebSocketImpl(context.state.listenUrl);
  context.state.rpc = createJsonRpcClient(ws, {
    onNotification: (event) => {
      context.state.notificationChain = context.state.notificationChain
        .catch(() => {})
        .then(() => handleNotification(context, event));
    },
    onDisconnect: (error) => {
      if (
        context.state.shuttingDown
        || context.state.settled
        || context.state.recoveringFromDisconnect
        || context.state.pendingTurnCompletion
      ) {
        return;
      }

      context.state.recoveringFromDisconnect = true;
      context.state.allowRolloutWatcherDuringRecovery = false;
      context.state.rpc = null;
      Promise.resolve()
        .then(async () => {
          const requestedThreadId =
            context.state.latestThreadId || context.state.primaryThreadId || context.sessionThreadId || null;
          const reattachStartedAt = Date.now();
          while (
            !context.state.settled
            && !context.state.shuttingDown
            && !context.state.interruptRequested
            && !hasChildExited(context.child)
            && context.state.listenUrl
            && requestedThreadId
            && Date.now() - reattachStartedAt < context.transportReattachTimeoutMs
          ) {
            try {
              await connectRpcTransport(context);
              const resumed = await context.state.rpc.request("thread/resume", {
                ...context.threadParams,
                threadId: requestedThreadId,
              });
              context.state.latestThreadId = resumed?.thread?.id || requestedThreadId;
              context.state.primaryThreadId = context.state.primaryThreadId || context.state.latestThreadId;
              const resumedOpenTurn = findInProgressTurn(resumed?.thread);
              const resumedLatestTurn = findLatestTurn(resumed?.thread);
              context.state.activeTurnId =
                normalizeOptionalText(resumedOpenTurn?.id)
                || (
                  normalizeOptionalText(resumedLatestTurn?.status) === "inProgress"
                    ? normalizeOptionalText(resumedLatestTurn?.id)
                    : null
                )
                || null;
              await publishRuntimeState(context, {
                threadId: context.state.latestThreadId,
                activeTurnId: context.state.activeTurnId,
                providerSessionId: context.state.latestProviderSessionId,
                rolloutPath: context.state.rolloutPath,
                contextSnapshot: context.state.latestContextSnapshot,
              });
              const replay = await replayRolloutGapAfterReconnect(context);
              if (replay.completed || context.state.settled) {
                return;
              }
              if (!context.state.activeTurnId) {
                const resumedTurnStatus = normalizeOptionalText(resumedLatestTurn?.status);
                if (resumedTurnStatus === "completed") {
                  context.state.allowRolloutWatcherDuringRecovery = true;
                  context.state.rolloutTaskCompleteWatcher = null;
                  startRolloutTaskCompleteWatcher(context);
                  scheduleCompletedTurnFinish(context);
                  return;
                }

                if (resumedTurnStatus === "interrupted") {
                  finishInterruptedTurn(context, {
                    threadId: context.state.latestThreadId,
                    interruptReason: context.state.interruptRequested ? "user" : "upstream",
                    abortReason: "transport_lost",
                    resumeReplacement: context.state.interruptRequested
                      ? null
                      : buildTransportResumeReplacement(context, context.state.latestThreadId),
                  });
                  return;
                }

                if (resumedTurnStatus === "failed") {
                  const failureMessage =
                    normalizeOptionalText(resumedLatestTurn?.error?.message)
                    || normalizeOptionalText(resumedLatestTurn?.error)
                    || "Codex turn failed after transport reattach";
                  shutdownTransport(context);
                  context.fail(new Error(failureMessage));
                  return;
                }
              }
              context.state.allowRolloutWatcherDuringRecovery = true;
              context.state.rolloutTaskCompleteWatcher = null;
              startRolloutTaskCompleteWatcher(context);
              schedulePendingSteerFlush(context);
              return;
            } catch {
              try {
                context.state.rpc?.close();
              } catch {}
              context.state.rpc = null;
              if (hasChildExited(context.child) || context.state.interruptRequested) {
                break;
              }
              await sleep(context.transportReattachRetryDelayMs);
            }
          }

          context.state.activeTurnId = null;
          await followRolloutAfterDisconnect({
            disconnectError: error,
            codexSessionsRoot: context.codexSessionsRoot,
            rolloutDiscoveryTimeoutMs: context.rolloutDiscoveryTimeoutMs,
            rolloutPollIntervalMs: context.rolloutPollIntervalMs,
            rolloutStallAfterChildExitMs: context.rolloutStallAfterChildExitMs,
            rolloutStallWithoutChildExitMs: context.rolloutStallWithoutChildExitMs,
            getSettled: () => context.state.settled,
            getRecoveryChildExit: () => context.state.recoveryChildExit,
            getActiveTurnId: () => context.state.activeTurnId,
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
            isInterruptRequested: () => context.state.interruptRequested,
            rememberSummary: (summary, ids) => context.summaryTracker.rememberSummary(summary, ids),
            emitSummary: (summary) => emitFallbackSummary(context, summary),
            onFinalAnswer: async () => {
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
            },
            onTurnAborted: async (summary) => {
              context.state.activeTurnId = null;
              finishAbortedTurn(context, {
                threadId: summary?.threadId || context.state.latestThreadId,
                interruptReason: context.state.interruptRequested ? "user" : "upstream",
                abortReason: summary?.abortReason || null,
                resumeReplacement:
                  !context.state.interruptRequested && summary?.abortReason === "interrupted"
                    ? buildTransportResumeReplacement(
                        context,
                        summary?.threadId
                          || context.state.latestThreadId
                          || context.state.primaryThreadId
                          || context.sessionThreadId
                          || null,
                      )
                    : null,
              });
            },
          });
        })
        .catch((disconnectError) => {
          if (context.state.settled) {
            return;
          }
          const recoveryThreadId =
            context.state.latestThreadId || context.state.primaryThreadId || context.sessionThreadId || null;
          if (!context.state.interruptRequested && recoveryThreadId) {
            finishInterruptedTurn(context, {
              threadId: recoveryThreadId,
              interruptReason: "upstream",
              abortReason: "transport_lost",
              resumeReplacement: buildTransportResumeReplacement(context, recoveryThreadId),
            });
            return;
          }
          shutdownTransport(context);
          context.fail(disconnectError);
        })
        .finally(() => {
          context.state.recoveringFromDisconnect = false;
        });
    },
  });

  await context.state.rpc.request("initialize", {
    clientInfo: {
      name: "codex-telegram-gateway",
      version: "1.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  context.state.rpc.notify("initialized");
}
