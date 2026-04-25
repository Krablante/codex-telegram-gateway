import { getSessionUiLanguage } from "../i18n/ui-language.js";
import { replaceRenderedUserPrompt } from "../session-manager/prompt-suffix.js";
import { buildCompactResumePrompt } from "./compact-resume.js";
import {
  buildProgressText,
  buildPromptWithAttachments,
  buildThreadBaseInstructions,
  isContextWindowExceededText,
  isTransientModelCapacityError,
  sleep,
} from "./worker-pool-common.js";
import {
  buildRunEventSessionFields,
  normalizeOptionalText,
  noteRunEventBestEffort,
  shouldStartFreshFromCompact,
} from "./worker-pool-lifecycle-common.js";

const MAX_THREAD_RESUME_RETRIES = 1;
const MAX_UPSTREAM_INTERRUPT_RECOVERIES = 2;
const UPSTREAM_INTERRUPT_RECOVERY_BACKOFF_MS = 500;
const DEFAULT_UPSTREAM_MODEL_CAPACITY_RETRY_DELAYS_MS = [5000, 15000];

function isLegacyAppServerBackend(value) {
  const backend = String(value || "").trim().toLowerCase();
  return backend === "app-server" || backend === "appserver";
}

function resolveUpstreamModelCapacityRetryDelaysMs(pool) {
  const configured = pool?.config?.upstreamModelCapacityRetryDelaysMs;
  if (!Array.isArray(configured)) {
    return DEFAULT_UPSTREAM_MODEL_CAPACITY_RETRY_DELAYS_MS;
  }

  return configured
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0);
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
  const promptWithAttachments = replaceRenderedUserPrompt(
    prompt,
    run.rawPrompt ?? prompt,
    buildPromptWithAttachments(
      run.rawPrompt ?? prompt,
      attachments,
      getSessionUiLanguage(run.session),
    ),
  );
  const legacyAppServerBackend = isLegacyAppServerBackend(run.state?.backend);
  const sessionThreadId =
    run.session.codex_thread_id
    ?? (legacyAppServerBackend
      ? (
        run.session.last_context_snapshot?.thread_id
        ?? run.session.last_context_snapshot?.threadId
      )
      : null)
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

export async function buildFreshBriefBootstrapPrompt(pool, run, prompt) {
  if (!run.session.last_compacted_at && !run.session.last_compaction_reason) {
    return prompt;
  }

  const activeBrief = await pool.sessionStore.loadActiveBrief(run.session);
  if (!String(activeBrief || "").trim()) {
    return prompt;
  }

  const latestUserRequest = buildPromptWithAttachments(
    run.rawPrompt ?? prompt,
    Array.isArray(run.attachments) ? run.attachments : [],
    getSessionUiLanguage(run.session),
  );

  return buildCompactResumePrompt({
    session: run.session,
    prompt: latestUserRequest,
    compactState: {
      activeBrief,
    },
    mode: "fresh-brief",
  });
}

async function patchAttemptContinuity(pool, run, result) {
  const resultContextSnapshot = result?.contextSnapshot || null;
  const legacyAppServerBackend = isLegacyAppServerBackend(
    result?.backend || run?.state?.backend,
  );
  const nextProviderSessionId = legacyAppServerBackend
    ? (
      result?.providerSessionId
      || resultContextSnapshot?.session_id
      || null
    )
    : null;
  const nextRolloutPath = legacyAppServerBackend
    ? (
      result?.rolloutPath
      || resultContextSnapshot?.rollout_path
      || null
    )
    : null;
  const nextContextSnapshot =
    resultContextSnapshot && !legacyAppServerBackend
      ? {
          ...resultContextSnapshot,
          session_id: null,
          rollout_path: null,
        }
      : resultContextSnapshot;
  if (!(nextProviderSessionId || nextRolloutPath || resultContextSnapshot)) {
    return;
  }

  const patch = {};
  if (
    nextProviderSessionId
    && nextProviderSessionId !== run.session.provider_session_id
  ) {
    patch.runtime_provider = "codex";
    patch.provider_session_id = nextProviderSessionId;
  }
  if (
    nextRolloutPath
    && nextRolloutPath !== run.session.codex_rollout_path
  ) {
    patch.codex_rollout_path = nextRolloutPath;
  }
  if (
    nextContextSnapshot
    && JSON.stringify(run.session.last_context_snapshot ?? null)
      !== JSON.stringify(nextContextSnapshot)
  ) {
    patch.last_context_snapshot = nextContextSnapshot;
  }
  if (
    nextContextSnapshot?.last_token_usage
    && JSON.stringify(run.session.last_token_usage ?? null)
      !== JSON.stringify(nextContextSnapshot.last_token_usage)
  ) {
    patch.last_token_usage = nextContextSnapshot.last_token_usage;
  }
  if (Object.keys(patch).length > 0) {
    run.session = await pool.sessionStore.patch(run.session, patch);
  }
  run.state.providerSessionId =
    nextProviderSessionId || run.state.providerSessionId;
  run.state.rolloutPath = nextRolloutPath || run.state.rolloutPath;
  run.state.contextSnapshot =
    nextContextSnapshot || run.state.contextSnapshot;
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
  let recoveredContextWindowCount = 0;
  let upstreamModelCapacityRetryCount = 0;
  const upstreamModelCapacityRetryDelaysMs =
    resolveUpstreamModelCapacityRetryDelaysMs(pool);
  const globalPromptSuffix = includeTopicContext
    && typeof pool.globalPromptSuffixStore?.load === "function"
    ? await pool.globalPromptSuffixStore.load()
    : null;
  const baseInstructions = includeTopicContext
    ? buildThreadBaseInstructions(
      run.session,
      pool.sessionStore,
      {
        executionHost: run.state.executionHost ?? null,
        allowSystemTempDelivery: pool.config?.allowSystemTempDelivery === true,
        currentHostId: pool.config?.currentHostId ?? null,
        globalPromptSuffix,
      },
    )
    : null;

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
    let result;
    try {
      result = await pool.runAttempt(run, {
        prompt: nextPrompt,
        baseInstructions,
        imagePaths,
        sessionThreadId: nextSessionThreadId,
        skipThreadHistoryLookup: nextSkipThreadHistoryLookup,
      });
    } catch (error) {
      if (
        !run.state.interruptRequested
        && recoveredContextWindowCount === 0
        && pool?.sessionCompactor
        && typeof pool.sessionCompactor.compact === "function"
        && isContextWindowExceededText(error)
      ) {
        recoveredContextWindowCount += 1;
        const fallback = await prepareContextWindowFallback(pool, run, {
          prompt: run.exchangePrompt,
          recoveryAttempt: recoveredContextWindowCount,
        });
        nextPrompt = fallback.prompt;
        nextSessionThreadId = fallback.sessionThreadId;
        nextSkipThreadHistoryLookup = fallback.skipThreadHistoryLookup ?? true;
        continue;
      }

      const retryDelayMs =
        upstreamModelCapacityRetryDelaysMs[upstreamModelCapacityRetryCount];
      if (
        !run.state.interruptRequested
        && retryDelayMs !== undefined
        && isTransientModelCapacityError(error)
      ) {
        upstreamModelCapacityRetryCount += 1;
        nextSessionThreadId = run.state.threadId || nextSessionThreadId;
        nextSkipThreadHistoryLookup = false;
        run.state.status = "rebuilding";
        run.state.latestSummary =
          `model-capacity-retry:${upstreamModelCapacityRetryCount}`;
        run.state.latestSummaryKind = "event";
        run.state.latestProgressMessage = null;
        run.state.latestCommandOutput = null;
        run.state.latestCommand = null;
        await noteRunEventBestEffort(pool, "run.recovery", {
          ...buildRunEventSessionFields(run.session),
          recovery_kind: "model-capacity-retry",
          attempt: upstreamModelCapacityRetryCount,
          prior_thread_id: nextSessionThreadId || null,
          retry_delay_ms: retryDelayMs,
        });
        await sleep(retryDelayMs);
        continue;
      }
      throw error;
    }
    await patchAttemptContinuity(pool, run, result);
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

    if (shouldRecoverContextWindow(pool, run, result, recoveredContextWindowCount)) {
      recoveredContextWindowCount += 1;
      try {
        const fallback = await prepareContextWindowFallback(pool, run, {
          prompt: run.exchangePrompt,
          recoveryAttempt: recoveredContextWindowCount,
        });
        nextPrompt = fallback.prompt;
        nextSessionThreadId = fallback.sessionThreadId;
        nextSkipThreadHistoryLookup = fallback.skipThreadHistoryLookup ?? true;
        continue;
      } catch (error) {
        result.warnings = [
          ...(Array.isArray(result.warnings) ? result.warnings : []),
          `context-window recovery failed: ${error.message}`,
        ];
      }
    }

    const interruptedRecoveryKind = classifyInterruptedRunRecovery(run, result, {
      recoveredLiveSteerCount,
      recoveredInterruptedRunCount,
    });
    if (interruptedRecoveryKind) {
      const persistedSessionThreadId = normalizeOptionalText(
        run.session?.codex_thread_id,
      );
      const priorThreadId =
        normalizeOptionalText(result?.threadId)
        || (
          persistedSessionThreadId
          && normalizeOptionalText(run.state.threadId) === persistedSessionThreadId
            ? persistedSessionThreadId
            : null
        )
        || null;
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
      nextSessionThreadId
      && resumeRetryCount < MAX_THREAD_RESUME_RETRIES
    ) {
      resumeRetryCount += 1;
      run.state.latestSummary = `resume-retry:${resumeRetryCount}`;
      run.state.latestSummaryKind = "event";
      continue;
    }

    return pool.prepareResumeFallback(run, {
      resumeReplacement: result.resumeReplacement,
    });
  }
}

function shouldRecoverContextWindow(pool, run, result, recoveredContextWindowCount) {
  if (recoveredContextWindowCount > 0 || run?.state?.interruptRequested) {
    return false;
  }
  if (!pool?.sessionCompactor || typeof pool.sessionCompactor.compact !== "function") {
    return false;
  }
  if (result?.ok === true || result?.interrupted === true) {
    return false;
  }

  return [
    result?.abortReason,
    ...(Array.isArray(result?.warnings) ? result.warnings : []),
  ].some((value) => isContextWindowExceededText(value));
}

async function prepareContextWindowFallback(
  pool,
  run,
  { prompt, recoveryAttempt = 1 },
) {
  await noteRunEventBestEffort(pool, "run.recovery", {
    ...buildRunEventSessionFields(run.session),
    recovery_kind: "context-window-compact",
    attempt: recoveryAttempt,
    prior_thread_id: normalizeOptionalText(run.state.threadId) || null,
  });

  run.state.status = "rebuilding";
  run.state.resumeMode = "context-window-compact";
  run.state.latestSummary = "context-window-compact";
  run.state.latestSummaryKind = "rebuild";
  run.state.latestProgressMessage = null;
  run.state.latestCommandOutput = null;
  run.state.latestCommand = null;
  run.state.finalAgentMessage = null;
  run.state.finalAgentMessageSource = null;

  const compacted = await pool.sessionCompactor.compact(run.session, {
    reason: "context-window-recovery",
  });
  const compactedSession = compacted?.session || run.session;
  run.session = await pool.sessionStore.patch(compactedSession, {
    last_user_prompt: run.exchangePrompt,
    last_run_status: "running",
    spike_run_owner_generation_id: pool.serviceGenerationId,
    last_run_started_at: run.startedAt,
  });
  run.state.threadId = null;
  run.state.providerSessionId = null;
  run.state.rolloutPath = null;
  run.state.contextSnapshot = null;
  run.state.activeTurnId = null;

  return {
    prompt: await pool.buildFreshBriefBootstrapPrompt(run, prompt),
    sessionThreadId: null,
    skipThreadHistoryLookup: true,
  };
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

  const acceptedLiveSteerCount = Number(run?.state?.acceptedLiveSteerCount) || 0;
  const execJsonBackend =
    result?.backend === "exec-json" || run?.state?.backend === "exec-json";
  if (
    execJsonBackend
    && acceptedLiveSteerCount > recoveredLiveSteerCount
    && recoveredInterruptedRunCount < MAX_UPSTREAM_INTERRUPT_RECOVERIES
  ) {
    return "live-steer-restart";
  }

  const transportResumePending =
    result?.resumeReplacement?.reason === "transport-disconnect";
  const interruptedResult =
    result?.interrupted === true
    || result?.signal === "SIGINT";
  if (
    !interruptedResult
    || result?.interruptReason !== "upstream"
    || (!transportResumePending && result?.abortReason !== "interrupted")
  ) {
    return null;
  }

  if (result?.attemptInsight?.sawFinalAnswer === true) {
    return null;
  }

  if (recoveredInterruptedRunCount >= MAX_UPSTREAM_INTERRUPT_RECOVERIES) {
    return null;
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
  const legacyAppServerBackend = isLegacyAppServerBackend(run?.state?.backend);
  const shouldClearContinuityHints = !resumeThreadId || !legacyAppServerBackend;
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
  run.state.progress?.queueUpdate(
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

export async function prepareResumeFallback(
  pool,
  run,
  { resumeReplacement },
) {
  const current =
    (await pool.sessionStore.load(run.session.chat_id, run.session.topic_id))
    || run.session;
  const requestedThreadId =
    typeof resumeReplacement?.requestedThreadId === "string"
    && resumeReplacement.requestedThreadId.trim()
      ? resumeReplacement.requestedThreadId.trim()
      : null;

  run.session = current;
  const legacyAppServerBackend = isLegacyAppServerBackend(run?.state?.backend);
  run.state.providerSessionId =
    legacyAppServerBackend
      ? current.provider_session_id ?? run.state.providerSessionId
      : null;
  run.state.threadId =
    current.codex_thread_id ?? requestedThreadId ?? run.state.threadId;
  run.state.rolloutPath = legacyAppServerBackend
    ? current.codex_rollout_path ?? run.state.rolloutPath
    : null;
  run.state.contextSnapshot =
    legacyAppServerBackend
      ? current.last_context_snapshot ?? run.state.contextSnapshot
      : null;
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
        ? `Native Codex resume is unavailable for thread ${requestedThreadId}; continuity metadata was preserved for the next prompt retry.`
        : "Native Codex resume is unavailable right now; continuity metadata was preserved for the next prompt retry.",
    ],
    abortReason: "resume_unavailable",
    interrupted: false,
    resumeReplacement: null,
    preserveContinuity: true,
  };
}
