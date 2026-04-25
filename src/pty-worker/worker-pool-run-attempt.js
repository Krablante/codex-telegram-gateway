import { getSessionUiLanguage } from "../i18n/ui-language.js";
import { writeTextAtomic } from "../state/file-utils.js";
import { extractTelegramFileDirectives } from "../transport/telegram-file-directive.js";
import { normalizeTelegramReply } from "../transport/telegram-reply-normalizer.js";
import {
  resolveCodexRuntimeProfile,
} from "../session-manager/codex-runtime-settings.js";
import { loadAvailableCodexModelsForSession } from "../session-manager/codex-runtime-host.js";
import { normalizeTokenUsage } from "../codex-runtime/token-usage.js";
import {
  buildProgressText,
  excerpt,
  isHiddenProgressDetail,
  outputTail,
  signalChildProcessGroup,
} from "./worker-pool-common.js";
import { normalizeOptionalText } from "./worker-pool-lifecycle-common.js";

function createAttemptInsight() {
  return {
    primaryThreadStarted: false,
    commentaryCount: 0,
    commandCount: 0,
    sawFinalAnswer: false,
    lastEventKind: null,
    lastEventType: null,
  };
}

function isLegacyAppServerBackend(value) {
  const backend = String(value || "").trim().toLowerCase();
  return backend === "app-server" || backend === "appserver";
}

async function loadRuntimeProfileInputs(pool, run) {
  if (!Object.hasOwn(run.runtimeProfileInputs, "globalCodexSettings")) {
    run.runtimeProfileInputs.globalCodexSettings = pool.globalCodexSettingsStore
      ? await pool.globalCodexSettingsStore.load()
      : null;
  }
  if (!Object.hasOwn(run.runtimeProfileInputs, "availableModels")) {
    run.runtimeProfileInputs.availableModels = await loadAvailableCodexModelsForSession({
      session: run.session,
      defaultConfigPath: pool.config.codexConfigPath,
      hostRegistryService: pool.hostRegistryService,
    });
  }

  return run.runtimeProfileInputs;
}

function buildLastRunRuntimeProfilePatch(state) {
  const model = normalizeOptionalText(state.model);
  const reasoningEffort = normalizeOptionalText(state.reasoningEffort);
  const patch = {};
  if (model) {
    patch.last_run_model = model;
  }
  if (reasoningEffort) {
    patch.last_run_reasoning_effort = reasoningEffort;
  }
  return patch;
}

function buildThreadRuntimeProfilePatch(state) {
  const model = normalizeOptionalText(state.model);
  const reasoningEffort = normalizeOptionalText(state.reasoningEffort);
  const patch = buildLastRunRuntimeProfilePatch(state);
  if (model) {
    patch.codex_thread_model = model;
  }
  if (reasoningEffort) {
    patch.codex_thread_reasoning_effort = reasoningEffort;
  }
  return patch;
}

function resolveRuntimeProfileRotationReason(session, runtimeProfile, sessionThreadId) {
  const threadId = normalizeOptionalText(sessionThreadId);
  if (!threadId) {
    return null;
  }

  const nextModel = normalizeOptionalText(runtimeProfile?.model);
  const nextReasoning = normalizeOptionalText(runtimeProfile?.reasoningEffort);
  const threadModel = normalizeOptionalText(session?.codex_thread_model);
  const threadReasoning = normalizeOptionalText(
    session?.codex_thread_reasoning_effort,
  );

  if (threadModel && nextModel && threadModel !== nextModel) {
    return "model-changed";
  }
  if (threadReasoning && nextReasoning && threadReasoning !== nextReasoning) {
    return "reasoning-changed";
  }

  const explicitModelSource =
    runtimeProfile?.modelSource === "topic"
    || runtimeProfile?.modelSource === "global";
  const explicitReasoningSource =
    runtimeProfile?.reasoningSource === "topic"
    || runtimeProfile?.reasoningSource === "global";

  if (!threadModel && nextModel && explicitModelSource) {
    return "unknown-thread-model";
  }
  if (!threadReasoning && nextReasoning && explicitReasoningSource) {
    return "unknown-thread-reasoning";
  }

  return null;
}

async function applyRuntimeState(pool, run, payload = {}) {
  const { state } = run;
  const {
    threadId,
    activeTurnId,
    providerSessionId,
    rolloutPath,
    contextSnapshot,
  } = payload;
  const nextThreadId = normalizeOptionalText(threadId);
  const nextActiveTurnId = normalizeOptionalText(activeTurnId);
  const legacyAppServerBackend = isLegacyAppServerBackend(state.backend);
  const nextProviderSessionId = legacyAppServerBackend
    ? normalizeOptionalText(providerSessionId)
    : null;
  const nextRolloutPath = legacyAppServerBackend
    ? normalizeOptionalText(rolloutPath)
    : null;
  const nextContextSnapshot =
    contextSnapshot && !legacyAppServerBackend
      ? {
          ...contextSnapshot,
          session_id: null,
          rollout_path: null,
        }
      : contextSnapshot ?? null;
  const threadChanged =
    nextThreadId
    && nextThreadId !== (state.threadId || run.session.codex_thread_id || null);
  const patch = {};

  if (nextThreadId) {
    state.threadId = nextThreadId;
    patch.codex_thread_id = nextThreadId;
    Object.assign(patch, buildThreadRuntimeProfilePatch(state));
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
}

async function handleAttemptEvent(pool, run, summary, attemptInsight) {
  const { state } = run;
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
      ...buildThreadRuntimeProfilePatch(state),
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
    if (messagePhase === "commentary" && primaryThreadEvent) {
      attemptInsight.commentaryCount += 1;
      if (!isHiddenProgressDetail(normalizedAgentMessage)) {
        state.latestSummary = excerpt(normalizedAgentMessage, 500);
        state.latestSummaryKind = "agent_message";
        state.latestProgressMessage = normalizedAgentMessage;
        state.holdProgressUntilNaturalUpdate = false;
        await appendProgressNoteBestEffort(pool, run, summary, normalizedAgentMessage);
        shouldRefreshProgress = true;
      }
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
}

async function appendProgressNoteBestEffort(pool, run, summary, text) {
  if (typeof pool.sessionStore?.appendProgressNoteEntry !== "function") {
    return;
  }
  try {
    await pool.sessionStore.appendProgressNoteEntry(run.session, {
      created_at: new Date().toISOString(),
      session_key: run.sessionKey,
      run_started_at: run.startedAt,
      thread_id: summary.threadId || run.state.threadId || run.session.codex_thread_id || null,
      source: summary.progressSource || "agent_message",
      event_type: summary.eventType || null,
      text,
    });
  } catch (error) {
    console.warn("Failed to append progress note", error);
  }
}

function applyInterruptToChild(pool, run, child) {
  const { state } = run;
  if (!state.interruptRequested || state.interruptSignalSent || !child) {
    return;
  }

  state.interruptSignalSent = true;
  signalChildProcessGroup(child, "SIGINT");
  setTimeout(() => {
    if (pool.activeRuns.get(run.sessionKey) === run && run.child === child) {
      signalChildProcessGroup(run.child, "SIGKILL");
    }
  }, 5000).unref();
}

export async function runAttempt(
  pool,
  run,
  {
    prompt,
    developerInstructions = null,
    baseInstructions = null,
    imagePaths = [],
    sessionThreadId,
    skipThreadHistoryLookup = false,
  },
) {
  const { state } = run;
  const currentSession =
    (await pool.sessionStore.load(run.session.chat_id, run.session.topic_id))
    || run.session;
  run.session = currentSession;
  const { globalCodexSettings, availableModels } = await loadRuntimeProfileInputs(
    pool,
    run,
  );
  const runtimeProfile = resolveCodexRuntimeProfile({
    session: currentSession,
    globalSettings: globalCodexSettings,
    config: pool.config,
    target: "spike",
    availableModels,
  });
  state.model = runtimeProfile.model;
  state.reasoningEffort = runtimeProfile.reasoningEffort;
  const profileRotationReason = resolveRuntimeProfileRotationReason(
    currentSession,
    runtimeProfile,
    sessionThreadId,
  );
  const legacyAppServerBackend = state.backend === "app-server";
  const attemptSessionThreadId = profileRotationReason ? null : sessionThreadId;
  const attemptProviderSessionId = profileRotationReason
    ? null
    : legacyAppServerBackend
      ? state.providerSessionId
      : null;
  const attemptRolloutPath = profileRotationReason
    ? null
    : legacyAppServerBackend
      ? state.rolloutPath
      : null;
  const attemptSkipThreadHistoryLookup =
    skipThreadHistoryLookup || Boolean(profileRotationReason);
  const execJsonRunLogPath = !legacyAppServerBackend
    && typeof pool.sessionStore?.getExecJsonRunLogPath === "function"
    ? pool.sessionStore.getExecJsonRunLogPath(
        run.session.chat_id,
        run.session.topic_id,
      )
    : null;
  if (execJsonRunLogPath) {
    await writeTextAtomic(execJsonRunLogPath, "");
  }
  if (profileRotationReason) {
    state.threadId = null;
    state.providerSessionId = null;
    state.rolloutPath = null;
    state.contextSnapshot = null;
    state.resumeMode = null;
    state.latestSummary = `fresh-runtime-profile:${profileRotationReason}`;
    state.latestSummaryKind = "event";
  }
  const attemptStartedAt = Date.now();
  const attemptInsight = createAttemptInsight();

  const task = await pool.runTask({
    codexBinPath: pool.config.codexBinPath,
    cwd: run.session.workspace_binding.cwd,
    prompt,
    developerInstructions: developerInstructions ?? baseInstructions,
    baseInstructions,
    imagePaths,
    session: run.session,
    sessionKey: run.session.session_key,
    executionHost: run.executionHost,
    sessionThreadId: attemptSessionThreadId,
    providerSessionId: attemptProviderSessionId,
    knownRolloutPath: attemptRolloutPath,
    skipThreadHistoryLookup: attemptSkipThreadHistoryLookup,
    model: runtimeProfile.model,
    reasoningEffort: runtimeProfile.reasoningEffort,
    contextWindow: pool.config.codexContextWindow ?? null,
    autoCompactTokenLimit: pool.config.codexAutoCompactTokenLimit ?? null,
    jsonlLogPath: execJsonRunLogPath,
    onRuntimeState: (payload) => applyRuntimeState(pool, run, payload),
    onEvent: async (summary) => {
      await handleAttemptEvent(pool, run, summary, attemptInsight);
    },
    onWarning: (line) => {
      state.warnings.push(line);
    },
  });
  const { child, finished } = task;

  run.child = child;
  run.controller = task;
  applyInterruptToChild(pool, run, child);
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
