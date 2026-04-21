import { getSessionUiLanguage } from "../i18n/ui-language.js";
import { markPromptAccepted, setActiveRunCount } from "../runtime/service-state.js";
import { TelegramProgressMessage } from "../transport/progress-message.js";
import { extractTelegramFileDirectives } from "../transport/telegram-file-directive.js";
import { normalizeTelegramReply } from "../transport/telegram-reply-normalizer.js";
import {
  loadAvailableCodexModels,
  resolveCodexRuntimeProfile,
} from "../session-manager/codex-runtime-settings.js";
import { buildCompactResumePrompt } from "./compact-resume.js";
import { normalizeTokenUsage } from "../codex-runtime/token-usage.js";
import {
  appendPromptPart,
  buildExchangeLogEntry,
  buildFailureText,
  buildInterruptedText,
  buildProgressText,
  buildPromptWithAttachments,
  buildPromptWithTopicContext,
  buildRunFailureText,
  excerpt,
  isEnglish,
  isTransientTransportError,
  outputTail,
  resolveReplyToMessageId,
  signalChildProcessGroup,
  sleep,
  stringifyMessageId,
} from "./worker-pool-common.js";
import { buildFinalCompletedReplyText } from "./worker-pool-delivery.js";

const MAX_THREAD_RESUME_RETRIES = 1;
const MAX_UPSTREAM_INTERRUPT_RECOVERIES = 2;
const UPSTREAM_INTERRUPT_RECOVERY_BACKOFF_MS = 500;
const SHUTDOWN_DRAIN_POLL_MS = 25;

function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function buildRunEventSessionFields(session) {
  return {
    session_key: session?.session_key || null,
    chat_id: session?.chat_id || null,
    topic_id: session?.topic_id || null,
    topic_name: session?.topic_name || null,
  };
}

function computeRunDurationMs(startedAt, finishedAt) {
  const started = Date.parse(startedAt || "");
  const finished = Date.parse(finishedAt || "");
  if (!Number.isFinite(started) || !Number.isFinite(finished)) {
    return null;
  }

  return Math.max(0, finished - started);
}

async function noteRunEventBestEffort(pool, type, details = {}) {
  if (!pool?.runtimeObserver || typeof pool.runtimeObserver.appendEvent !== "function") {
    return;
  }

  try {
    await pool.runtimeObserver.appendEvent(type, details);
  } catch (error) {
    console.warn(`runtime observer ${type} failed: ${error.message}`);
  }
}

export async function startPromptRun(
  pool,
  {
    session,
    prompt,
    rawPrompt = prompt,
    message,
    attachments = [],
    includeTopicContext = true,
  },
) {
  const sessionKey = session.session_key;
  const allowed = pool.canStart(sessionKey);
  if (!allowed.ok) {
    return allowed;
  }

  pool.startingRuns.add(sessionKey);
  pool.startingRunSessions.set(sessionKey, session);
  let resolveStartingRun;
  const startingRunPromise = new Promise((resolve) => {
    resolveStartingRun = resolve;
  });
  pool.startingRunPromises.set(sessionKey, startingRunPromise);
  let startingRunSettled = false;
  const settleStartingRun = () => {
    if (startingRunSettled) {
      return;
    }

    startingRunSettled = true;
    if (pool.startingRunPromises.get(sessionKey) === startingRunPromise) {
      pool.startingRunPromises.delete(sessionKey);
    }
    resolveStartingRun();
  };
  let startReserved = true;
  const releaseStartReservation = () => {
    if (!startReserved) {
      return;
    }

    pool.startingRuns.delete(sessionKey);
    pool.startingRunSessions.delete(sessionKey);
    startReserved = false;
  };
  markPromptAccepted(pool.serviceState);
  let run = null;
  let lifecycleAttached = false;
  let resolveLifecycleGate = null;
  let lifecycleGateSettled = false;
  const settleLifecycleGate = (value) => {
    if (lifecycleGateSettled || typeof resolveLifecycleGate !== "function") {
      return;
    }

    lifecycleGateSettled = true;
    resolveLifecycleGate(value);
  };

  const state = {
    sessionKey,
    status: "starting",
    providerSessionId:
      session.provider_session_id
      ?? session.last_context_snapshot?.session_id
      ?? session.last_context_snapshot?.sessionId
      ?? null,
    threadId:
      session.codex_thread_id
      ?? session.last_context_snapshot?.thread_id
      ?? session.last_context_snapshot?.threadId
      ?? null,
    activeTurnId: null,
    rolloutPath: session.codex_rollout_path ?? null,
    contextSnapshot: session.last_context_snapshot ?? null,
    latestSummary: null,
    latestSummaryKind: null,
    latestProgressMessage: null,
    latestCommandOutput: null,
    finalAgentMessage: null,
    finalAgentMessageSource: null,
    replyDocuments: [],
    replyDocumentWarnings: [],
    warnings: [],
    interruptRequested: false,
    interruptSignalSent: false,
    finalizing: false,
    resumeMode:
      session.codex_thread_id
      || session.last_context_snapshot?.thread_id
      || session.last_context_snapshot?.threadId
        ? "thread-resume"
        : null,
    lastTokenUsage: session.last_token_usage ?? null,
    latestCommand: null,
    progress: null,
    replyToMessageId: resolveReplyToMessageId(message),
    lastTypingActionAt: 0,
    typingActionInFlight: false,
    acceptedLiveSteerCount: 0,
    liveSteerImagePaths: [],
  };

  try {
    const progress = new TelegramProgressMessage({
      api: pool.api,
      chatId: Number(session.chat_id),
      messageThreadId: Number(session.topic_id),
      onDeliveryError: async (error) => {
        if (pool.sessionLifecycleManager) {
          return pool.sessionLifecycleManager.handleTransportError(session, error);
        }

        return null;
      },
    });
    state.progress = progress;
    try {
      await progress.sendInitial(
        buildProgressText(state, getSessionUiLanguage(session)),
      );
    } catch (error) {
      if (error?.deliveryHandled || !isTransientTransportError(error)) {
        throw error;
      }

      // Progress bubble is optional for transient Telegram hiccups like 429.
    }
    const exchangePrompt = buildPromptWithAttachments(
      rawPrompt,
      attachments,
      getSessionUiLanguage(session),
    );

    if (pool.shuttingDown) {
      releaseStartReservation();
      settleStartingRun();
      await progress.dismiss().catch(() => false);
      await pool.sessionStore.patch(session, {
        last_user_prompt: exchangePrompt,
        last_run_status: "interrupted",
        spike_run_owner_generation_id: null,
        last_progress_message_id: null,
      });
      return {
        ok: false,
        reason: "shutting-down",
      };
    }

    run = {
      sessionKey,
      session,
      child: null,
      controller: null,
      lifecyclePromise: new Promise((resolve) => {
        resolveLifecycleGate = resolve;
      }),
      exchangePrompt,
      includeTopicContext,
      state,
      startedAt: new Date().toISOString(),
      progressMessageId: progress.messageId,
      progressTimer: null,
      runtimeProfileInputs: {},
    };
    run.progressTimer = pool.startProgressLoop(run);
    void pool.sendTypingAction(run);
    pool.activeRuns.set(sessionKey, run);
    releaseStartReservation();
    settleStartingRun();
    setActiveRunCount(pool.serviceState, pool.activeRuns.size);
    await pool.sessionStore.patch(session, {
      last_user_prompt: exchangePrompt,
      last_run_status: "running",
      spike_run_owner_generation_id: pool.serviceGenerationId,
      last_run_started_at: run.startedAt,
      last_progress_message_id: stringifyMessageId(progress.messageId),
    });
    await noteRunEventBestEffort(pool, "run.started", {
      ...buildRunEventSessionFields(session),
      started_at: run.startedAt,
      reply_to_message_id: state.replyToMessageId,
      include_topic_context: includeTopicContext,
      attachment_count: Array.isArray(attachments) ? attachments.length : 0,
      stored_thread_id: session.codex_thread_id ?? null,
      resume_mode: state.resumeMode,
    });

    let resultPersisted = false;
    let spikeFinalEventEmitted = false;
    const lifecyclePromise = pool.executeRunLifecycle(run, {
      prompt,
      attachments,
      includeTopicContext,
    })
      .then(async (result) => {
        state.finalizing = true;
        state.threadId = result.threadId || state.threadId;
        state.warnings.push(...result.warnings);
        const completedWithReply =
          typeof state.finalAgentMessage === "string" &&
          state.finalAgentMessage.trim() &&
          (
            result.exitCode === 0 ||
            result?.attemptInsight?.sawFinalAnswer === true
          );
        const interruptedResult =
          state.interruptRequested ||
          (
            result?.preserveContinuity === true &&
            result?.abortReason === "resume_unavailable"
          ) ||
          result?.interrupted === true ||
          result?.signal === "SIGINT";
        const resumePendingResult =
          result?.preserveContinuity === true &&
          result?.abortReason === "resume_unavailable";
        state.status = completedWithReply
          ? "completed"
          : interruptedResult
            ? "interrupted"
            : result.exitCode === 0
              ? "completed"
              : "failed";
        const finishedAt = new Date().toISOString();
        let documentDelivery = {
          successes: [],
          failures: [],
          parked: false,
          session: run.session,
        };

        if (state.status === "completed") {
          documentDelivery = await pool.deliverRunDocuments(
            run.session,
            state.replyDocuments,
          );
          run.session = documentDelivery.session || run.session;
          state.finalAgentMessage = buildFinalCompletedReplyText({
            baseText: state.finalAgentMessage,
            successes: documentDelivery.successes,
            failures: documentDelivery.failures,
            warnings: state.replyDocumentWarnings,
            language: getSessionUiLanguage(run.session),
          });
          state.finalAgentMessageSource = buildFinalCompletedReplyText({
            baseText: state.finalAgentMessageSource ?? state.finalAgentMessage,
            successes: documentDelivery.successes,
            failures: documentDelivery.failures,
            warnings: state.replyDocumentWarnings,
            language: getSessionUiLanguage(run.session),
          });
        }

        const finalReplyText =
          state.status === "completed"
            ? state.finalAgentMessage ||
              (isEnglish(getSessionUiLanguage(run.session)) ? "Done." : "Готово.")
            : state.status === "interrupted" && !resumePendingResult
              ? buildInterruptedText(getSessionUiLanguage(run.session), {
                requestedByUser: state.interruptRequested,
                interruptReason: result?.interruptReason || null,
              })
              : buildRunFailureText(result, getSessionUiLanguage(run.session));
        const finalReplyDeliveryText =
          state.status === "completed"
            ? state.finalAgentMessageSource || finalReplyText
            : finalReplyText;
        state.finalAgentMessage = finalReplyText;
        state.finalAgentMessageSource = finalReplyDeliveryText;
        const clearStoredThreadState =
          state.status === "failed" && result?.preserveContinuity !== true;
        const persistedThreadId = clearStoredThreadState
          ? null
          : state.threadId || run.session.codex_thread_id || null;
        const persistedProviderSessionId = clearStoredThreadState
          ? null
          : state.providerSessionId
            || run.session.provider_session_id
            || state.contextSnapshot?.session_id
            || null;
        const persistedRolloutPath = clearStoredThreadState
          ? null
          : state.rolloutPath
            || state.contextSnapshot?.rollout_path
            || run.session.codex_rollout_path
            || null;
        const persistedContextSnapshot = clearStoredThreadState
          ? null
          : state.contextSnapshot
            || run.session.last_context_snapshot
            || null;

        run.session = await pool.sessionStore.patch(run.session, {
          ...(persistedProviderSessionId
            ? {
                runtime_provider: "codex",
                provider_session_id: persistedProviderSessionId,
              }
            : clearStoredThreadState
              ? { provider_session_id: null }
              : {}),
          codex_thread_id: persistedThreadId,
          codex_rollout_path: persistedRolloutPath,
          last_context_snapshot: persistedContextSnapshot,
          last_user_prompt: run.exchangePrompt,
          last_agent_reply: finalReplyText,
          last_run_status: state.status,
          spike_run_owner_generation_id: null,
          last_run_started_at: run.startedAt,
          last_run_finished_at: finishedAt,
          last_token_usage: state.lastTokenUsage,
          last_progress_message_id: stringifyMessageId(progress.messageId),
        });
        await noteRunEventBestEffort(pool, "run.finished", {
          ...buildRunEventSessionFields(run.session),
          status: state.status,
          started_at: run.startedAt,
          finished_at: finishedAt,
          duration_ms: computeRunDurationMs(run.startedAt, finishedAt),
          exit_code: result?.exitCode ?? null,
          signal: result?.signal ?? null,
          interrupted: interruptedResult,
          interrupt_reason: result?.interruptReason || null,
          abort_reason: result?.abortReason || null,
          thread_id: state.threadId || null,
          resume_mode: state.resumeMode,
          warnings_count: state.warnings.length,
          reply_documents_count: state.replyDocuments.length,
          token_usage: state.lastTokenUsage ?? null,
        });
        const exchangeLogResult = await pool.sessionStore.appendExchangeLogEntry(
          run.session,
          buildExchangeLogEntry({
            prompt: run.exchangePrompt,
            state,
            finishedAt,
          }),
        );
        run.session = exchangeLogResult.session;
        resultPersisted = true;
        pool.stopProgressLoop(run);
        await pool.finalizeProgress(run);
        let replyDelivery = {
          delivered: false,
          messageIds: [],
        };
        if (!documentDelivery.parked) {
          replyDelivery = await pool.deliverRunReply(run.session, finalReplyDeliveryText, {
            replyToMessageId: state.replyToMessageId,
            progress,
          });
        }
        run.session = replyDelivery.session || run.session;
        await pool.emitSpikeFinalEvent(run, {
          finishedAt,
          deliveryResult: replyDelivery,
        });
        spikeFinalEventEmitted = true;
        if (replyDelivery.fallback !== "progress") {
          await progress.dismiss();
        }
      })
      .catch(async (error) => {
        state.finalizing = true;
        pool.stopProgressLoop(run);
        if (resultPersisted) {
          if (!spikeFinalEventEmitted) {
            await pool.emitSpikeFinalEvent(run, {
              finishedAt:
                run.session?.last_run_finished_at || new Date().toISOString(),
              deliveryResult: {
                delivered: false,
                messageIds: Array.isArray(error?.partialTelegramMessageIds)
                  ? error.partialTelegramMessageIds
                  : [],
              },
            }).catch(() => null);
          }
          await progress.dismiss().catch(() => false);
          throw error;
        }

        state.status = "failed";
        const finishedAt = new Date().toISOString();
        const failureText = buildFailureText(
          error,
          getSessionUiLanguage(run.session),
        );
        state.finalAgentMessage = failureText;
        state.finalAgentMessageSource = failureText;
        run.session = await pool.sessionStore.patch(session, {
          last_user_prompt: run.exchangePrompt,
          last_agent_reply: failureText,
          last_run_status: "failed",
          spike_run_owner_generation_id: null,
          last_run_started_at: run.startedAt,
          last_run_finished_at: finishedAt,
          last_token_usage: state.lastTokenUsage,
        });
        const exchangeLogResult = await pool.sessionStore.appendExchangeLogEntry(
          run.session,
          buildExchangeLogEntry({
            prompt: run.exchangePrompt,
            state,
            finishedAt,
          }),
        );
        run.session = exchangeLogResult.session;
        await pool.finalizeProgress(run);
        const replyDelivery = await pool.deliverRunReply(
          run.session,
          failureText,
          {
            replyToMessageId: state.replyToMessageId,
            progress,
          },
        );
        run.session = replyDelivery.session || run.session;
        await pool.emitSpikeFinalEvent(run, {
          finishedAt,
          deliveryResult: replyDelivery,
        });
        spikeFinalEventEmitted = true;
        if (replyDelivery.fallback !== "progress") {
          await progress.dismiss();
        }
      })
      .finally(async () => {
        pool.stopProgressLoop(run);
        pool.activeRuns.delete(sessionKey);
        pool.pendingLiveSteers.delete(sessionKey);
        setActiveRunCount(pool.serviceState, pool.activeRuns.size);
        if (typeof pool.onRunTerminated === "function") {
          try {
            await pool.onRunTerminated({
              session: run.session,
              status: state.status,
              run,
            });
          } catch (error) {
            console.error(
              `run termination hook failed for ${sessionKey}: ${error.message}`,
            );
          }
        }
      })
      .catch((error) => {
        console.error(`run lifecycle failed for ${sessionKey}: ${error.message}`);
      });
    lifecycleAttached = true;
    run.lifecyclePromise = lifecyclePromise;
    settleLifecycleGate(lifecyclePromise);

    return {
      ok: true,
      progressMessageId: progress.messageId,
      threadId: state.threadId,
      sessionKey,
      topicId: message.message_thread_id,
    };
  } catch (error) {
    settleLifecycleGate();
    if (run && !lifecycleAttached) {
      pool.stopProgressLoop(run);
      if (pool.activeRuns.get(sessionKey) === run) {
        pool.activeRuns.delete(sessionKey);
      }
      pool.pendingLiveSteers.delete(sessionKey);
      setActiveRunCount(pool.serviceState, pool.activeRuns.size);
      await run.state.progress?.dismiss?.().catch(() => false);
    }
    releaseStartReservation();
    settleStartingRun();
    throw error;
  }
}

export function interrupt(pool, sessionKey) {
  const run = pool.activeRuns.get(sessionKey);
  if (!run) {
    return false;
  }

  if (
    run.state.interruptRequested ||
    ["completed", "failed", "interrupting", "interrupted"].includes(
      run.state.status,
    )
  ) {
    return false;
  }

  run.state.interruptRequested = true;
  run.state.status = "interrupting";
  run.state.latestSummary = "interrupt-requested";
  run.state.latestSummaryKind = "interrupt";
  run.state.progress.queueUpdate(
    buildProgressText(run.state, getSessionUiLanguage(run.session)),
  );

  const nativeInterruptRequested =
    typeof run.controller?.interrupt === "function";
  if (nativeInterruptRequested) {
    const nativeInterruptResult = Promise.resolve(run.controller.interrupt({
      threadId: run.state.threadId || undefined,
      turnId: run.state.activeTurnId || undefined,
    })).catch(() => false);
    void nativeInterruptResult.then((requested) => {
      if (
        requested !== false ||
        pool.activeRuns.get(sessionKey) !== run ||
        !run.child ||
        run.state.interruptSignalSent
      ) {
        return;
      }

      run.state.interruptSignalSent = true;
      signalChildProcessGroup(run.child, "SIGINT");
      setTimeout(() => {
        if (pool.activeRuns.get(sessionKey) === run && run.child) {
          signalChildProcessGroup(run.child, "SIGKILL");
        }
      }, 5000).unref();
    });
  }

  if (run.child) {
    const scheduleHardKill = () => {
      setTimeout(() => {
        if (pool.activeRuns.get(sessionKey) === run && run.child) {
          signalChildProcessGroup(run.child, "SIGKILL");
        }
      }, 5000).unref();
    };
    const sendSigint = () => {
      if (
        pool.activeRuns.get(sessionKey) !== run ||
        !run.child ||
        run.state.interruptSignalSent
      ) {
        return;
      }

      run.state.interruptSignalSent = true;
      signalChildProcessGroup(run.child, "SIGINT");
      scheduleHardKill();
    };

    if (nativeInterruptRequested) {
      setTimeout(() => {
        sendSigint();
      }, 5000).unref();
    } else {
      sendSigint();
    }
  }
  return true;
}

async function waitForShutdownDrain(pool, timeoutMs = null) {
  const hasDeadline = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const deadline = hasDeadline ? Date.now() + timeoutMs : null;

  while (true) {
    if (pool.activeRuns.size === 0 && pool.startingRuns.size === 0) {
      return true;
    }

    if (deadline !== null && Date.now() >= deadline) {
      return false;
    }

    const nextWaitMs = deadline === null
      ? SHUTDOWN_DRAIN_POLL_MS
      : Math.max(1, Math.min(SHUTDOWN_DRAIN_POLL_MS, deadline - Date.now()));
    const waitPromises = [
      ...pool.startingRunPromises.values(),
      ...[...pool.activeRuns.values()]
        .map((run) => run.lifecyclePromise)
        .filter(Boolean),
    ];
    if (waitPromises.length > 0) {
      await Promise.race([
        Promise.allSettled(waitPromises),
        sleep(nextWaitMs),
      ]);
    } else {
      await sleep(nextWaitMs);
    }
  }
}

export async function shutdown(
  pool,
  { drainTimeoutMs = 0, interruptActiveRuns = true } = {},
) {
  pool.shuttingDown = true;

  if (drainTimeoutMs > 0) {
    const drained = await waitForShutdownDrain(pool, drainTimeoutMs);
    if (drained || !interruptActiveRuns) {
      return;
    }
  } else if (!interruptActiveRuns) {
    await waitForShutdownDrain(pool, null);
    return;
  }

  for (const [sessionKey] of pool.activeRuns.entries()) {
    pool.interrupt(sessionKey);
  }

  const settleWindowMs = drainTimeoutMs > 0
    ? drainTimeoutMs
    : null;
  await waitForShutdownDrain(pool, settleWindowMs);
}

export async function executeRunLifecycle(
  pool,
  run,
  {
    prompt,
    attachments = [],
    includeTopicContext = true,
  },
) {
  const promptWithAttachments = buildPromptWithAttachments(
    prompt,
    attachments,
    getSessionUiLanguage(run.session),
  );
  const sessionThreadId =
    run.session.codex_thread_id
    ?? run.session.last_context_snapshot?.thread_id
    ?? run.session.last_context_snapshot?.threadId
    ?? null;
  const freshBriefBootstrap = shouldStartFreshFromCompact(run.session);
  const initialPrompt = freshBriefBootstrap
    ? await pool.buildFreshBriefBootstrapPrompt(run, promptWithAttachments)
    : promptWithAttachments;

  return pool.executeRunAttempts(run, {
    prompt: initialPrompt,
    sessionThreadId,
    skipThreadHistoryLookup: freshBriefBootstrap,
    attachments,
    includeTopicContext,
  });
}

function parseTimestampMs(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }

  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldStartFreshFromCompact(session) {
  const lastCompactedAtMs = parseTimestampMs(session?.last_compacted_at);
  if (!lastCompactedAtMs || !String(session?.last_compaction_reason || "").trim()) {
    return false;
  }

  const hasContinuitySurface = Boolean(
    session?.codex_thread_id
    || session?.provider_session_id
    || session?.codex_rollout_path
    || session?.last_context_snapshot?.thread_id
    || session?.last_context_snapshot?.threadId
    || session?.last_context_snapshot?.session_id,
  );
  if (hasContinuitySurface) {
    return false;
  }

  const lastRunStartedAtMs = parseTimestampMs(session?.last_run_started_at);
  return !lastRunStartedAtMs || lastRunStartedAtMs <= lastCompactedAtMs;
}

export async function buildFreshBriefBootstrapPrompt(pool, run, prompt) {
  if (!run.session.last_compacted_at && !run.session.last_compaction_reason) {
    return prompt;
  }

  const activeBrief = await pool.sessionStore.loadActiveBrief(run.session);
  if (!String(activeBrief || "").trim()) {
    return prompt;
  }

  return buildCompactResumePrompt({
    session: run.session,
    prompt,
    compactState: {
      activeBrief,
    },
    mode: "fresh-brief",
  });
}

export async function executeRunAttempts(
  pool,
  run,
  {
    prompt,
    attachments = [],
    sessionThreadId,
    skipThreadHistoryLookup = false,
    includeTopicContext = true,
  },
) {
  let nextPrompt = prompt;
  const initialImagePaths = attachments
    .filter((attachment) => attachment?.is_image && attachment?.file_path)
    .map((attachment) => attachment.file_path);
  let nextSessionThreadId = sessionThreadId;
  let nextSkipThreadHistoryLookup = skipThreadHistoryLookup;
  let resumeRetryCount = 0;
  let recoveredLiveSteerCount = 0;
  let recoveredInterruptedRunCount = 0;

  while (true) {
    if (run.state.interruptRequested && !run.child) {
      return {
        exitCode: null,
        signal: "SIGINT",
        threadId: run.state.threadId,
        warnings: [],
        resumeReplacement: null,
      };
    }

    const imagePaths = Array.from(new Set([
      ...initialImagePaths,
      ...(run.state.liveSteerImagePaths || []),
    ]));
    const result = await pool.runAttempt(run, {
      prompt: includeTopicContext
        ? buildPromptWithTopicContext(
            nextPrompt,
            run.session,
            pool.sessionStore,
          )
        : nextPrompt,
      imagePaths,
      sessionThreadId: nextSessionThreadId,
      skipThreadHistoryLookup: nextSkipThreadHistoryLookup,
    });
    const resultContextSnapshot = result?.contextSnapshot || null;
    const nextProviderSessionId =
      result?.providerSessionId
      || resultContextSnapshot?.session_id
      || null;
    const nextRolloutPath =
      result?.rolloutPath
      || resultContextSnapshot?.rollout_path
      || null;
    if (nextProviderSessionId || nextRolloutPath || resultContextSnapshot) {
      const patch = {};
      if (
        nextProviderSessionId &&
        nextProviderSessionId !== run.session.provider_session_id
      ) {
        patch.runtime_provider = "codex";
        patch.provider_session_id = nextProviderSessionId;
      }
      if (
        nextRolloutPath &&
        nextRolloutPath !== run.session.codex_rollout_path
      ) {
        patch.codex_rollout_path = nextRolloutPath;
      }
      if (
        resultContextSnapshot &&
        JSON.stringify(run.session.last_context_snapshot ?? null)
          !== JSON.stringify(resultContextSnapshot)
      ) {
        patch.last_context_snapshot = resultContextSnapshot;
      }
      if (
        resultContextSnapshot?.last_token_usage &&
        JSON.stringify(run.session.last_token_usage ?? null)
          !== JSON.stringify(resultContextSnapshot.last_token_usage)
      ) {
        patch.last_token_usage = resultContextSnapshot.last_token_usage;
      }
      if (Object.keys(patch).length > 0) {
        run.session = await pool.sessionStore.patch(run.session, patch);
      }
      run.state.providerSessionId =
        nextProviderSessionId || run.state.providerSessionId;
      run.state.rolloutPath = nextRolloutPath || run.state.rolloutPath;
      run.state.contextSnapshot =
        resultContextSnapshot || run.state.contextSnapshot;
    }
    await noteRunEventBestEffort(pool, "run.attempt", {
      ...buildRunEventSessionFields(run.session),
      attempt: recoveredInterruptedRunCount + 1,
      requested_thread_id: nextSessionThreadId || null,
      thread_id: result?.threadId || null,
      duration_ms: result?.attemptInsight?.durationMs ?? null,
      primary_thread_started: result?.attemptInsight?.primaryThreadStarted ?? false,
      commentary_count: result?.attemptInsight?.commentaryCount ?? 0,
      command_count: result?.attemptInsight?.commandCount ?? 0,
      final_answer_seen: result?.attemptInsight?.sawFinalAnswer ?? false,
      last_event_kind: result?.attemptInsight?.lastEventKind || null,
      last_event_type: result?.attemptInsight?.lastEventType || null,
      interrupted: result?.interrupted === true || result?.signal === "SIGINT",
      interrupt_reason: result?.interruptReason || null,
      abort_reason: result?.abortReason || null,
    });

    const interruptedRecoveryKind = classifyInterruptedRunRecovery(run, result, {
      recoveredLiveSteerCount,
      recoveredInterruptedRunCount,
    });
    if (interruptedRecoveryKind) {
      const persistedSessionThreadId = normalizeOptionalText(
        run.session?.codex_thread_id,
      );
      const priorThreadId =
        normalizeOptionalText(result?.threadId) ||
        (
          persistedSessionThreadId
          && normalizeOptionalText(run.state.threadId) === persistedSessionThreadId
            ? persistedSessionThreadId
            : null
        ) ||
        null;
      await noteRunEventBestEffort(pool, "run.recovery", {
        ...buildRunEventSessionFields(run.session),
        recovery_kind: interruptedRecoveryKind,
        attempt: recoveredInterruptedRunCount + 1,
        prior_thread_id: priorThreadId,
        same_thread_resume: Boolean(priorThreadId),
        accepted_live_steer_count: Number(run.state.acceptedLiveSteerCount) || 0,
      });
      recoveredInterruptedRunCount += 1;
      if (interruptedRecoveryKind === "live-steer-restart") {
        recoveredLiveSteerCount = Number(run.state.acceptedLiveSteerCount) || 0;
      }
      await sleep(UPSTREAM_INTERRUPT_RECOVERY_BACKOFF_MS * recoveredInterruptedRunCount);
      const fallback = await prepareInterruptedRunFallback(pool, run, {
        prompt: run.exchangePrompt,
        recoveryKind: interruptedRecoveryKind,
        priorThreadId,
      });
      nextPrompt = fallback.prompt;
      nextSessionThreadId = fallback.sessionThreadId;
      nextSkipThreadHistoryLookup = fallback.skipThreadHistoryLookup ?? false;
      continue;
    }

    if (!result.resumeReplacement || run.state.interruptRequested) {
      return result;
    }

    const replacementThreadId = normalizeOptionalText(
      result.resumeReplacement?.replacementThreadId,
    );
    if (replacementThreadId && replacementThreadId !== nextSessionThreadId) {
      nextSessionThreadId = replacementThreadId;
      run.state.threadId = replacementThreadId;
      run.session = await pool.sessionStore.patch(run.session, {
        codex_thread_id: replacementThreadId,
      });
    }

    if (
      nextSessionThreadId &&
      resumeRetryCount < MAX_THREAD_RESUME_RETRIES
    ) {
      resumeRetryCount += 1;
      run.state.latestSummary = `resume-retry:${resumeRetryCount}`;
      run.state.latestSummaryKind = "event";
      run.state.progress.queueUpdate(
        buildProgressText(run.state, getSessionUiLanguage(run.session)),
      );
      continue;
    }

    return pool.prepareResumeFallback(run, {
      resumeReplacement: result.resumeReplacement,
    });
  }
}

function classifyInterruptedRunRecovery(
  run,
  result,
  {
    recoveredLiveSteerCount = 0,
    recoveredInterruptedRunCount = 0,
  } = {},
) {
  if (run?.state?.interruptRequested) {
    return null;
  }

  const transportResumePending =
    result?.resumeReplacement?.reason === "transport-disconnect";
  const interruptedResult =
    result?.interrupted === true ||
    result?.signal === "SIGINT";
  if (
    !interruptedResult ||
    result?.interruptReason !== "upstream" ||
    (!transportResumePending && result?.abortReason !== "interrupted")
  ) {
    return null;
  }

  if (result?.attemptInsight?.sawFinalAnswer === true) {
    return null;
  }

  if (recoveredInterruptedRunCount >= MAX_UPSTREAM_INTERRUPT_RECOVERIES) {
    return null;
  }

  const acceptedLiveSteerCount = Number(run?.state?.acceptedLiveSteerCount) || 0;
  if (acceptedLiveSteerCount > recoveredLiveSteerCount) {
    return "live-steer-restart";
  }

  return transportResumePending
    ? "transport-resume"
    : "upstream-restart";
}

async function prepareInterruptedRunFallback(
  pool,
  run,
  { prompt, recoveryKind, priorThreadId = null },
) {
  const resumeThreadId =
    typeof priorThreadId === "string" && priorThreadId.trim()
      ? priorThreadId.trim()
      : null;
  const shouldClearContinuityHints = !resumeThreadId;
  run.session = await pool.sessionStore.patch(run.session, {
    codex_thread_id: resumeThreadId,
    ...(shouldClearContinuityHints
      ? {
        provider_session_id: null,
        codex_rollout_path: null,
        last_context_snapshot: null,
      }
      : {}),
  });
  run.state.providerSessionId = shouldClearContinuityHints
    ? null
    : (run.session.provider_session_id ?? run.state.providerSessionId);
  run.state.threadId = resumeThreadId;
  run.state.activeTurnId = null;
  run.state.rolloutPath = shouldClearContinuityHints
    ? null
    : (run.session.codex_rollout_path ?? run.state.rolloutPath);
  run.state.contextSnapshot = shouldClearContinuityHints
    ? null
    : (run.session.last_context_snapshot ?? run.state.contextSnapshot);
  run.state.status = "rebuilding";
  run.state.resumeMode = recoveryKind;
  run.state.latestSummary = recoveryKind;
  run.state.latestSummaryKind = "rebuild";
  run.state.latestProgressMessage = null;
  run.state.latestCommandOutput = null;
  run.state.latestCommand = null;
  run.state.finalAgentMessage = null;
  run.state.finalAgentMessageSource = null;
  run.state.progress.queueUpdate(
    buildProgressText(run.state, getSessionUiLanguage(run.session)),
  );

  if (resumeThreadId) {
    return {
      prompt,
      sessionThreadId: resumeThreadId,
      skipThreadHistoryLookup: false,
    };
  }

  return {
    prompt,
    sessionThreadId: null,
    skipThreadHistoryLookup: true,
  };
}

export async function runAttempt(
  pool,
  run,
  { prompt, imagePaths = [], sessionThreadId, skipThreadHistoryLookup = false },
) {
  const { state } = run;
  const currentSession =
    (await pool.sessionStore.load(run.session.chat_id, run.session.topic_id)) ||
    run.session;
  run.session = currentSession;
  if (!Object.hasOwn(run.runtimeProfileInputs, "globalCodexSettings")) {
    run.runtimeProfileInputs.globalCodexSettings = pool.globalCodexSettingsStore
      ? await pool.globalCodexSettingsStore.load()
      : null;
  }
  if (!Object.hasOwn(run.runtimeProfileInputs, "availableModels")) {
    run.runtimeProfileInputs.availableModels = await loadAvailableCodexModels({
      configPath: pool.config.codexConfigPath,
    });
  }
  const { globalCodexSettings, availableModels } = run.runtimeProfileInputs;
  const runtimeProfile = resolveCodexRuntimeProfile({
    session: currentSession,
    globalSettings: globalCodexSettings,
    config: pool.config,
    target: "spike",
    availableModels,
  });
  state.model = runtimeProfile.model;
  state.reasoningEffort = runtimeProfile.reasoningEffort;
  const attemptStartedAt = Date.now();
  const attemptInsight = {
    primaryThreadStarted: false,
    commentaryCount: 0,
    commandCount: 0,
    sawFinalAnswer: false,
    lastEventKind: null,
    lastEventType: null,
  };
  const applyRuntimeState = async ({
    threadId,
    activeTurnId,
    providerSessionId,
    rolloutPath,
    contextSnapshot,
  } = {}) => {
    const nextThreadId = normalizeOptionalText(threadId);
    const nextActiveTurnId = normalizeOptionalText(activeTurnId);
    const nextProviderSessionId = normalizeOptionalText(providerSessionId);
    const nextRolloutPath = normalizeOptionalText(rolloutPath);
    const nextContextSnapshot = contextSnapshot ?? null;
    const threadChanged =
      nextThreadId &&
      nextThreadId !== (state.threadId || run.session.codex_thread_id || null);
    const patch = {};

    if (nextThreadId) {
      state.threadId = nextThreadId;
      patch.codex_thread_id = nextThreadId;
    }
    if (threadChanged && !nextProviderSessionId) {
      state.providerSessionId = null;
      patch.provider_session_id = null;
    }
    if (nextActiveTurnId) {
      state.activeTurnId = nextActiveTurnId;
    }
    if (nextProviderSessionId) {
      state.providerSessionId = nextProviderSessionId;
      if (nextProviderSessionId !== run.session.provider_session_id) {
        patch.runtime_provider = "codex";
        patch.provider_session_id = nextProviderSessionId;
      }
    }
    if (nextRolloutPath) {
      state.rolloutPath = nextRolloutPath;
      if (nextRolloutPath !== run.session.codex_rollout_path) {
        patch.codex_rollout_path = nextRolloutPath;
      }
    } else if (threadChanged) {
      state.rolloutPath = null;
      patch.codex_rollout_path = null;
    }
    if (nextContextSnapshot) {
      state.contextSnapshot = nextContextSnapshot;
      if (
        JSON.stringify(run.session.last_context_snapshot ?? null)
          !== JSON.stringify(nextContextSnapshot)
      ) {
        patch.last_context_snapshot = nextContextSnapshot;
      }
    } else if (threadChanged) {
      state.contextSnapshot = null;
      patch.last_context_snapshot = null;
    }

    if (Object.keys(patch).length > 0) {
      run.session = await pool.sessionStore.patch(run.session, patch);
    }
  };
  const task = pool.runTask({
    codexBinPath: pool.config.codexBinPath,
    cwd: run.session.workspace_binding.cwd,
    prompt,
    imagePaths,
    sessionKey: run.session.session_key,
    sessionThreadId,
    providerSessionId: state.providerSessionId,
    knownRolloutPath: state.rolloutPath,
    skipThreadHistoryLookup,
    model: runtimeProfile.model,
    reasoningEffort: runtimeProfile.reasoningEffort,
    onRuntimeState: (payload) => applyRuntimeState(payload),
    onEvent: async (summary, event) => {
      const primaryThreadEvent = summary.isPrimaryThreadEvent !== false;
      attemptInsight.lastEventKind = summary.kind || null;
      attemptInsight.lastEventType = summary.eventType || null;
      let shouldRefreshProgress = false;

      if (summary.threadId && primaryThreadEvent) {
        if (summary.eventType === "thread.started") {
          attemptInsight.primaryThreadStarted = true;
        }
        const threadChanged = summary.threadId !== run.session.codex_thread_id;
        state.threadId = summary.threadId;
        if (threadChanged) {
          state.providerSessionId = null;
          state.rolloutPath = null;
          state.contextSnapshot = null;
        }
        run.session = await pool.sessionStore.patch(run.session, {
          codex_thread_id: summary.threadId,
          ...(threadChanged
            ? {
                provider_session_id: null,
                codex_rollout_path: null,
                last_context_snapshot: null,
              }
            : {}),
        });
      }

      if (summary.kind === "command") {
        attemptInsight.commandCount += 1;
        state.latestCommand = summary.command || state.latestCommand;
        if (summary.eventType === "item.completed") {
          state.latestCommandOutput = summary.aggregatedOutput
            ? outputTail(summary.aggregatedOutput)
            : null;
        }
      } else if (summary.kind === "turn" && primaryThreadEvent) {
        if (summary.eventType === "turn.started") {
          state.activeTurnId = summary.turnId || state.activeTurnId;
        } else if (summary.eventType === "turn.completed") {
          state.activeTurnId = null;
        }

        if (summary.usage) {
          state.lastTokenUsage = normalizeTokenUsage(summary.usage);
        }
      } else if (summary.kind === "agent_message") {
        const messagePhase = summary.messagePhase || "final_answer";
        const normalizedAgentMessage = normalizeTelegramReply(summary.text);
        if (messagePhase === "commentary") {
          attemptInsight.commentaryCount += 1;
          state.latestSummary = excerpt(normalizedAgentMessage, 500);
          state.latestSummaryKind = "agent_message";
          state.latestProgressMessage = normalizedAgentMessage;
          shouldRefreshProgress = true;
        }
        if (messagePhase === "final_answer" && primaryThreadEvent) {
          attemptInsight.sawFinalAnswer = true;
          const parsedReply = extractTelegramFileDirectives(summary.text, {
            language: getSessionUiLanguage(run.session),
          });
          state.finalAgentMessage = normalizeTelegramReply(parsedReply.text);
          state.finalAgentMessageSource = parsedReply.text;
          state.replyDocuments = parsedReply.documents;
          state.replyDocumentWarnings = parsedReply.warnings;
        }
      }

      if (!state.finalizing) {
        state.status = state.interruptRequested ? "interrupting" : "running";
      }
      if (shouldRefreshProgress) {
        state.progress.queueUpdate(
          buildProgressText(state, getSessionUiLanguage(run.session)),
        );
      }
    },
    onWarning: (line) => {
      state.warnings.push(line);
    },
  });
  const { child, finished } = task;

  run.child = child;
  run.controller = task;
  if (state.interruptRequested && !state.interruptSignalSent && run.child) {
    state.interruptSignalSent = true;
    signalChildProcessGroup(run.child, "SIGINT");
    setTimeout(() => {
      if (pool.activeRuns.get(run.sessionKey) === run && run.child === child) {
        signalChildProcessGroup(run.child, "SIGKILL");
      }
    }, 5000).unref();
  }
  void pool.flushPendingLiveSteer(run.sessionKey, run).catch((error) => {
    state.warnings.push(`live steer flush failed: ${error.message}`);
  });

  try {
    const result = await finished;
    return {
      ...result,
      attemptInsight: {
        ...attemptInsight,
        durationMs: Date.now() - attemptStartedAt,
      },
    };
  } finally {
    if (run.child === child) {
      run.child = null;
    }
    if (run.controller === task) {
      run.controller = null;
    }
  }
}

export async function prepareResumeFallback(
  pool,
  run,
  { resumeReplacement },
) {
  const current =
    (await pool.sessionStore.load(run.session.chat_id, run.session.topic_id)) ||
    run.session;
  const requestedThreadId =
    typeof resumeReplacement?.requestedThreadId === "string" &&
    resumeReplacement.requestedThreadId.trim()
      ? resumeReplacement.requestedThreadId.trim()
      : null;

  run.session = current;
  run.state.providerSessionId =
    current.provider_session_id ?? run.state.providerSessionId;
  run.state.threadId =
    current.codex_thread_id ?? requestedThreadId ?? run.state.threadId;
  run.state.rolloutPath = current.codex_rollout_path ?? run.state.rolloutPath;
  run.state.contextSnapshot =
    current.last_context_snapshot ?? run.state.contextSnapshot;
  run.state.resumeMode = "resume-pending";
  run.state.latestSummary =
    requestedThreadId
      ? `resume-unavailable:${requestedThreadId}`
      : "resume-unavailable";
  run.state.latestSummaryKind = "event";
  run.state.latestProgressMessage = null;
  run.state.latestCommandOutput = null;
  run.state.latestCommand = null;
  run.state.finalAgentMessage = null;

  return {
    exitCode: 1,
    signal: null,
    threadId: run.state.threadId,
    providerSessionId: run.state.providerSessionId,
    rolloutPath: run.state.rolloutPath,
    contextSnapshot: run.state.contextSnapshot,
    warnings: [
      requestedThreadId
        ? `Native Codex resume is unavailable for thread ${requestedThreadId}; continuity metadata was preserved for a later /resume.`
        : "Native Codex resume is unavailable right now; continuity metadata was preserved for a later /resume.",
    ],
    abortReason: "resume_unavailable",
    interrupted: false,
    resumeReplacement: null,
    preserveContinuity: true,
  };
}
