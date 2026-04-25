import { getSessionUiLanguage } from "../i18n/ui-language.js";
import { setActiveRunCount } from "../runtime/service-state.js";
import {
  buildExchangeLogEntry,
  buildFailureText,
  buildInterruptedText,
  buildRunFailureText,
  stringifyMessageId,
} from "./worker-pool-common.js";
import { buildFinalCompletedReplyText } from "./worker-pool-delivery.js";
import {
  buildRunEventSessionFields,
  computeRunDurationMs,
  maybeSuppressSupersededRunCompletion,
  noteRunEventBestEffort,
} from "./worker-pool-lifecycle-common.js";

export function attachRunLifecycle(
  pool,
  run,
  {
    prompt,
    attachments = [],
    includeTopicContext = true,
    originalSession = run.session,
  } = {},
) {
  const { state } = run;
  const progress = state.progress;
  let resultPersisted = false;
  let spikeFinalEventEmitted = false;
  let finalReplyDeliveredViaProgress = false;

  return pool.executeRunLifecycle(run, {
    prompt,
    attachments,
    includeTopicContext,
  })
    .then(async (result) => {
      state.finalizing = true;
      state.threadId = result.threadId || state.threadId;
      state.warnings.push(...result.warnings);
      const successfulRun =
        result?.ok === true
        || (
          result?.ok !== false
          && (
            result.exitCode === 0
            || (
              result?.backend !== "exec-json"
              && result?.attemptInsight?.sawFinalAnswer === true
            )
          )
        );
      const completedWithReply =
        (
          (
            typeof state.finalAgentMessage === "string"
            && state.finalAgentMessage.trim()
          )
          || state.replyDocuments.length > 0
          || state.replyDocumentWarnings.length > 0
        )
        && successfulRun;
      const interruptedResult =
        state.interruptRequested
        || (
          result?.preserveContinuity === true
          && result?.abortReason === "resume_unavailable"
        )
        || result?.interrupted === true
        || result?.signal === "SIGINT";
      const resumePendingResult =
        result?.preserveContinuity === true
        && result?.abortReason === "resume_unavailable";
      state.status = completedWithReply
        ? "completed"
        : interruptedResult
          ? "interrupted"
          : "failed";
      const finishedAt = new Date().toISOString();
      if (await maybeSuppressSupersededRunCompletion(pool, run, {
        state,
        result,
        progress,
        finishedAt,
      })) {
        return;
      }
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
          ? state.finalAgentMessage
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
      const resultBackend = state.backend ?? result?.backend ?? null;
      const clearLegacyRuntimeContinuity = resultBackend === "exec-json";
      const clearStoredThreadState =
        state.status === "failed" && result?.preserveContinuity !== true;
      const persistedThreadId = clearStoredThreadState
        ? null
        : state.threadId || run.session.codex_thread_id || null;
      const persistedProviderSessionId =
        clearStoredThreadState || clearLegacyRuntimeContinuity
        ? null
        : state.providerSessionId
          || run.session.provider_session_id
          || state.contextSnapshot?.session_id
          || null;
      const persistedRolloutPath =
        clearStoredThreadState || clearLegacyRuntimeContinuity
        ? null
        : state.rolloutPath
          || state.contextSnapshot?.rollout_path
          || run.session.codex_rollout_path
          || null;
      const persistedContextSnapshot =
        clearStoredThreadState || clearLegacyRuntimeContinuity
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
          : clearStoredThreadState || clearLegacyRuntimeContinuity
            ? { provider_session_id: null }
            : {}),
        codex_backend: resultBackend,
        codex_thread_id: persistedThreadId,
        codex_thread_model: persistedThreadId ? state.model ?? null : null,
        codex_thread_reasoning_effort:
          persistedThreadId ? state.reasoningEffort ?? null : null,
        codex_rollout_path: persistedRolloutPath,
        last_context_snapshot: persistedContextSnapshot,
        last_user_prompt: run.exchangePrompt,
        last_agent_reply: finalReplyText,
        last_run_status: state.status,
        last_run_backend: resultBackend,
        spike_run_owner_generation_id: null,
        last_run_started_at: run.startedAt,
        last_run_finished_at: finishedAt,
        last_run_model: state.model ?? null,
        last_run_reasoning_effort: state.reasoningEffort ?? null,
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
        backend: state.backend ?? result?.backend ?? null,
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
      finalReplyDeliveredViaProgress = replyDelivery.fallback === "progress";
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
        if (!finalReplyDeliveredViaProgress) {
          await progress.dismiss().catch(() => false);
        }
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
      if (await maybeSuppressSupersededRunCompletion(pool, run, {
        state,
        result: null,
        progress,
        finishedAt,
      })) {
        return;
      }
      const resultBackend = state.backend ?? null;
      const clearLegacyRuntimeContinuity = resultBackend === "exec-json";
      run.session = await pool.sessionStore.patch(originalSession, {
        ...(clearLegacyRuntimeContinuity
          ? {
              provider_session_id: null,
              codex_thread_id: null,
              codex_thread_model: null,
              codex_thread_reasoning_effort: null,
              codex_rollout_path: null,
              last_context_snapshot: null,
            }
          : {}),
        codex_backend: resultBackend,
        last_user_prompt: run.exchangePrompt,
        last_agent_reply: failureText,
        last_run_status: "failed",
        last_run_backend: resultBackend,
        spike_run_owner_generation_id: null,
        last_run_started_at: run.startedAt,
        last_run_finished_at: finishedAt,
        last_run_model: state.model ?? null,
        last_run_reasoning_effort: state.reasoningEffort ?? null,
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
      pool.activeRuns.delete(run.sessionKey);
      if (pool.pendingLiveSteers.has(run.sessionKey)) {
        try {
          const requeued = await pool.requeuePendingLiveSteer(run.sessionKey, run);
          if (!requeued) {
            pool.pendingLiveSteers.delete(run.sessionKey);
            run.state.warnings.push("pending live steer remained buffered after run cleanup");
          }
        } catch (error) {
          pool.pendingLiveSteers.delete(run.sessionKey);
          run.state.warnings.push(`pending live steer requeue failed: ${error.message}`);
        }
      }
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
            `run termination hook failed for ${run.sessionKey}: ${error.message}`,
          );
        }
      }
    })
    .catch((error) => {
      console.error(`run lifecycle failed for ${run.sessionKey}: ${error.message}`);
    });
}
