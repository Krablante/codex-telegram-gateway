import {
  DEFAULT_UI_LANGUAGE,
  formatUiLanguageLabel,
  getSessionUiLanguage,
  normalizeUiLanguage,
} from "../i18n/ui-language.js";
import { loadCodexConfigProfile } from "../config/runtime-config.js";
import {
  formatReasoningEffort,
  loadAvailableCodexModels,
  resolveCodexRuntimeProfile,
} from "../session-manager/codex-runtime-settings.js";
import {
  buildLegacyContextSnapshot,
  normalizeContextSnapshot,
} from "../session-manager/context-snapshot.js";
import { buildCodexLimitsStatusLines } from "../codex-runtime/limits.js";
import { getTopicLabel } from "./command-parsing.js";

function isEnglish(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng";
}

function isOmniEnabled(surface = null) {
  return surface?.omniEnabled !== false;
}

function getLanguageLabel(language = DEFAULT_UI_LANGUAGE) {
  return formatUiLanguageLabel(language);
}

function formatNumber(value, language = DEFAULT_UI_LANGUAGE) {
  return Number.isInteger(value)
    ? String(value)
    : (isEnglish(language) ? "unknown" : "неизвестно");
}

function formatPercent(value, language = DEFAULT_UI_LANGUAGE) {
  return Number.isFinite(value)
    ? `${value.toFixed(1)}%`
    : (isEnglish(language) ? "unknown" : "неизвестно");
}

function formatCodexSettingValue(kind, value, language = DEFAULT_UI_LANGUAGE) {
  if (!value) {
    return isEnglish(language) ? "default" : "по умолчанию";
  }

  if (kind === "reasoning") {
    return formatReasoningEffort(value) ?? value;
  }

  return value;
}

function buildEffectiveContextSnapshot(
  state,
  session,
  activeRun,
  explicitSnapshot = null,
) {
  return (
    normalizeContextSnapshot(
      explicitSnapshot ??
        activeRun?.state?.contextSnapshot ??
        session.last_context_snapshot,
    ) ??
    buildLegacyContextSnapshot({
      usage: activeRun?.state?.lastTokenUsage ?? session.last_token_usage,
      contextWindow: state.codexContextWindow ?? null,
    })
  );
}

async function resolveStatusRuntimeProfile(
  sessionService,
  session,
  state,
  target,
) {
  if (typeof sessionService.resolveCodexRuntimeProfile === "function") {
    return sessionService.resolveCodexRuntimeProfile(session, { target });
  }

  const globalSettings =
    typeof sessionService.getGlobalCodexSettings === "function"
      ? await sessionService.getGlobalCodexSettings()
      : null;
  const availableModels = await loadAvailableCodexModels({
    configPath: state.codexConfigPath,
  });
  return resolveCodexRuntimeProfile({
    session,
    globalSettings,
    config: state,
    target,
    availableModels,
  });
}

async function loadStatusDisplayConfig(state) {
  const configPath =
    typeof state?.codexConfigPath === "string" && state.codexConfigPath.trim()
      ? state.codexConfigPath.trim()
      : null;
  if (!configPath) {
    return null;
  }

  try {
    const profile = await loadCodexConfigProfile(configPath);
    return {
      contextWindow: Number.isInteger(profile.contextWindow)
        ? profile.contextWindow
        : null,
      autoCompactTokenLimit: Number.isInteger(profile.autoCompactTokenLimit)
        ? profile.autoCompactTokenLimit
        : null,
    };
  } catch {
    return null;
  }
}

function buildContextStatusLines(
  contextSnapshot,
  language = DEFAULT_UI_LANGUAGE,
  { configuredContextWindow = null } = {},
) {
  const usage = contextSnapshot?.last_token_usage ?? null;
  const contextWindow = contextSnapshot?.model_context_window ?? null;
  const english = isEnglish(language);
  const lines = [];

  if (
    Number.isInteger(configuredContextWindow) &&
    Number.isInteger(contextWindow) &&
    configuredContextWindow !== contextWindow
  ) {
    lines.push(
      `${english ? "effective context window" : "effective context window"}: ${formatNumber(contextWindow, language)}`,
    );
  }

  if (!usage) {
    return [
      ...lines,
      english
        ? "context usage: no completed turn yet"
        : "использование контекста: ещё нет завершённого turn",
      `${english ? "context tokens" : "токены контекста"}: ${english ? "unknown" : "неизвестно"} / ${formatNumber(contextWindow, language)}`,
      `${english ? "available tokens" : "доступно токенов"}: ${english ? "unknown" : "неизвестно"}`,
    ];
  }

  const totalTokens = usage.total_tokens;
  const availableTokens =
    contextWindow !== null && totalTokens !== null
      ? Math.max(contextWindow - totalTokens, 0)
      : null;
  const usagePercent =
    contextWindow !== null &&
    contextWindow > 0 &&
    totalTokens !== null
      ? (totalTokens / contextWindow) * 100
      : null;

  lines.push(
    `${english ? "context usage" : "использование контекста"}: ${formatPercent(usagePercent, language)}`,
    `${english ? "context tokens" : "токены контекста"}: ${formatNumber(totalTokens, language)} / ${formatNumber(contextWindow, language)}`,
    `${english ? "available tokens" : "доступно токенов"}: ${formatNumber(availableTokens, language)}`,
    `${english ? "input/cached/output" : "вход/кэш/выход"}: ${formatNumber(usage.input_tokens, language)} / ${formatNumber(usage.cached_input_tokens, language)} / ${formatNumber(usage.output_tokens, language)}`,
  );

  if (usage.reasoning_tokens !== null) {
    lines.push(
      `${english ? "reasoning tokens" : "reasoning tokens"}: ${formatNumber(usage.reasoning_tokens, language)}`,
    );
  }

  return lines;
}

export function buildStatusMessage(
  state,
  message,
  session,
  activeRun = null,
  contextSnapshot = null,
  runtimeProfiles = null,
  language = getSessionUiLanguage(session),
  limitsSummary = null,
  displayConfig = null,
) {
  const english = isEnglish(language);
  const omniEnabled = isOmniEnabled(state);
  const runStatus = activeRun?.state.status ?? session.last_run_status ?? "idle";
  const effectiveContextSnapshot = buildEffectiveContextSnapshot(
    state,
    session,
    activeRun,
    contextSnapshot,
  );
  const contextWindow =
    (Number.isInteger(displayConfig?.contextWindow)
      ? displayConfig.contextWindow
      : null) ??
    effectiveContextSnapshot?.model_context_window ??
    (Number.isInteger(state.codexContextWindow) ? state.codexContextWindow : null);
  const autoCompactTokenLimit =
    (Number.isInteger(displayConfig?.autoCompactTokenLimit)
      ? displayConfig.autoCompactTokenLimit
      : null) ??
    (Number.isInteger(state.codexAutoCompactTokenLimit)
      ? state.codexAutoCompactTokenLimit
      : null);
  const spikeProfile = runtimeProfiles?.spike ?? {
    model: state.codexModel ?? null,
    reasoningEffort: state.codexReasoningEffort ?? null,
  };
  const omniProfile = runtimeProfiles?.omni ?? {
    model: state.codexModel ?? null,
    reasoningEffort: state.codexReasoningEffort ?? null,
  };

  return [
    english ? "Status" : "Статус",
    "",
    `${english ? "topic" : "тема"}: ${session.topic_name ?? getTopicLabel(message)}`,
    `${english ? "session" : "сессия"}: ${session.lifecycle_state}`,
    `run: ${runStatus}`,
    `${english ? "folder" : "папка"}: ${session.workspace_binding.cwd}`,
    `${english ? "branch" : "ветка"}: ${session.workspace_binding.branch ?? "none"}`,
    "",
    `${english ? "language" : "язык"}: ${getLanguageLabel(language)}`,
    `${english ? "model" : "модель"}: ${spikeProfile.model ?? (english ? "unknown" : "неизвестно")}`,
    `${english ? "reasoning" : "reasoning"}: ${formatCodexSettingValue("reasoning", spikeProfile.reasoningEffort, language)}`,
    ...(omniEnabled
      ? [
          `${english ? "omni model" : "omni model"}: ${omniProfile.model ?? (english ? "unknown" : "неизвестно")}`,
          `${english ? "omni reasoning" : "omni reasoning"}: ${formatCodexSettingValue("reasoning", omniProfile.reasoningEffort, language)}`,
        ]
      : []),
    `${english ? "context window" : "context window"}: ${formatNumber(contextWindow, language)}`,
    `${english ? "auto-compact" : "auto-compact"}: ${formatNumber(autoCompactTokenLimit, language)}`,
    "",
    ...buildCodexLimitsStatusLines(limitsSummary, language),
    "",
    ...buildContextStatusLines(effectiveContextSnapshot, language, {
      configuredContextWindow: Number.isInteger(displayConfig?.contextWindow)
        ? displayConfig.contextWindow
        : null,
    }),
  ].join("\n");
}

export async function resolveStatusView({
  state,
  message,
  session,
  sessionService,
  workerPool = null,
  language = getSessionUiLanguage(session),
}) {
  const activeRun =
    typeof workerPool?.getActiveRun === "function"
      ? workerPool.getActiveRun(session.session_key)
      : null;
  const contextState =
    typeof sessionService.resolveContextSnapshot === "function"
      ? await sessionService.resolveContextSnapshot(session, {
          threadId: activeRun?.state?.threadId ?? session.codex_thread_id ?? null,
          rolloutPath:
            activeRun?.state?.rolloutPath ?? session.codex_rollout_path ?? null,
        })
      : {
          session,
          snapshot: null,
        };
  const handledSession = contextState.session;
  if (activeRun?.state && contextState.snapshot) {
    activeRun.state.contextSnapshot = contextState.snapshot;
    activeRun.state.rolloutPath =
      contextState.snapshot.rollout_path ??
      handledSession.codex_rollout_path ??
      null;
  }

  const spikeRuntimeProfile = await resolveStatusRuntimeProfile(
    sessionService,
    handledSession,
    state,
    "spike",
  );
  const omniRuntimeProfile =
    isOmniEnabled(state)
      ? await resolveStatusRuntimeProfile(
          sessionService,
          handledSession,
          state,
          "omni",
        )
      : null;
  const limitsSummary =
    typeof sessionService.getCodexLimitsSummary === "function"
      ? await sessionService.getCodexLimitsSummary({ allowStale: true })
      : null;
  const runtimeProfiles = {
    spike: spikeRuntimeProfile,
    ...(isOmniEnabled(state) ? { omni: omniRuntimeProfile } : {}),
  };
  const displayConfig = await loadStatusDisplayConfig(state);

  return {
    session: handledSession,
    activeRun,
    contextSnapshot: contextState.snapshot,
    runtimeProfiles,
    limitsSummary,
    language,
    text: buildStatusMessage(
      state,
      message,
      handledSession,
      activeRun,
      contextState.snapshot,
      runtimeProfiles,
      language,
      limitsSummary,
      displayConfig,
    ),
  };
}
