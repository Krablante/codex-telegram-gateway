import { getSessionUiLanguage } from "../i18n/ui-language.js";
import { markPromptAccepted, setActiveRunCount } from "../runtime/service-state.js";
import { TelegramProgressMessage } from "../transport/progress-message.js";
import { extractTelegramFileDirectives } from "../transport/telegram-file-directive.js";
import { normalizeTelegramReply } from "../transport/telegram-reply-normalizer.js";
import {
  loadAvailableCodexModels,
  resolveCodexRuntimeProfile,
} from "../session-manager/codex-runtime-settings.js";
import { buildCompactResumePrompt, summarizeCompactState } from "./compact-resume.js";
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
  normalizeTokenUsage,
  outputTail,
  resolveReplyToMessageId,
  signalChildProcessGroup,
  sleep,
  stringifyMessageId,
} from "./worker-pool-common.js";
import { buildFinalCompletedReplyText } from "./worker-pool-delivery.js";

const MAX_THREAD_RESUME_RETRIES = 1;

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
    startReserved = false;
  };
  markPromptAccepted(pool.serviceState);
  let run = null;

  const state = {
    sessionKey,
    status: "starting",
    threadId: session.codex_thread_id ?? null,
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
    resumeMode: session.codex_thread_id ? "thread-resume" : null,
    lastTokenUsage: session.last_token_usage ?? null,
    latestCommand: null,
    progress: null,
    replyToMessageId: resolveReplyToMessageId(message),
    lastTypingActionAt: 0,
    typingActionInFlight: false,
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

    run = {
      sessionKey,
      session,
      child: null,
      controller: null,
      lifecyclePromise: null,
      exchangePrompt,
      includeTopicContext,
      state,
      startedAt: new Date().toISOString(),
      progressMessageId: progress.messageId,
      progressTimer: null,
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

    let resultPersisted = false;
    let spikeFinalEventEmitted = false;
    run.lifecyclePromise = pool.executeRunLifecycle(run, {
      prompt,
      attachments,
      includeTopicContext,
    })
      .then(async (result) => {
        state.finalizing = true;
        state.threadId = result.threadId || state.threadId;
        state.warnings.push(...result.warnings);
        const completedWithReply =
          result.exitCode === 0 &&
          typeof state.finalAgentMessage === "string" &&
          state.finalAgentMessage.trim();
        const interruptedResult =
          state.interruptRequested ||
          result?.interrupted === true ||
          result?.signal === "SIGINT";
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
            : state.status === "interrupted"
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
        const clearStoredThreadState = state.status === "interrupted";

        run.session = await pool.sessionStore.patch(run.session, {
          codex_thread_id: clearStoredThreadState ? null : state.threadId,
          ...(clearStoredThreadState
            ? {
                codex_rollout_path: null,
                last_context_snapshot: null,
              }
            : {}),
          last_user_prompt: run.exchangePrompt,
          last_agent_reply: finalReplyText,
          last_run_status: state.status,
          spike_run_owner_generation_id: null,
          last_run_started_at: run.startedAt,
          last_run_finished_at: finishedAt,
          last_token_usage: state.lastTokenUsage,
          last_progress_message_id: stringifyMessageId(progress.messageId),
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

    return {
      ok: true,
      progressMessageId: progress.messageId,
      threadId: state.threadId,
      sessionKey,
      topicId: message.message_thread_id,
    };
  } catch (error) {
    if (run && !run.lifecyclePromise) {
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
    typeof run.controller?.interrupt === "function" &&
    run.state.threadId &&
    run.state.activeTurnId;
  if (nativeInterruptRequested) {
    void run.controller.interrupt({
      threadId: run.state.threadId,
      turnId: run.state.activeTurnId,
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

export async function shutdown(pool) {
  for (const [sessionKey] of pool.activeRuns.entries()) {
    pool.interrupt(sessionKey);
  }

  const startingPromises = [...pool.startingRunPromises.values()];
  if (startingPromises.length > 0) {
    await Promise.allSettled(startingPromises);
  }

  for (const [sessionKey] of pool.activeRuns.entries()) {
    pool.interrupt(sessionKey);
  }

  for (const run of pool.activeRuns.values()) {
    while (
      pool.activeRuns.get(run.sessionKey) === run &&
      !run.lifecyclePromise
    ) {
      await sleep(25);
    }
  }

  const lifecyclePromises = [...pool.activeRuns.values()]
    .map((run) => run.lifecyclePromise)
    .filter(Boolean);

  if (lifecyclePromises.length > 0) {
    await Promise.allSettled(lifecyclePromises);
  }
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
    run.session.last_run_status === "interrupted"
      ? null
      : run.session.codex_thread_id ?? null;
  const initialPrompt = sessionThreadId
    ? promptWithAttachments
    : await pool.buildFreshBriefBootstrapPrompt(run, promptWithAttachments);

  return pool.executeRunAttempts(run, {
    prompt: initialPrompt,
    sessionThreadId,
    attachments,
    includeTopicContext,
  });
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
    includeTopicContext = true,
  },
) {
  let nextPrompt = prompt;
  const imagePaths = attachments
    .filter((attachment) => attachment?.is_image && attachment?.file_path)
    .map((attachment) => attachment.file_path);
  let nextSessionThreadId = sessionThreadId;
  let resumeRetryCount = 0;

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
    });

    if (!result.resumeReplacement || run.state.interruptRequested) {
      return result;
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

    nextPrompt = await pool.prepareResumeFallback(run, {
      prompt,
      resumeReplacement: result.resumeReplacement,
    });
    nextSessionThreadId = null;
  }
}

export async function runAttempt(pool, run, { prompt, imagePaths = [], sessionThreadId }) {
  const { state } = run;
  const currentSession =
    (await pool.sessionStore.load(run.session.chat_id, run.session.topic_id)) ||
    run.session;
  run.session = currentSession;
  const globalCodexSettings = pool.globalCodexSettingsStore
    ? await pool.globalCodexSettingsStore.load({ force: true })
    : null;
  const availableModels = await loadAvailableCodexModels({
    configPath: pool.config.codexConfigPath,
  });
  const runtimeProfile = resolveCodexRuntimeProfile({
    session: currentSession,
    globalSettings: globalCodexSettings,
    config: pool.config,
    target: "spike",
    availableModels,
  });
  state.model = runtimeProfile.model;
  state.reasoningEffort = runtimeProfile.reasoningEffort;
  const task = pool.runTask({
    codexBinPath: pool.config.codexBinPath,
    cwd: run.session.workspace_binding.cwd,
    prompt,
    imagePaths,
    sessionThreadId,
    model: runtimeProfile.model,
    reasoningEffort: runtimeProfile.reasoningEffort,
    onEvent: async (summary, event) => {
      const primaryThreadEvent = summary.isPrimaryThreadEvent !== false;
      let shouldRefreshProgress = false;

      if (summary.threadId && primaryThreadEvent) {
        const threadChanged = summary.threadId !== run.session.codex_thread_id;
        state.threadId = summary.threadId;
        if (threadChanged) {
          state.rolloutPath = null;
          state.contextSnapshot = null;
        }
        run.session = await pool.sessionStore.patch(run.session, {
          codex_thread_id: summary.threadId,
          ...(threadChanged
            ? {
                codex_rollout_path: null,
                last_context_snapshot: null,
              }
            : {}),
        });
      }

      if (summary.kind === "command") {
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
          state.latestSummary = excerpt(normalizedAgentMessage, 500);
          state.latestSummaryKind = "agent_message";
          state.latestProgressMessage = normalizedAgentMessage;
          shouldRefreshProgress = true;
        }
        if (messagePhase === "final_answer" && primaryThreadEvent) {
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
    return await finished;
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
  { prompt, resumeReplacement },
) {
  const current =
    (await pool.sessionStore.load(run.session.chat_id, run.session.topic_id)) ||
    run.session;
  const compacted = pool.sessionCompactor
    ? await pool.sessionCompactor.compact(current, {
        reason: `resume-fallback:${resumeReplacement.requestedThreadId}`,
      })
    : null;
  const compactState = compacted
    ? {
        activeBrief: compacted.activeBrief,
        exchangeLog: Array.from(
          { length: compacted.exchangeLogEntries ?? 0 },
          () => null,
        ),
      }
    : await pool.sessionStore.loadCompactState(current);
  const compactSummary = summarizeCompactState(compactState);

  run.session = await pool.sessionStore.patch(compacted?.session || current, {
    codex_thread_id: null,
    codex_rollout_path: null,
    last_context_snapshot: null,
  });
  run.state.threadId = null;
  run.state.status = "rebuilding";
  run.state.resumeMode = "compact-rebuild";
  run.state.latestSummary =
    `brief-refresh:${compactSummary.exchangeLogEntries}`;
  run.state.latestSummaryKind = "rebuild";
  run.state.latestProgressMessage = null;
  run.state.latestCommandOutput = null;
  run.state.latestCommand = null;
  run.state.finalAgentMessage = null;
  run.state.progress.queueUpdate(
    buildProgressText(run.state, getSessionUiLanguage(run.session)),
  );

  return buildCompactResumePrompt({
    session: current,
    prompt,
    compactState,
  });
}
