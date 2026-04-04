import {
  extractPromptText,
  hasIncomingAttachments,
} from "./incoming-attachments.js";
import {
  DEFAULT_UI_LANGUAGE,
  formatUiLanguageLabel,
  getSessionUiLanguage,
  isWaitFlushWord,
  normalizeUiLanguage,
} from "../i18n/ui-language.js";
import {
  buildReplyMessageParams,
  extractBotCommand,
  getTopicLabel,
  isForeignBotCommand,
  isAuthorizedMessage,
  parseLanguageCommandArgs,
  parseNewTopicCommandArgs,
  parsePromptSuffixCommandArgs,
  parseQueueCommandArgs,
  parseScopedRuntimeSettingCommandArgs,
  parseWaitCommandArgs,
} from "./command-parsing.js";
import {
  GLOBAL_CONTROL_PANEL_COMMAND,
  handleGlobalControlCallbackQuery,
  handleGlobalControlCommand,
  isGeneralForumMessage,
  maybeHandleGlobalControlReply,
} from "./global-control-panel.js";
import {
  TOPIC_CONTROL_PANEL_COMMAND,
  ensureTopicControlPanelMessage,
  handleTopicControlCallbackQuery,
  handleTopicControlCommand,
  maybeHandleTopicControlReply,
} from "./topic-control-panel.js";
import {
  composePromptWithSuffixes,
  isTopicPromptSuffixEnabled,
  normalizePromptSuffixText,
  PROMPT_SUFFIX_MAX_CHARS,
} from "../session-manager/prompt-suffix.js";
import {
  formatReasoningEffort,
  getGlobalRuntimeSettingFieldName,
  getSessionRuntimeSettingFieldName,
  getSupportedReasoningLevelsForModel,
  loadAvailableCodexModels,
  normalizeModelOverride,
  normalizeReasoningEffort,
  resolveCodexRuntimeProfile,
} from "../session-manager/codex-runtime-settings.js";
import {
  buildLegacyContextSnapshot,
  normalizeContextSnapshot,
} from "../session-manager/context-snapshot.js";
import {
  canAutoModeAcceptPromptFromMessage,
  isAutoModeHumanInputLocked,
} from "../session-manager/auto-mode.js";
import { summarizeQueuedPrompt } from "../session-manager/prompt-queue.js";
import { getTopicIdFromMessage } from "../session-manager/session-key.js";
import { getHelpCardAssets } from "./help-card.js";
import { getGuidebookAsset } from "./guidebook.js";
import {
  safeSendDocumentToTopic,
  safeSendMessage,
} from "./topic-delivery.js";
import { clearTrackedGeneralMessages } from "./general-message-cleanup.js";

export {
  buildReplyMessageParams,
  extractBotCommand,
  getTopicLabel,
  isForeignBotCommand,
  isAuthorizedMessage,
  parseLanguageCommandArgs,
  parseNewTopicCommandArgs,
  parsePromptSuffixCommandArgs,
  parseQueueCommandArgs,
  parseScopedRuntimeSettingCommandArgs,
  parseWaitCommandArgs,
};

export function applyPromptSuffix(prompt, session, globalPromptSuffix = null) {
  return composePromptWithSuffixes(prompt, session, globalPromptSuffix);
}

function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function getLanguageLabel(language) {
  return formatUiLanguageLabel(language);
}

async function resolveGeneralUiLanguage(globalControlPanelStore = null) {
  if (!globalControlPanelStore) {
    return DEFAULT_UI_LANGUAGE;
  }

  try {
    const state = await globalControlPanelStore.load({ force: true });
    return normalizeUiLanguage(state?.ui_language);
  } catch {
    return DEFAULT_UI_LANGUAGE;
  }
}

function isOmniEnabled(surface = null) {
  return surface?.omniEnabled !== false;
}

function formatWaitWindow(seconds, language = DEFAULT_UI_LANGUAGE) {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return isEnglish(language) ? "unknown" : "неизвестно";
  }

  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }

  return `${seconds}s`;
}

function getWaitScopeLabel(scope, language = DEFAULT_UI_LANGUAGE) {
  const english = isEnglish(language);
  if (scope === "global") {
    return "global";
  }

  if (scope === "topic") {
    return english ? "local one-shot" : "локальный одноразовый";
  }

  return english ? "effective" : "эффективный";
}

function selectWaitStateByScope(waitState, scope = "effective") {
  if (!waitState) {
    return null;
  }

  if (scope === "global") {
    return waitState.global || null;
  }

  if (scope === "topic") {
    return waitState.local || null;
  }

  return waitState;
}

export function buildNoSessionTopicMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Use a dedicated work topic for this.",
      "",
      "General is not used as a working session.",
      "Create a new topic with /new.",
    ].join("\n");
  }

  return [
    "Для этого нужна отдельная рабочая тема.",
    "",
    "General не используется как рабочая сессия.",
    "Создай новую тему через /new.",
  ].join("\n");
}

function buildAttachmentNeedsCaptionMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Attachment received.",
      "",
      "Add a caption in the same message, or send the task text in the next message in this topic and I will pair it with this attachment.",
    ].join("\n");
  }

  return [
    "Вложение получил.",
    "",
    "Добавь подпись в этом же сообщении, либо следующим сообщением в этом же топике пришли текст задачи, и я привяжу его к этому вложению.",
  ].join("\n");
}

function buildQueueAttachmentNeedsPromptMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Queue attachment received.",
      "",
      "Add a caption in the same message, or send the task text in the next message with /q and I will queue it with this attachment.",
    ].join("\n");
  }

  return [
    "Вложение для очереди получил.",
    "",
    "Добавь подпись в этом же сообщении, либо следующим сообщением пришли текст через /q, и я поставлю его в очередь вместе с этим вложением.",
  ].join("\n");
}

function buildQueueUsageMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Usage:",
      "/q <text>",
      "/q status",
      "/q delete <position>",
    ].join("\n");
  }

  return [
    "Использование:",
    "/q <текст>",
    "/q status",
    "/q delete <номер>",
  ].join("\n");
}

function buildQueueAutoUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Spike queue is unavailable while /auto is active in this topic.",
      "",
      "Turn /auto off first if you want to use /q here.",
    ].join("\n");
  }

  return [
    "Очередь Spike недоступна, пока в этом топике активен /auto.",
    "",
    "Сначала выключи /auto, если хочешь использовать здесь /q.",
  ].join("\n");
}

function buildQueueEmptyMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Spike queue is empty."
    : "Очередь Spike пуста.";
}

function buildQueueQueuedMessage({
  position,
  preview,
  waitingForCapacity = false,
  language = DEFAULT_UI_LANGUAGE,
} = {}) {
  const escapedPreview = preview ? escapeHtml(preview) : null;
  if (isEnglish(language)) {
    const lines = [
      position > 1
        ? `Queued as #${position}.`
        : "Queued as #1.",
      position > 1
        ? "It will start in queue order."
        : waitingForCapacity
        ? "It will start as soon as Spike gets a free worker slot."
        : "It will start right after the current run finishes.",
    ];
    if (escapedPreview) {
      lines.push("", `Preview: <code>${escapedPreview}</code>`);
    }
    return lines.join("\n");
  }

  const lines = [
    position > 1
      ? `Поставил в очередь под номером ${position}.`
      : "Поставил в очередь под номером 1.",
    position > 1
      ? "Запущу по порядку очереди."
      : waitingForCapacity
      ? "Запущу, как только у Spike освободится worker slot."
      : "Запущу сразу после завершения текущего run.",
  ];
  if (escapedPreview) {
    lines.push("", `Коротко: <code>${escapedPreview}</code>`);
  }
  return lines.join("\n");
}

function buildQueueDeletedMessage(
  entry,
  position,
  remaining,
  language = DEFAULT_UI_LANGUAGE,
) {
  const preview = escapeHtml(summarizeQueuedPrompt(entry?.raw_prompt || entry?.prompt));
  if (isEnglish(language)) {
    return [
      `Removed queue item #${position}.`,
      preview ? `Preview: <code>${preview}</code>` : null,
      `Remaining: ${remaining}.`,
    ].filter(Boolean).join("\n");
  }

  return [
    `Удалил элемент очереди #${position}.`,
    preview ? `Коротко: <code>${preview}</code>` : null,
    `Осталось: ${remaining}.`,
  ].filter(Boolean).join("\n");
}

function buildQueueDeleteMissingMessage(position, language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? `Queue item #${position} does not exist.`
    : `Элемента очереди #${position} не существует.`;
}

function buildQueueStatusMessage(entries = [], language = DEFAULT_UI_LANGUAGE) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return buildQueueEmptyMessage(language);
  }

  const heading = isEnglish(language)
    ? `Spike queue: ${entries.length}`
    : `Очередь Spike: ${entries.length}`;
  return [
    heading,
    "",
    ...entries.map((entry, index) => {
      const preview = escapeHtml(
        summarizeQueuedPrompt(entry?.raw_prompt || entry?.prompt),
      );
      return `${index + 1}. <code>${preview || "..."}</code>`;
    }),
  ].join("\n");
}

function formatBinding(binding) {
  return [
    `binding.repo_root: ${binding.repo_root}`,
    `binding.cwd: ${binding.cwd}`,
    `binding.branch: ${binding.branch ?? "none"}`,
    `binding.worktree_path: ${binding.worktree_path}`,
  ].join("\n");
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

function formatCodexSettingSource(source, language = DEFAULT_UI_LANGUAGE) {
  const english = isEnglish(language);
  switch (source) {
    case "topic":
      return english ? "topic" : "topic";
    case "global":
      return english ? "global" : "global";
    case "default":
      return english ? "default" : "default";
    default:
      return english ? "unset" : "unset";
  }
}

function buildCodexSettingUsageMessage(
  commandName,
  language = DEFAULT_UI_LANGUAGE,
) {
  if (isEnglish(language)) {
    return [
      `Usage: /${commandName}`,
      `/${commandName} list`,
      `/${commandName} <value>`,
      `/${commandName} clear`,
      `/${commandName} global`,
      `/${commandName} global list`,
      `/${commandName} global <value>`,
      `/${commandName} global clear`,
    ].join("\n");
  }

  return [
    `Использование: /${commandName}`,
    `/${commandName} list`,
    `/${commandName} <value>`,
    `/${commandName} clear`,
    `/${commandName} global`,
    `/${commandName} global list`,
    `/${commandName} global <value>`,
    `/${commandName} global clear`,
  ].join("\n");
}

function buildCodexSettingStateMessage({
  title,
  commandName,
  kind,
  language = DEFAULT_UI_LANGUAGE,
  topicValue = null,
  globalValue = null,
  effectiveValue = null,
  effectiveSource = "unset",
  showTopicValue = true,
}) {
  const english = isEnglish(language);
  return [
    title,
    "",
    ...(showTopicValue
      ? [
          `${english ? "topic override" : "topic override"}: ${formatCodexSettingValue(kind, topicValue, language)}`,
        ]
      : []),
    `${english ? "global default" : "global default"}: ${formatCodexSettingValue(kind, globalValue, language)}`,
    `${english ? "effective" : "effective"}: ${formatCodexSettingValue(kind, effectiveValue, language)} (${formatCodexSettingSource(effectiveSource, language)})`,
    "",
    buildCodexSettingUsageMessage(commandName, language),
  ].join("\n");
}

function buildCodexSettingListMessage({
  title,
  commandName,
  entries,
  language = DEFAULT_UI_LANGUAGE,
}) {
  const english = isEnglish(language);
  return [
    title,
    "",
    ...(entries.length > 0
      ? entries
      : [english ? "No values discovered." : "Не удалось определить значения."]),
    "",
    buildCodexSettingUsageMessage(commandName, language),
  ].join("\n");
}

const CODEX_RUNTIME_COMMANDS = {
  model: {
    target: "spike",
    kind: "model",
    title: {
      eng: "Spike model",
      rus: "Spike model",
    },
  },
  reasoning: {
    target: "spike",
    kind: "reasoning",
    title: {
      eng: "Spike reasoning",
      rus: "Spike reasoning",
    },
  },
  omni_model: {
    target: "omni",
    kind: "model",
    title: {
      eng: "Omni model",
      rus: "Omni model",
    },
  },
  omni_reasoning: {
    target: "omni",
    kind: "reasoning",
    title: {
      eng: "Omni reasoning",
      rus: "Omni reasoning",
    },
  },
};

function getCodexRuntimeCommandSpec(commandName) {
  return CODEX_RUNTIME_COMMANDS[commandName] ?? null;
}

function formatCodexModelListEntry(model) {
  const details = [];
  if (model.displayName && model.displayName !== model.slug) {
    details.push(model.displayName);
  }
  if (model.defaultReasoningLevel) {
    details.push(`default ${model.defaultReasoningLevel}`);
  }

  return details.length > 0
    ? `- ${model.slug} — ${details.join(" · ")}`
    : `- ${model.slug}`;
}

function formatCodexReasoningListEntry(entry) {
  const base = `- ${entry.label} (${entry.value})`;
  return entry.description ? `${base} — ${entry.description}` : base;
}

function buildInvalidCodexSettingMessage({
  title,
  commandName,
  kind,
  invalidValue,
  entries,
  language = DEFAULT_UI_LANGUAGE,
}) {
  const english = isEnglish(language);
  return [
    english
      ? `${title}: unknown ${kind} "${invalidValue}".`
      : `${title}: неизвестное значение "${invalidValue}".`,
    "",
    ...(entries.length > 0
      ? entries
      : [english ? "No values discovered." : "Не удалось определить значения."]),
    "",
    buildCodexSettingUsageMessage(commandName, language),
  ].join("\n");
}

async function resolveRuntimeCommandState({
  commandName,
  spec,
  session = null,
  sessionService,
  config,
}) {
  const availableModels = await loadAvailableCodexModels({
    configPath: config.codexConfigPath,
  });
  const globalSettings = await sessionService.getGlobalCodexSettings();
  const topicField = getSessionRuntimeSettingFieldName(spec.target, spec.kind);
  const globalField = getGlobalRuntimeSettingFieldName(spec.target, spec.kind);
  const effectiveProfile = session
    ? await sessionService.resolveCodexRuntimeProfile(session, {
        target: spec.target,
      })
    : resolveCodexRuntimeProfile({
        session: null,
        globalSettings,
        config,
        target: spec.target,
      });

  return {
    availableModels,
    globalSettings,
    topicField,
    globalField,
    effectiveProfile,
    title: spec.title[isEnglish(getSessionUiLanguage(session)) ? "eng" : "rus"],
    commandName,
  };
}

async function handleScopedRuntimeSettingCommand({
  commandName,
  parsedCommand,
  session = null,
  sessionService,
  config,
  language = DEFAULT_UI_LANGUAGE,
}) {
  const spec = getCodexRuntimeCommandSpec(commandName);
  if (!spec) {
    return {
      handledSession: session,
      responseText: buildUnknownCommandMessage(language),
    };
  }

  const title = spec.title[isEnglish(language) ? "eng" : "rus"];
  const {
    availableModels,
    globalSettings,
    topicField,
    globalField,
    effectiveProfile,
  } = await resolveRuntimeCommandState({
    commandName,
    spec,
    session,
    sessionService,
    config,
  });
  const scopeReasoningModel =
    parsedCommand.scope === "global"
      ? resolveCodexRuntimeProfile({
          session: null,
          globalSettings,
          config,
          target: spec.target,
        }).model
      : effectiveProfile.model;

  const currentTopicValue = topicField ? session?.[topicField] ?? null : null;
  const currentGlobalValue = globalField ? globalSettings?.[globalField] ?? null : null;

  if (parsedCommand.action === "list") {
    const entries =
      spec.kind === "model"
        ? availableModels.map(formatCodexModelListEntry)
        : getSupportedReasoningLevelsForModel(
            availableModels,
            scopeReasoningModel,
          ).map(formatCodexReasoningListEntry);

    return {
      handledSession: session,
      responseText: buildCodexSettingListMessage({
        title,
        commandName,
        entries,
        language,
      }),
    };
  }

  if (parsedCommand.action === "show") {
    return {
      handledSession: session,
      responseText: buildCodexSettingStateMessage({
        title,
        commandName,
        kind: spec.kind,
        language,
        topicValue: currentTopicValue,
        globalValue: currentGlobalValue,
        effectiveValue:
          spec.kind === "model"
            ? effectiveProfile.model
            : effectiveProfile.reasoningEffort,
        effectiveSource:
          spec.kind === "model"
            ? effectiveProfile.modelSource
            : effectiveProfile.reasoningSource,
        showTopicValue: Boolean(session),
      }),
    };
  }

  if (parsedCommand.action === "clear") {
    const handledSession =
      parsedCommand.scope === "global"
        ? session
        : await sessionService.clearSessionCodexSetting(
            session,
            spec.target,
            spec.kind,
          );
    const nextGlobalSettings =
      parsedCommand.scope === "global"
        ? await sessionService.clearGlobalCodexSetting(spec.target, spec.kind)
        : globalSettings;
    const nextEffectiveProfile =
      handledSession
        ? await sessionService.resolveCodexRuntimeProfile(handledSession, {
            target: spec.target,
          })
        : resolveCodexRuntimeProfile({
            session: null,
            globalSettings: nextGlobalSettings,
            config,
            target: spec.target,
          });

    return {
      handledSession,
      responseText: buildCodexSettingStateMessage({
        title: isEnglish(language)
          ? `${title} cleared.`
          : `${title} очищен.`,
        commandName,
        kind: spec.kind,
        language,
        topicValue:
          topicField && handledSession ? handledSession[topicField] ?? null : null,
        globalValue: globalField ? nextGlobalSettings?.[globalField] ?? null : null,
        effectiveValue:
          spec.kind === "model"
            ? nextEffectiveProfile.model
            : nextEffectiveProfile.reasoningEffort,
        effectiveSource:
          spec.kind === "model"
            ? nextEffectiveProfile.modelSource
            : nextEffectiveProfile.reasoningSource,
        showTopicValue: Boolean(handledSession),
      }),
    };
  }

  if (parsedCommand.action === "set") {
    let normalizedValue;
    let entries = [];

    if (spec.kind === "model") {
      normalizedValue = normalizeModelOverride(parsedCommand.value, availableModels);
      entries = availableModels.map(formatCodexModelListEntry);
    } else {
      normalizedValue = normalizeReasoningEffort(parsedCommand.value);
      entries = getSupportedReasoningLevelsForModel(
        availableModels,
        scopeReasoningModel,
      ).map(formatCodexReasoningListEntry);
      if (
        normalizedValue &&
        !getSupportedReasoningLevelsForModel(
          availableModels,
          scopeReasoningModel,
        ).some((entry) => entry.value === normalizedValue)
      ) {
        normalizedValue = null;
      }
    }

    if (!normalizedValue) {
      return {
        handledSession: session,
        responseText: buildInvalidCodexSettingMessage({
          title,
          commandName,
          kind: spec.kind,
          invalidValue: parsedCommand.value,
          entries,
          language,
        }),
      };
    }

    const handledSession =
      parsedCommand.scope === "global"
        ? session
        : await sessionService.updateSessionCodexSetting(
            session,
            spec.target,
            spec.kind,
            normalizedValue,
          );
    const nextGlobalSettings =
      parsedCommand.scope === "global"
        ? await sessionService.updateGlobalCodexSetting(
            spec.target,
            spec.kind,
            normalizedValue,
          )
        : globalSettings;
    const nextEffectiveProfile =
      handledSession
        ? await sessionService.resolveCodexRuntimeProfile(handledSession, {
            target: spec.target,
          })
        : resolveCodexRuntimeProfile({
            session: null,
            globalSettings: nextGlobalSettings,
            config,
            target: spec.target,
          });

    return {
      handledSession,
      responseText: buildCodexSettingStateMessage({
        title: isEnglish(language)
          ? `${title} updated.`
          : `${title} обновлён.`,
        commandName,
        kind: spec.kind,
        language,
        topicValue:
          topicField && handledSession ? handledSession[topicField] ?? null : null,
        globalValue: globalField ? nextGlobalSettings?.[globalField] ?? null : null,
        effectiveValue:
          spec.kind === "model"
            ? nextEffectiveProfile.model
            : nextEffectiveProfile.reasoningEffort,
        effectiveSource:
          spec.kind === "model"
            ? nextEffectiveProfile.modelSource
            : nextEffectiveProfile.reasoningSource,
        showTopicValue: Boolean(handledSession),
      }),
    };
  }

  return {
    handledSession: session,
    responseText: buildCodexSettingUsageMessage(commandName, language),
  };
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

function buildContextStatusLines(contextSnapshot, language = DEFAULT_UI_LANGUAGE) {
  const usage = contextSnapshot?.last_token_usage ?? null;
  const contextWindow = contextSnapshot?.model_context_window ?? null;
  const english = isEnglish(language);

  if (!usage) {
    return [
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

  const lines = [
    `${english ? "context usage" : "использование контекста"}: ${formatPercent(usagePercent, language)}`,
    `${english ? "context tokens" : "токены контекста"}: ${formatNumber(totalTokens, language)} / ${formatNumber(contextWindow, language)}`,
    `${english ? "available tokens" : "доступно токенов"}: ${formatNumber(availableTokens, language)}`,
    `${english ? "input/cached/output" : "вход/кэш/выход"}: ${formatNumber(usage.input_tokens, language)} / ${formatNumber(usage.cached_input_tokens, language)} / ${formatNumber(usage.output_tokens, language)}`,
  ];

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
    effectiveContextSnapshot?.model_context_window ??
    (Number.isInteger(state.codexContextWindow) ? state.codexContextWindow : null);
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
    `${english ? "auto-compact" : "auto-compact"}: ${formatNumber(state.codexAutoCompactTokenLimit, language)}`,
    "",
    ...buildContextStatusLines(effectiveContextSnapshot, language),
  ].join("\n");
}

export function buildInterruptMessage(
  message,
  session,
  interrupted,
  language = getSessionUiLanguage(session),
) {
  return [
    interrupted
      ? (isEnglish(language) ? "Stopping the run." : "Останавливаю run.")
      : (isEnglish(language) ? "There is no active run here right now." : "Сейчас тут нет активного run."),
    "",
    `session_key: ${session.session_key}`,
    `chat_id: ${message.chat.id}`,
    `topic_id: ${getTopicLabel(message)}`,
  ].join("\n");
}

export function buildUnknownCommandMessage(
  language = DEFAULT_UI_LANGUAGE,
  { omniEnabled = true } = {},
) {
  if (isEnglish(language)) {
    return omniEnabled
      ? "Available commands: /help, /guide, /clear, /new, /zoo, /status, /global, /menu, /auto, /omni, /language, /q, /wait, /suffix, /model, /reasoning, /omni_model, /omni_reasoning, /interrupt, /diff, /compact, and /purge."
      : "Available commands: /help, /guide, /clear, /new, /zoo, /status, /global, /menu, /language, /q, /wait, /suffix, /model, /reasoning, /interrupt, /diff, /compact, and /purge.";
  }

  return omniEnabled
    ? "Сейчас доступны /help, /guide, /clear, /new, /zoo, /status, /global, /menu, /auto, /omni, /language, /q, /wait, /suffix, /model, /reasoning, /omni_model, /omni_reasoning, /interrupt, /diff, /compact и /purge."
    : "Сейчас доступны /help, /guide, /clear, /new, /zoo, /status, /global, /menu, /language, /q, /wait, /suffix, /model, /reasoning, /interrupt, /diff, /compact и /purge.";
}

function buildHelpTextMessage(
  language = DEFAULT_UI_LANGUAGE,
  { omniEnabled = true } = {},
) {
  if (isEnglish(language)) {
    return [
      "SEVERUS quick help",
      "",
      "/help — this cheat sheet",
      "/guide — beginner PDF guidebook from General",
      "/clear — clear General and keep only the active menu",
      "/new [cwd=...|path=...] [title] — create a new work topic",
      "/zoo — open the dedicated Zoo topic",
      "/status — session, model, and context status",
      "/global — pin-friendly global settings menu in General",
      "/menu — pin-friendly local settings menu in this topic",
      ...(omniEnabled
        ? [
            "/auto | /auto status | /auto off — Omni auto mode in this topic",
            "/omni [question] — ask Omni, or just send a plain question during /auto",
          ]
        : []),
      "/language — show or change the UI language",
      "/q <text> — add a prompt to the Spike queue",
      "/q status | /q delete <n> — inspect or remove queued prompts",
      "/wait 60 | wait 600 — local one-shot collection window",
      "/wait global 60 — persistent global collection window",
      "`All`, `Все`, or `Всё` — flush the collected prompt immediately",
      "/wait off — cancel the local one-shot window",
      "/wait global off — disable the global window",
      "/interrupt — stop the run",
      "/diff — diff for the current workspace",
      "/compact — rebuild the brief from the exchange log",
      "/purge — clear local session state",
      "/suffix <text> — topic prompt suffix",
      "/suffix global <text> — global prompt suffix",
      "/suffix topic on|off — routing suffixes for this topic",
      "/suffix help — separate suffix cheat sheet",
      "/model [list|clear|<slug>] — Spike model for this topic",
      "/model global [list|clear|<slug>] — global Spike model default",
      "/reasoning [list|clear|<level>] — Spike reasoning for this topic",
      "/reasoning global [list|clear|<level>] — global Spike reasoning default",
      ...(omniEnabled
        ? [
            "/omni_model [list|clear|<slug>] — Omni model for this topic",
            "/omni_model global [list|clear|<slug>] — global Omni model default",
            "/omni_reasoning [list|clear|<level>] — Omni reasoning for this topic",
            "/omni_reasoning global [list|clear|<level>] — global Omni reasoning default",
          ]
        : []),
    ].join("\n");
  }

  return [
    "SEVERUS quick help",
    "",
    "/help — эта шпаргалка",
    "/guide — PDF-гайдбук для новичка из General",
    "/clear — очистить General и оставить только active menu",
    "/new [cwd=...|path=...] [title] — новая рабочая тема",
    "/zoo — открыть отдельный Zoo topic",
    "/status — статус сессии, модели и контекста",
    "/global — pin-friendly Global settings menu в General",
    "/menu — pin-friendly menu локальных настроек в этом топике",
    ...(omniEnabled
      ? [
          "/auto | /auto status | /auto off — режим Omni /auto в этом топике",
          "/omni [вопрос] — спросить Omni, или просто прислать вопрос текстом во время /auto",
        ]
      : []),
    "/language — показать или сменить язык интерфейса",
    "/q <текст> — поставить prompt в очередь Spike",
    "/q status | /q delete <n> — посмотреть или удалить queued prompts",
    "/wait 60 | wait 600 — local one-shot collection window",
    "/wait global 60 — persistent global collection window",
    "`Все`, `Всё` или `All` — сразу отправить накопленное",
    "/wait off — выключить local one-shot window",
    "/wait global off — выключить global collection window",
    "/interrupt — остановить active run",
    "/diff — diff текущего workspace",
    "/compact — пересобрать brief из exchange log",
    "/purge — очистить local session state",
    "/suffix <text> — topic prompt suffix",
    "/suffix global <text> — global prompt suffix",
    "/suffix topic on|off — topic prompt suffix routing",
    "/suffix help — отдельная шпаргалка по prompt suffix",
    "/model [list|clear|<slug>] — Spike model для этого топика",
    "/model global [list|clear|<slug>] — global default для Spike model",
    "/reasoning [list|clear|<level>] — Spike reasoning для этого топика",
    "/reasoning global [list|clear|<level>] — global default для Spike reasoning",
    ...(omniEnabled
      ? [
          "/omni_model [list|clear|<slug>] — Omni model для этого топика",
          "/omni_model global [list|clear|<slug>] — global default для Omni model",
          "/omni_reasoning [list|clear|<level>] — Omni reasoning для этого топика",
          "/omni_reasoning global [list|clear|<level>] — global default для Omni reasoning",
        ]
      : []),
  ].join("\n");
}

function buildHelpCardPartialFailureMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "I sent part of the help card, but a later page failed.",
      "",
      "Run /help again if you still need the missing page.",
    ].join("\n");
  }

  return [
    "Часть help-card отправил, но следующая страница не доехала.",
    "",
    "Если нужна недостающая часть, просто повтори /help.",
  ].join("\n");
}

function buildGuideGeneralOnlyMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "/guide works in General only.",
      "",
      "Run it there to receive the beginner PDF guidebook.",
    ].join("\n");
  }

  return [
    "/guide работает только в General.",
    "",
    "Запусти его там, чтобы получить PDF-гайдбук для новичка.",
  ].join("\n");
}

function buildClearGeneralOnlyMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "/clear works in General only.",
      "",
      "Run it there to keep only the active General menu.",
    ].join("\n");
  }

  return [
    "/clear работает только в General.",
    "",
    "Запусти его там, чтобы оставить только активное General menu.",
  ].join("\n");
}

function buildClearFailedMessage(language = DEFAULT_UI_LANGUAGE, failedCount = 0) {
  if (isEnglish(language)) {
    return failedCount > 0
      ? `General cleanup finished with ${failedCount} undeleted message(s).`
      : "General cleanup could not run right now.";
  }

  return failedCount > 0
    ? `General cleanup завершился с ${failedCount} неудалёнными сообщениями.`
    : "Сейчас не смог выполнить General cleanup.";
}

function buildGuideGenerationFailureMessage(
  language = DEFAULT_UI_LANGUAGE,
  error = null,
) {
  const detail = error?.message ? `\n\n${isEnglish(language) ? "Error" : "Ошибка"}: ${error.message}` : "";
  return isEnglish(language)
    ? `Could not generate the guidebook right now.${detail}`
    : `Сейчас не смог собрать guidebook.${detail}`;
}

function buildOmniUnavailableMessage(
  language = DEFAULT_UI_LANGUAGE,
  commandName = "omni",
) {
  if (isEnglish(language)) {
    return [
      `/${commandName} is unavailable right now.`,
      "",
      "Omni is disabled in this deployment, so Spike is running alone.",
      "Use plain prompts here like in a normal single-bot topic.",
    ].join("\n");
  }

  return [
    `/${commandName} сейчас недоступен.`,
    "",
    "Omni сейчас отключён, поэтому Spike работает один.",
    "Просто пиши сюда обычные prompt'ы как в обычную single-bot тему.",
  ].join("\n");
}

const AUTO_MODE_ALLOWED_HUMAN_COMMANDS = new Set([
  "help",
  "status",
  "interrupt",
  "language",
  "diff",
  GLOBAL_CONTROL_PANEL_COMMAND,
  "model",
  "reasoning",
  "omni_model",
  "omni_reasoning",
]);

function buildWaitUsageMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Collection windows",
      "",
      "Usage:",
      "/wait 60",
      "wait 600",
      "/wait 1m",
      "/wait global 60",
      "/wait global 1m",
      "/wait",
      "/wait off",
      "/wait global off",
      "",
      "Plain /wait <time> arms a local one-shot window for the next prompt in this topic.",
      "The local window resets automatically after that prompt is sent.",
      "/wait global <time> enables the persistent global window across topics in this chat.",
      "If both exist, the local one-shot window wins in this topic.",
      "Each new message inside the active prompt resets the timer.",
      "Send a separate `All`, `Все`, or `Всё` message to flush immediately.",
    ].join("\n");
  }

  return [
    "Collection windows",
    "",
    "Использование:",
    "/wait 60",
    "wait 600",
    "/wait 1m",
    "/wait global 60",
    "/wait global 1m",
    "/wait",
    "/wait off",
    "/wait global off",
    "",
    "Обычный /wait <время> включает local one-shot window для следующего prompt в этом топике.",
    "Local one-shot window само сбрасывается после отправки этого prompt.",
    "/wait global <время> включает persistent global window для всех тем этого чата.",
    "Если активны оба режима, в этом топике приоритет у local one-shot window.",
    "Каждое новое сообщение внутри активного prompt сбрасывает таймер.",
    "Отправь отдельным сообщением `Все`, `Всё` или `All`, чтобы запустить сразу.",
  ].join("\n");
}

function buildWaitStateMessage(
  waitState,
  heading = "Collection windows",
  language = DEFAULT_UI_LANGUAGE,
  scope = "effective",
) {
  const english = isEnglish(language);
  const selectedState = selectWaitStateByScope(waitState, scope);
  if (!selectedState?.active) {
    return [
      heading,
      "",
      "status: off",
      "",
      scope === "global"
        ? (english
          ? "Enable it with: /wait global 60 or /wait global 1m"
          : "Включить: /wait global 60 или /wait global 1m")
        : scope === "topic"
          ? (english
            ? "Enable it with: /wait 60, wait 600, or /wait 1m"
            : "Включить: /wait 60, wait 600 или /wait 1m")
          : (english
            ? "Enable local with /wait 60 or global with /wait global 60"
            : "Включить локальный через /wait 60 или global через /wait global 60"),
    ].join("\n");
  }

  const seconds = Number.isInteger(selectedState.flushDelayMs)
    ? Math.round(selectedState.flushDelayMs / 1000)
    : null;
  const lines = [
    heading,
    "",
    "status: on",
    `scope: ${getWaitScopeLabel(selectedState.scope, language)}`,
    `timeout: ${formatWaitWindow(seconds, language)}`,
    `buffered parts: ${selectedState.messageCount ?? 0}`,
  ];

  if (scope === "effective") {
    lines.push(
      "",
      english
        ? `local one-shot: ${waitState?.local?.active ? "on" : "off"}`
        : `local one-shot: ${waitState?.local?.active ? "on" : "off"}`,
      english
        ? `global persistent: ${waitState?.global?.active ? "on" : "off"}`
        : `global persistent: ${waitState?.global?.active ? "on" : "off"}`,
    );
  }

  lines.push(
    "",
    selectedState.scope === "global"
      ? (english
        ? "This window stays enabled until /wait global off or a new /wait global <time>."
        : "Это окно остается включенным до /wait global off или нового /wait global <время>.")
      : (english
        ? "This window is local to this topic and resets after the next prompt is sent."
        : "Это окно локально для этого топика и само сбрасывается после отправки следующего prompt."),
    english
      ? "Each new message inside the active prompt resets the timer."
      : "Каждое новое сообщение внутри активного prompt сбрасывает таймер.",
    english
      ? "Send a separate `All`, `Все`, or `Всё` message to flush immediately."
      : "Отправь отдельным сообщением `Все`, `Всё` или `All`, чтобы запустить сразу.",
    selectedState.scope === "global"
      ? (english ? "Disable it: /wait global off" : "Отключить: /wait global off")
      : (english ? "Disable it: /wait off" : "Отключить: /wait off"),
  );

  return lines.join("\n");
}

function buildWaitDisabledMessage(canceled, scope = "topic", language = DEFAULT_UI_LANGUAGE) {
  return [
    isEnglish(language)
      ? scope === "global"
        ? "Global wait is off."
        : "Local wait is off."
      : scope === "global"
        ? "Global wait is off."
        : "Local wait is off.",
    "",
    `discarded parts: ${canceled?.messageCount ?? 0}`,
  ].join("\n");
}

function buildWaitUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "The collection window is unavailable in this runtime."
    : "Collection window недоступно в этом runtime.";
}

function buildLanguageStateMessage(session, language = getSessionUiLanguage(session)) {
  const selected = getLanguageLabel(session?.ui_language ?? language);
  if (isEnglish(language)) {
    return [
      "Interface language",
      "",
      `current: ${selected}`,
      "",
      "Usage:",
      "/language",
      "/language rus",
      "/language eng",
    ].join("\n");
  }

  return [
    "Язык интерфейса",
    "",
    `current: ${selected}`,
    "",
    "Использование:",
    "/language",
    "/language rus",
    "/language eng",
  ].join("\n");
}

function buildLanguageUpdatedMessage(session) {
  const language = getSessionUiLanguage(session);
  return [
    isEnglish(language) ? "Interface language updated." : "Язык интерфейса обновлён.",
    "",
    `current: ${getLanguageLabel(language)}`,
  ].join("\n");
}

function buildLanguageUsageMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Language command is invalid.",
      "",
      "Use /language, /language rus, or /language eng.",
    ].join("\n");
  }

  return [
    "Команда language некорректна.",
    "",
    "Используй /language, /language rus или /language eng.",
  ].join("\n");
}

function buildPromptSuffixMessage(
  promptSuffixState,
  heading,
  scope = "topic",
  language = DEFAULT_UI_LANGUAGE,
) {
  const suffixText = normalizePromptSuffixText(
    promptSuffixState?.prompt_suffix_text,
  );
  const setCommand =
    scope === "global" ? "/suffix global <text>" : "/suffix <text>";

  return [
    heading,
    "",
    `scope: ${scope}`,
    `status: ${promptSuffixState?.prompt_suffix_enabled && suffixText ? "on" : "off"}`,
    `text: ${suffixText ? "set" : "empty"}`,
    "",
    suffixText ||
      (isEnglish(language)
        ? `Set it with ${setCommand}.`
        : `Задай его через ${setCommand}.`),
  ].join("\n");
}

function buildPromptSuffixTooLongMessage(maxChars, language = DEFAULT_UI_LANGUAGE) {
  return [
    isEnglish(language) ? "Prompt suffix is too long." : "Prompt suffix слишком длинный.",
    "",
    `max_chars: ${maxChars}`,
  ].join("\n");
}

function buildPromptSuffixEmptyMessage(
  scope = "topic",
  language = DEFAULT_UI_LANGUAGE,
) {
  const setCommand =
    scope === "global" ? "/suffix global <text>" : "/suffix <text>";

  return [
    isEnglish(language)
      ? "Prompt suffix text is empty."
      : "Текст Prompt suffix пустой.",
    "",
    isEnglish(language)
      ? `Set it first with ${setCommand}.`
      : `Сначала задай его через ${setCommand}.`,
  ].join("\n");
}

function buildPromptSuffixHelpMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Suffix help",
      "",
      "Local suffix in the current topic:",
      "/suffix <text>",
      "/suffix",
      "/suffix on | off | clear",
      "",
      "Global suffix for the whole gateway:",
      "/suffix global <text>",
      "/suffix global",
      "/suffix global on | off | clear",
      "",
      "Topic kill switch:",
      "/suffix topic",
      "/suffix topic off",
      "/suffix topic on",
      "",
      "Priority:",
      "1. /suffix topic off => no suffixes in this topic",
      "2. local suffix on => local overrides global",
      "3. otherwise global suffix if it is enabled",
    ].join("\n");
  }

  return [
    "Prompt suffix help",
    "",
    "Local prompt suffix в текущем топике:",
    "/suffix <text>",
    "/suffix",
    "/suffix on | off | clear",
    "",
    "Global prompt suffix для всего gateway:",
    "/suffix global <text>",
    "/suffix global",
    "/suffix global on | off | clear",
    "",
    "Топик-рубильник:",
    "/suffix topic",
    "/suffix topic off",
    "/suffix topic on",
    "",
    "Приоритет:",
    "1. /suffix topic off => prompt suffixes не применяются в этом топике",
    "2. local suffix on => local перекрывает global",
    "3. иначе применяется global prompt suffix, если он включён",
  ].join("\n");
}

function buildTopicPromptSuffixStateMessage(
  session,
  heading,
  language = getSessionUiLanguage(session),
) {
  return [
    heading,
    "",
    `scope: topic-routing`,
    `status: ${isTopicPromptSuffixEnabled(session) ? "on" : "off"}`,
    "",
    isEnglish(language)
      ? "When off, this topic ignores both local and global prompt suffixes."
      : "Когда выключено, этот топик игнорирует и local, и global prompt suffix.",
    isEnglish(language)
      ? "Use /suffix topic on or /suffix topic off."
      : "Используй /suffix topic on или /suffix topic off.",
  ].join("\n");
}

function buildTopicPromptSuffixUsageMessage(language = DEFAULT_UI_LANGUAGE) {
  return [
    isEnglish(language)
      ? "Topic prompt suffix routing command is invalid."
      : "Команда Topic prompt suffix routing некорректна.",
    "",
    isEnglish(language)
      ? "Use /suffix topic on, /suffix topic off, or /suffix topic."
      : "Используй /suffix topic on, /suffix topic off или /suffix topic.",
  ].join("\n");
}

export function buildNewTopicAckMessage(
  session,
  forumTopic,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        `Created topic "${forumTopic.name}".`,
        "Use it like a normal chat.",
      ].join("\n")
    : [
        `Создал тему «${forumTopic.name}».`,
        "Пиши туда как в обычный чат.",
      ].join("\n");
}

export function buildNewTopicBootstrapMessage(
  session,
  forumTopic,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "Topic is ready.",
        "",
        `This is the work topic "${forumTopic.name}".`,
        "Just write here like in a normal chat.",
        "If you need session details, use /status.",
      ].join("\n")
    : [
        "Тема готова.",
        "",
        `Это рабочая тема «${forumTopic.name}».`,
        "Просто пиши сюда как в обычный чат.",
        "Если понадобятся детали по сессии, используй /status.",
      ].join("\n");
}

export function buildBusyMessage(session, language = getSessionUiLanguage(session)) {
  return isEnglish(language)
    ? [
        "I am still working in this topic.",
        "",
        "You can wait for the reply or press /interrupt.",
      ].join("\n")
    : [
        "Я ещё работаю в этой теме.",
        "",
        "Можешь дождаться ответа или нажать /interrupt.",
      ].join("\n");
}

export function buildSteerAcceptedMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Got it. I will steer this into the current run."
    : "Принял. Докину это в текущий run.";
}

export function buildCapacityMessage(
  maxParallelSessions,
  language = DEFAULT_UI_LANGUAGE,
) {
  return isEnglish(language)
    ? [
        "The bot has hit the parallel run limit.",
        "",
        `max_parallel_sessions: ${maxParallelSessions}`,
        "Wait for one run to finish or stop an active run.",
      ].join("\n")
    : [
        "Сейчас бот упёрся в лимит параллельных run.",
        "",
        `max_parallel_sessions: ${maxParallelSessions}`,
        "Дождись завершения одного из них или останови активный run.",
      ].join("\n");
}

export function buildDiffCleanMessage(
  session,
  generatedAt,
  language = getSessionUiLanguage(session),
) {
  return [
    isEnglish(language)
      ? "Workspace diff is currently empty."
      : "Workspace diff сейчас пустой.",
    "",
    `session_key: ${session.session_key}`,
    `generated_at: ${generatedAt}`,
    `cwd: ${session.workspace_binding.cwd}`,
  ].join("\n");
}

export function buildDocumentTooLargeMessage(
  session,
  filePath,
  sizeBytes,
  language = getSessionUiLanguage(session),
) {
  return [
    isEnglish(language)
      ? "Artifact is too large for Telegram file delivery."
      : "Артефакт слишком большой для доставки через Telegram.",
    "",
    `session_key: ${session.session_key}`,
    `size_bytes: ${sizeBytes}`,
    `local_path: ${filePath}`,
  ].join("\n");
}

export function buildPurgeBusyMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "You cannot purge the session while a run is still active.",
        "",
        "Stop it with /interrupt first, then repeat /purge.",
      ].join("\n")
    : [
        "Нельзя чистить сессию, пока run ещё идёт.",
        "",
        "Сначала останови его через /interrupt, потом повтори /purge.",
      ].join("\n");
}

export function buildPurgeAckMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "Session state purged.",
        "",
        `session_key: ${session.session_key}`,
        `topic_id: ${session.topic_id}`,
        "Stored exchange log, active brief, and diff artifacts were removed.",
        "Send plain text here to start a fresh session in the same topic.",
      ].join("\n")
    : [
        "Состояние сессии очищено.",
        "",
        `session_key: ${session.session_key}`,
        `topic_id: ${session.topic_id}`,
        "Сохранённые exchange log, active brief и diff-артефакты удалены.",
        "Отправь сюда обычный текст, чтобы начать свежую сессию в этом же топике.",
      ].join("\n");
}

export function buildPurgedSessionMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "This session is currently purged.",
        "",
        "Send a new message and I will start it again in the same topic.",
      ].join("\n")
    : [
        "Эта сессия сейчас очищена.",
        "",
        "Просто отправь новое сообщение, и я начну её заново в этой же теме.",
      ].join("\n");
}

export function buildCompactMessage(
  session,
  compacted,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "Session compacted.",
        "",
        `session_key: ${session.session_key}`,
        `reason: ${compacted.reason}`,
        `exchange_log_entries: ${compacted.exchangeLogEntries}`,
        `active_brief: refreshed`,
      ].join("\n")
    : [
        "Сессия пересобрана.",
        "",
        `session_key: ${session.session_key}`,
        `reason: ${compacted.reason}`,
        `exchange_log_entries: ${compacted.exchangeLogEntries}`,
        `active_brief: refreshed`,
      ].join("\n");
}

export function buildCompactStartedMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "Compaction started.",
        "",
        `session_key: ${session.session_key}`,
        "I will post the refreshed brief status here when it finishes.",
      ].join("\n")
    : [
        "Пересборка brief запущена.",
        "",
        `session_key: ${session.session_key}`,
        "Когда закончу, пришлю итог сюда.",
      ].join("\n");
}

export function buildCompactAlreadyRunningMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "Compaction is already running for this session.",
        "",
        `session_key: ${session.session_key}`,
      ].join("\n")
    : [
        "Для этой сессии compact уже выполняется.",
        "",
        `session_key: ${session.session_key}`,
      ].join("\n");
}

export function buildCompactFailureMessage(
  session,
  error,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "Compaction failed.",
        "",
        `session_key: ${session.session_key}`,
        `error: ${error.message}`,
      ].join("\n")
    : [
        "Не смог выполнить compact.",
        "",
        `session_key: ${session.session_key}`,
        `error: ${error.message}`,
      ].join("\n");
}

export function buildBindingResolutionErrorMessage(
  requestedPath,
  error,
  language = DEFAULT_UI_LANGUAGE,
) {
  return [
    isEnglish(language)
      ? "Failed to resolve workspace binding for /new."
      : "Не смог разрешить workspace binding для /new.",
    "",
    `requested_path: ${requestedPath || "none"}`,
    `error: ${error.message}`,
  ].join("\n");
}

function markCommandHandled(serviceState, commandName) {
  serviceState.handledCommands += 1;
  serviceState.lastCommandName = commandName;
  serviceState.lastCommandAt = new Date().toISOString();
}

function buildSyntheticCommandMessage(actor, chat, commandText) {
  const rawCommand = String(commandText ?? "").trim().split(/\s+/u)[0] ?? "";
  return {
    text: commandText,
    entities: rawCommand.startsWith("/")
      ? [{ type: "bot_command", offset: 0, length: rawCommand.length }]
      : undefined,
    from: actor,
    chat,
    message_thread_id: Number.isInteger(chat?.message_thread_id)
      ? chat.message_thread_id
      : undefined,
    is_internal_global_control_dispatch: true,
  };
}

function launchCompactionInBackground({
  api,
  lifecycleManager,
  message,
  session,
  compactPromise,
}) {
  void (async () => {
    try {
      const compacted = await compactPromise;
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildCompactMessage(
            compacted.session,
            compacted,
            getSessionUiLanguage(compacted.session),
          ),
        ),
        compacted.session,
        lifecycleManager,
      );
    } catch (error) {
      console.error(
        `background compact failed for ${session.session_key}: ${error.message}`,
      );
      try {
        await safeSendMessage(
          api,
          buildReplyMessageParams(
            message,
            buildCompactFailureMessage(
              session,
              error,
              getSessionUiLanguage(session),
            ),
          ),
          session,
          lifecycleManager,
        );
      } catch (deliveryError) {
        console.error(
          `background compact failure reply failed for ${session.session_key}: ${deliveryError.message}`,
        );
      }
    }
  })();
}

async function handleTopicPrompt({
  api,
  config,
  lifecycleManager = null,
  message,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  return startTopicPromptRun({
    api,
    config,
    lifecycleManager,
    messages: [message],
    promptStartGuard,
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool,
  });
}

function buildPromptFromMessages(messages, { bufferMode = "auto" } = {}) {
  void bufferMode;
  return messages
    .map((entry) => extractPromptText(entry, { trim: true }))
    .filter((entry) => entry.length > 0)
    .join("\n\n")
    .trim();
}

function buildBufferedPromptFlush({
  api,
  botUsername,
  config,
  lifecycleManager,
  promptStartGuard = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  return async (bufferedMessages, flushState = {}) => {
    if (!Array.isArray(bufferedMessages) || bufferedMessages.length === 0) {
      return;
    }

    await startTopicPromptRun({
      api,
      bufferMode: flushState.mode ?? "auto",
      botUsername,
      config,
      lifecycleManager,
      messages: bufferedMessages,
      promptStartGuard,
      promptFragmentAssembler: null,
      serviceState,
      sessionService,
      workerPool,
    });
  };
}

function buildQueuedPromptFromMessages(messages, botUsername) {
  const promptMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (promptMessages.length === 0) {
    return "";
  }

  const firstMessage = promptMessages[0];
  const firstCommand = extractBotCommand(firstMessage, botUsername);
  if (firstCommand?.name !== "q") {
    return buildPromptFromMessages(promptMessages);
  }

  const parts = [];
  const commandText = String(firstCommand.args || "").trim();
  if (commandText) {
    parts.push(commandText);
  }

  for (const entry of promptMessages.slice(1)) {
    const text = extractPromptText(entry, { trim: true });
    if (text) {
      parts.push(text);
    }
  }

  return parts.join("\n\n").trim();
}

function buildBufferedQueueFlush({
  api,
  botUsername,
  config,
  lifecycleManager,
  promptStartGuard = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  return async (bufferedMessages) => {
    if (!Array.isArray(bufferedMessages) || bufferedMessages.length === 0) {
      return;
    }

    await queueTopicPrompt({
      api,
      botUsername,
      config,
      lifecycleManager,
      messages: bufferedMessages,
      promptStartGuard,
      queuePromptAssembler: null,
      serviceState,
      sessionService,
      workerPool,
    });
  };
}

async function queueTopicPrompt({
  api,
  botUsername,
  config,
  lifecycleManager = null,
  messages,
  promptStartGuard = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  const promptMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const message = promptMessages.at(-1) ?? null;
  if (!message) {
    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "missing-message", handledSession: null };
  }

  const promptStartGuardResult =
    await promptStartGuard?.handleCompetingTopicMessage(message);
  if (promptStartGuardResult?.handled) {
    return {
      handled: true,
      reason: promptStartGuardResult.reason,
      handledSession: null,
    };
  }

  const topicId = getTopicIdFromMessage(message);
  if (!topicId) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildNoSessionTopicMessage()),
      null,
      lifecycleManager,
    );
    return { handled: true, reason: "general-topic", handledSession: null };
  }

  let session = await sessionService.ensureRunnableSessionForMessage(message);
  if (
    config.omniEnabled !== false &&
    isAutoModeHumanInputLocked(session)
  ) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildQueueAutoUnavailableMessage(getSessionUiLanguage(session)),
      ),
      session,
      lifecycleManager,
    );
    return {
      handled: true,
      reason: "queue-auto-disabled",
      handledSession: session,
    };
  }

  const rawPrompt = buildQueuedPromptFromMessages(promptMessages, botUsername);
  const shouldBuffer =
    queuePromptAssembler?.shouldBufferMessage(message, rawPrompt);
  if (shouldBuffer) {
    queuePromptAssembler.enqueue({
      message,
      flush: buildBufferedQueueFlush({
        api,
        botUsername,
        config,
        lifecycleManager,
        promptStartGuard,
        queuePromptAssembler,
        serviceState,
        sessionService,
        workerPool,
      }),
    });
    return {
      handled: true,
      reason: "queue-buffered",
      handledSession: session,
    };
  }

  if (!rawPrompt) {
    if (promptMessages.some((entry) => hasIncomingAttachments(entry))) {
      const pendingAttachments = [];
      for (const promptMessage of promptMessages) {
        if (!hasIncomingAttachments(promptMessage)) {
          continue;
        }

        pendingAttachments.push(
          ...(await sessionService.ingestIncomingAttachments(
            api,
            session,
            promptMessage,
          )),
        );
      }

      if (
        pendingAttachments.length > 0 &&
        typeof sessionService.bufferPendingPromptAttachments === "function"
      ) {
        await sessionService.bufferPendingPromptAttachments(
          session,
          pendingAttachments,
          { scope: "queue" },
        );
      }
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildQueueAttachmentNeedsPromptMessage(getSessionUiLanguage(session)),
        ),
        session,
        lifecycleManager,
      );
      return {
        handled: true,
        reason: "queue-attachment-without-prompt",
        handledSession: session,
      };
    }

    await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildQueueUsageMessage(getSessionUiLanguage(session)),
      ),
      session,
      lifecycleManager,
    );
    return {
      handled: true,
      reason: "queue-usage",
      handledSession: session,
    };
  }

  const globalPromptSuffix =
    typeof sessionService.getGlobalPromptSuffix === "function"
      ? await sessionService.getGlobalPromptSuffix()
      : null;
  const effectivePrompt = applyPromptSuffix(rawPrompt, session, globalPromptSuffix);
  const attachments =
    typeof sessionService.getPendingPromptAttachments === "function"
      ? await sessionService.getPendingPromptAttachments(session, {
          scope: "queue",
        })
      : [];
  for (const promptMessage of promptMessages) {
    if (!hasIncomingAttachments(promptMessage)) {
      continue;
    }

    attachments.push(
      ...(await sessionService.ingestIncomingAttachments(
        api,
        session,
        promptMessage,
      )),
    );
  }

  const queued = await sessionService.enqueuePromptQueue(session, {
    rawPrompt,
    prompt: effectivePrompt,
    attachments,
    replyToMessageId: Number.isInteger(message.message_id) ? message.message_id : null,
  });

  if (
    attachments.length > 0 &&
    typeof sessionService.clearPendingPromptAttachments === "function"
  ) {
    session = await sessionService.clearPendingPromptAttachments(session, {
      scope: "queue",
    });
  }

  if (
    queued.position === 1 &&
    typeof sessionService.drainPromptQueue === "function"
  ) {
    const drainResults = await sessionService.drainPromptQueue(workerPool, {
      session,
    });
    const drainResult = drainResults.find(
      (entry) => entry.sessionKey === session.session_key,
    );
    if (drainResult?.result?.reason === "prompt-started") {
      return {
        handled: true,
        reason: "prompt-started",
        handledSession: session,
      };
    }
  }

  const delivery = await safeSendMessage(
    api,
    buildReplyMessageParams(
      message,
      buildQueueQueuedMessage({
        position: queued.position,
        preview: summarizeQueuedPrompt(rawPrompt),
        waitingForCapacity:
          queued.position === 1 &&
          !(typeof workerPool.getActiveRun === "function"
            && workerPool.getActiveRun(session.session_key)),
        language: getSessionUiLanguage(session),
      }),
    ),
    session,
    lifecycleManager,
  );
  if (delivery.parked) {
    return {
      handled: true,
      reason: "topic-unavailable",
      handledSession: delivery.session || session,
    };
  }

  return {
    handled: true,
    reason: "prompt-queued",
    handledSession: session,
  };
}

async function handleQueueCommand({
  api,
  botUsername,
  config,
  lifecycleManager = null,
  message,
  parsedCommand,
  promptStartGuard = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  if (!getTopicIdFromMessage(message)) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildNoSessionTopicMessage()),
      null,
      lifecycleManager,
    );
    return { handled: true, reason: "general-topic", handledSession: null };
  }

  const session = await sessionService.ensureSessionForMessage(message);
  const language = getSessionUiLanguage(session);

  if (parsedCommand.action === "status") {
    const entries = await sessionService.listPromptQueue(session);
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildQueueStatusMessage(entries, language)),
      session,
      lifecycleManager,
    );
    return {
      handled: true,
      reason: delivery.parked ? "topic-unavailable" : "queue-status",
      handledSession: delivery.session || session,
    };
  }

  if (parsedCommand.action === "delete") {
    const deleted = await sessionService.deletePromptQueueEntry(
      session,
      parsedCommand.position,
    );
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        deleted.entry
          ? buildQueueDeletedMessage(
              deleted.entry,
              parsedCommand.position,
              deleted.size,
              language,
            )
          : buildQueueDeleteMissingMessage(parsedCommand.position, language),
      ),
      session,
      lifecycleManager,
    );
    return {
      handled: true,
      reason: delivery.parked ? "topic-unavailable" : "queue-deleted",
      handledSession: delivery.session || session,
    };
  }

  return queueTopicPrompt({
    api,
    botUsername,
    config,
    lifecycleManager,
    messages: [message],
    promptStartGuard,
    queuePromptAssembler,
    serviceState,
    sessionService,
    workerPool,
  });
}

function buildApplyTopicWaitChange({
  api,
  botUsername,
  config,
  lifecycleManager,
  promptStartGuard,
  promptFragmentAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  return async ({
    message,
    value,
  }) => {
    if (!promptFragmentAssembler) {
      return { available: false };
    }

    if (value === "off") {
      promptFragmentAssembler.cancelPendingForMessage(message, {
        scope: "topic",
      });
      return { available: true };
    }

    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      return { available: false };
    }

    promptFragmentAssembler.openWindow({
      message,
      flushDelayMs: seconds * 1000,
      scope: "topic",
      flush: buildBufferedPromptFlush({
        api,
        botUsername,
        config,
        lifecycleManager,
        promptStartGuard,
        serviceState,
        sessionService,
        workerPool,
      }),
    });
    return { available: true };
  };
}

function isManualWaitFlushMessage(message, promptFragmentAssembler) {
  if (!promptFragmentAssembler) {
    return false;
  }

  const waitState = promptFragmentAssembler.getStateForMessage(message);
  if (!waitState.active || waitState.mode !== "manual" || waitState.messageCount <= 0) {
    return false;
  }

  if (hasIncomingAttachments(message)) {
    return false;
  }

  const promptText = extractPromptText(message, { trim: true });
  return isWaitFlushWord(promptText);
}

async function startTopicPromptRun({
  api,
  bufferMode = "auto",
  config,
  lifecycleManager = null,
  messages,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  const promptMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const message = promptMessages.at(-1) ?? null;
  if (!message) {
    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "missing-message" };
  }

  const promptStartGuardResult =
    await promptStartGuard?.handleCompetingTopicMessage(message);
  if (promptStartGuardResult?.handled) {
    return { handled: true, reason: promptStartGuardResult.reason };
  }

  const topicId = getTopicIdFromMessage(message);
  if (!topicId) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildNoSessionTopicMessage()),
      null,
      lifecycleManager,
    );
    return { handled: true, reason: "general-topic" };
  }

  const lockedSession = await sessionService.ensureRunnableSessionForMessage(message);
  if (
    config.omniEnabled !== false &&
    isAutoModeHumanInputLocked(lockedSession)
    && !canAutoModeAcceptPromptFromMessage(lockedSession, message)
  ) {
    return { handled: true, reason: "auto-topic-human-input-blocked" };
  }

  const rawPrompt = buildPromptFromMessages(promptMessages, { bufferMode });
  const prompt = rawPrompt;
  const shouldBuffer =
    !message?.is_internal_omni_handoff
    && promptFragmentAssembler?.shouldBufferMessage(message, rawPrompt);
  if (shouldBuffer) {
    promptFragmentAssembler.enqueue({
      message,
      flush: buildBufferedPromptFlush({
        api,
        config,
        lifecycleManager,
        promptStartGuard,
        serviceState,
        sessionService,
        workerPool,
      }),
    });
    return { handled: true, reason: "prompt-buffered" };
  }

  if (!prompt) {
    if (promptMessages.some((entry) => hasIncomingAttachments(entry))) {
      const attachmentSession =
        typeof sessionService.ensureSessionForMessage === "function"
          ? await sessionService.ensureSessionForMessage(message)
          : null;
      if (attachmentSession) {
        const pendingAttachments = [];
        for (const promptMessage of promptMessages) {
          if (!hasIncomingAttachments(promptMessage)) {
            continue;
          }

          pendingAttachments.push(
            ...(await sessionService.ingestIncomingAttachments(
              api,
              attachmentSession,
              promptMessage,
            )),
          );
        }

        if (
          pendingAttachments.length > 0 &&
          typeof sessionService.bufferPendingPromptAttachments === "function"
        ) {
          await sessionService.bufferPendingPromptAttachments(
            attachmentSession,
            pendingAttachments,
          );
        }
      }
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildAttachmentNeedsCaptionMessage(
            attachmentSession
              ? getSessionUiLanguage(attachmentSession)
              : DEFAULT_UI_LANGUAGE,
          ),
        ),
        attachmentSession,
        lifecycleManager,
      );
      return { handled: true, reason: "attachment-without-caption" };
    }

    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "empty-prompt" };
  }

  let session = lockedSession;
  const globalPromptSuffix =
    typeof sessionService.getGlobalPromptSuffix === "function"
      ? await sessionService.getGlobalPromptSuffix()
      : null;
  const effectivePrompt = applyPromptSuffix(prompt, session, globalPromptSuffix);
  const attachments =
    typeof sessionService.getPendingPromptAttachments === "function"
      ? await sessionService.getPendingPromptAttachments(session)
      : [];
  for (const promptMessage of promptMessages) {
    if (!hasIncomingAttachments(promptMessage)) {
      continue;
    }

    attachments.push(
      ...(await sessionService.ingestIncomingAttachments(
        api,
        session,
        promptMessage,
      )),
    );
  }
  const started = await workerPool.startPromptRun({
    session,
    prompt: effectivePrompt,
    rawPrompt,
    message,
    attachments,
  });

  if (!started.ok) {
    if (
      started.reason === "busy" &&
      typeof workerPool.steerActiveRun === "function"
    ) {
      const steered = await workerPool.steerActiveRun({
        session,
        rawPrompt,
        message,
        attachments,
      });
      if (steered.ok) {
        if (
          attachments.length > 0 &&
          typeof sessionService.clearPendingPromptAttachments === "function"
        ) {
          session = await sessionService.clearPendingPromptAttachments(session);
        }
        const delivery = await safeSendMessage(
          api,
          buildReplyMessageParams(
            message,
            buildSteerAcceptedMessage(getSessionUiLanguage(session)),
          ),
          session,
          lifecycleManager,
        );
        if (delivery.parked) {
          return { handled: true, reason: "topic-unavailable" };
        }
        return { handled: true, reason: steered.reason || "steered" };
      }
    }

    const replyText =
      started.reason === "busy"
        ? buildBusyMessage(session, getSessionUiLanguage(session))
        : buildCapacityMessage(
            config.maxParallelSessions,
            getSessionUiLanguage(session),
          );
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, replyText),
      session,
      lifecycleManager,
    );
    if (delivery.parked) {
      return { handled: true, reason: "topic-unavailable" };
    }
    return { handled: true, reason: started.reason };
  }

  if (
    attachments.length > 0 &&
    typeof sessionService.clearPendingPromptAttachments === "function"
  ) {
    await sessionService.clearPendingPromptAttachments(session);
  }

  return { handled: true, reason: "prompt-started" };
}

export async function handleIncomingMessage({
  api,
  botUsername,
  config,
  lifecycleManager = null,
  globalControlPanelStore = null,
  generalMessageLedgerStore = null,
  topicControlPanelStore = null,
  zooService = null,
  message,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  if (!isAuthorizedMessage(message, config)) {
    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "unauthorized" };
  }

  if (
    generalMessageLedgerStore
    && isGeneralForumMessage(message, config)
    && !message.is_internal_global_control_dispatch
    && Number.isInteger(message.message_id)
    && message.message_id > 0
  ) {
    await generalMessageLedgerStore.trackMessageId(message.message_id);
  }

  if (zooService) {
    const zooResult = await zooService.maybeHandleIncomingMessage({
      api,
      botUsername,
      message,
    });
    if (zooResult?.handled) {
      if (zooResult.command) {
        markCommandHandled(serviceState, zooResult.command);
      }
      if (zooResult.ackText && !zooResult.suppressAck) {
        await safeSendMessage(
          api,
          buildReplyMessageParams(message, zooResult.ackText),
          null,
          lifecycleManager,
        );
      }
      return zooResult;
    }
  }

  const dispatchGlobalControlCommand = async ({
    actor,
    chat,
    commandText,
  }) =>
    handleIncomingMessage({
      api,
      botUsername,
      config,
      lifecycleManager,
      globalControlPanelStore,
      generalMessageLedgerStore,
      topicControlPanelStore,
      zooService,
      message: buildSyntheticCommandMessage(actor, chat, commandText),
      promptStartGuard,
      promptFragmentAssembler,
      queuePromptAssembler,
      serviceState,
      sessionService,
      workerPool,
    });
  const applyTopicWaitChange = buildApplyTopicWaitChange({
    api,
    botUsername,
    config,
    lifecycleManager,
    promptStartGuard,
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool,
  });

  if (
    !message.is_internal_global_control_dispatch
    && globalControlPanelStore
  ) {
    const globalControlReplyResult = await maybeHandleGlobalControlReply({
      api,
      config,
      dispatchCommand: dispatchGlobalControlCommand,
      globalControlPanelStore,
      message,
      promptFragmentAssembler,
      sessionService,
    });
    if (globalControlReplyResult?.handled) {
      return globalControlReplyResult;
    }
  }

  if (topicControlPanelStore) {
    const topicControlReplyResult = await maybeHandleTopicControlReply({
      api,
      config,
      message,
      promptFragmentAssembler,
      sessionService,
      topicControlPanelStore,
      applyTopicWaitChange,
    });
    if (topicControlReplyResult?.handled) {
      return topicControlReplyResult;
    }
  }

  if (isManualWaitFlushMessage(message, promptFragmentAssembler)) {
    await promptFragmentAssembler.flushPendingForMessage(message);
    return { handled: true, reason: "prompt-buffer-flushed" };
  }

  const command = extractBotCommand(message, botUsername);
  const foreignBotCommand = !command && isForeignBotCommand(message, botUsername);
  if (
    queuePromptAssembler?.hasPendingForSameTopicMessage(message)
    && !message.from?.is_bot
  ) {
    if (command?.name === "q") {
      await queuePromptAssembler.flushPendingForMessage(message);
    } else if (
      !command &&
      !foreignBotCommand &&
      (message.text || message.caption || hasIncomingAttachments(message))
    ) {
      queuePromptAssembler.enqueue({ message });
      return { handled: true, reason: "queue-buffered" };
    } else if (command) {
      queuePromptAssembler.cancelPendingForMessage(message);
    }
  }
  if (
    command &&
    command.name !== "wait" &&
    command.name !== TOPIC_CONTROL_PANEL_COMMAND &&
    command.name !== "auto" &&
    promptFragmentAssembler?.hasPendingForSameTopicMessage(message)
  ) {
    promptFragmentAssembler.cancelPendingForMessage(message, {
      preserveManualWindow: true,
    });
  }
  if (!command) {
    if (message.from?.is_bot) {
      const botSession =
        getTopicIdFromMessage(message) &&
        typeof sessionService.ensureRunnableSessionForMessage === "function"
          ? await sessionService.ensureRunnableSessionForMessage(message)
          : null;
      if (
        !botSession ||
        config.omniEnabled === false ||
        !isAutoModeHumanInputLocked(botSession) ||
        !canAutoModeAcceptPromptFromMessage(botSession, message)
      ) {
        serviceState.ignoredUpdates += 1;
        return { handled: false, reason: "bot-prompt-ignored" };
      }
    }

    if (foreignBotCommand) {
      serviceState.ignoredUpdates += 1;
      return { handled: false, reason: "foreign-bot-command" };
    }

    if (!message.text && !message.caption && !hasIncomingAttachments(message)) {
      serviceState.ignoredUpdates += 1;
      return { handled: false, reason: "not-a-text-message" };
    }

    return handleTopicPrompt({
      api,
      config,
      lifecycleManager,
      message,
      promptStartGuard,
      promptFragmentAssembler,
      serviceState,
      sessionService,
      workerPool,
    });
  }

  const runtimeCommandSpec = getCodexRuntimeCommandSpec(command.name);
  const omniSpecificCommand =
    command.name === "auto"
    || command.name === "omni"
    || runtimeCommandSpec?.target === "omni";
  if (config.omniEnabled === false && omniSpecificCommand) {
    const topicId = getTopicIdFromMessage(message);
    const handledSession = topicId
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const language = handledSession
      ? getSessionUiLanguage(handledSession)
      : await resolveGeneralUiLanguage(globalControlPanelStore);
    await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildOmniUnavailableMessage(language, command.name),
      ),
      handledSession,
      lifecycleManager,
    );
    if (handledSession) {
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
    }
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name, reason: "omni-disabled" };
  }

  if (command.name === "auto" || command.name === "omni") {
    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "omni-owned-command" };
  }

  const parsedQueueCommand =
    command.name === "q"
      ? parseQueueCommandArgs(command.args)
      : null;
  const effectiveQueueCommand =
    parsedQueueCommand?.action === "status" && hasIncomingAttachments(message)
      ? {
          action: "enqueue",
          text: "",
          position: null,
        }
      : parsedQueueCommand;

  const autoCommandLockSession =
    getTopicIdFromMessage(message) &&
    typeof sessionService.ensureRunnableSessionForMessage === "function"
      ? await sessionService.ensureRunnableSessionForMessage(message)
      : null;
  if (
    autoCommandLockSession &&
    config.omniEnabled !== false &&
    isAutoModeHumanInputLocked(autoCommandLockSession) &&
    !canAutoModeAcceptPromptFromMessage(autoCommandLockSession, message) &&
    !AUTO_MODE_ALLOWED_HUMAN_COMMANDS.has(command.name)
  ) {
    if (command.name === "q") {
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildQueueAutoUnavailableMessage(
            getSessionUiLanguage(autoCommandLockSession),
          ),
        ),
        autoCommandLockSession,
        lifecycleManager,
      );
    }
    return { handled: true, reason: "auto-topic-human-command-blocked" };
  }

  if (command.name === "q") {
    const result = await handleQueueCommand({
      api,
      botUsername,
      config,
      lifecycleManager,
      message,
      parsedCommand: effectiveQueueCommand,
      promptStartGuard,
      queuePromptAssembler,
      serviceState,
      sessionService,
      workerPool,
    });
    if (result.handledSession) {
      await sessionService.recordHandledSession(
        serviceState,
        result.handledSession,
        command.name,
      );
    }
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name, reason: result.reason };
  }

  if (command.name === "new") {
    const newTopicArgs = parseNewTopicCommandArgs(command.args);
    const sourceSession = getTopicIdFromMessage(message)
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const sourceLanguage = sourceSession
      ? getSessionUiLanguage(sourceSession)
      : await resolveGeneralUiLanguage(globalControlPanelStore);
    let workspaceBinding;
    let inheritedFromSessionKey = null;

    if (newTopicArgs.bindingPath) {
      try {
        workspaceBinding = await sessionService.resolveBindingPath(
          newTopicArgs.bindingPath,
        );
      } catch (error) {
        await safeSendMessage(
          api,
          buildReplyMessageParams(
            message,
            buildBindingResolutionErrorMessage(
              newTopicArgs.bindingPath,
              error,
              sourceLanguage,
            ),
          ),
          null,
          lifecycleManager,
        );
        markCommandHandled(serviceState, command.name);
        return { handled: true, command: command.name, reason: "binding-error" };
      }
    } else {
      const inherited = await sessionService.resolveInheritedBinding(message);
      workspaceBinding = inherited.binding;
      inheritedFromSessionKey = inherited.inheritedFromSessionKey;
    }

    const { forumTopic, session } = await sessionService.createTopicSession({
      api,
      message,
      title: newTopicArgs.title,
      uiLanguage: sourceLanguage,
      workspaceBinding,
      inheritedFromSessionKey,
    });

    await safeSendMessage(api, {
      chat_id: message.chat.id,
      message_thread_id: forumTopic.message_thread_id,
      text: buildNewTopicBootstrapMessage(session, forumTopic, sourceLanguage),
    }, session, lifecycleManager);
    if (topicControlPanelStore) {
      await ensureTopicControlPanelMessage({
        activeScreen: "root",
        actor: {
          chat: { id: message.chat.id },
          from: message.from,
          message_thread_id: forumTopic.message_thread_id,
        },
        api,
        config,
        promptFragmentAssembler,
        session,
        sessionService,
        topicControlPanelStore,
        pin: true,
      });
    }
    const ack = await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildNewTopicAckMessage(session, forumTopic, sourceLanguage),
      ),
      session,
      lifecycleManager,
    );
    if (ack.parked) {
      await sessionService.recordHandledSession(
        serviceState,
        ack.session || session,
        command.name,
      );
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "topic-unavailable" };
    }

    await sessionService.recordHandledSession(serviceState, session, command.name);
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name };
  }

  const suffixCommand =
    command.name === "suffix"
      ? parsePromptSuffixCommandArgs(command.args)
      : null;
  const waitCommand =
    command.name === "wait"
      ? parseWaitCommandArgs(command.args)
      : null;
  const languageCommand =
    command.name === "language"
      ? parseLanguageCommandArgs(command.args)
      : null;
  const scopedRuntimeSettingCommand = getCodexRuntimeCommandSpec(command.name)
    ? parseScopedRuntimeSettingCommandArgs(command.args)
    : null;
  const topicId = getTopicIdFromMessage(message);
  const generalUiLanguage = !topicId
    ? await resolveGeneralUiLanguage(globalControlPanelStore)
    : DEFAULT_UI_LANGUAGE;
  if (command.name === GLOBAL_CONTROL_PANEL_COMMAND) {
    const result = await handleGlobalControlCommand({
      api,
      config,
      dispatchCommand: dispatchGlobalControlCommand,
      globalControlPanelStore,
      message,
      promptFragmentAssembler,
      sessionService,
    });
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name, reason: result.reason };
  }

  if (command.name === TOPIC_CONTROL_PANEL_COMMAND) {
    const result = await handleTopicControlCommand({
      api,
      config,
      fallbackLanguage: generalUiLanguage,
      message,
      promptFragmentAssembler,
      sessionService,
      topicControlPanelStore,
    });
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name, reason: result.reason };
  }

  if (command.name === "suffix" && suffixCommand?.scope === "help") {
    const handledSession = topicId
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const language = handledSession
      ? getSessionUiLanguage(handledSession)
      : generalUiLanguage;
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildPromptSuffixHelpMessage(language)),
      handledSession,
      lifecycleManager,
    );
    if (delivery.parked) {
      const parkedSession = delivery.session || handledSession;
      if (parkedSession) {
        await sessionService.recordHandledSession(
          serviceState,
          parkedSession,
          command.name,
        );
      }
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "topic-unavailable" };
    }

    if (handledSession) {
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
    }
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name };
  }

  if (command.name === "help") {
    let handledSession = topicId
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const language = handledSession
      ? getSessionUiLanguage(handledSession)
      : await resolveGeneralUiLanguage(globalControlPanelStore);
    const helpCards = getHelpCardAssets(language);

    if (config.omniEnabled === false) {
      const fallbackDelivery = await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildHelpTextMessage(language, { omniEnabled: false }),
        ),
        handledSession,
        lifecycleManager,
      );
      if (fallbackDelivery.parked) {
        handledSession = fallbackDelivery.session || handledSession;
        if (handledSession) {
          await sessionService.recordHandledSession(
            serviceState,
            handledSession,
            command.name,
          );
        }
        markCommandHandled(serviceState, command.name);
        return { handled: true, command: command.name, reason: "topic-unavailable" };
      }
    } else {
      let deliveredPages = 0;
      try {
        for (const helpCard of helpCards) {
          const delivery = await safeSendDocumentToTopic(
            api,
            message,
            {
              filePath: helpCard.filePath,
              fileName: helpCard.fileName,
              contentType: "image/png",
            },
            handledSession,
            lifecycleManager,
          );
          if (delivery.parked) {
            handledSession = delivery.session || handledSession;
            if (handledSession) {
              await sessionService.recordHandledSession(
                serviceState,
                handledSession,
                command.name,
              );
            }
            markCommandHandled(serviceState, command.name);
            return { handled: true, command: command.name, reason: "topic-unavailable" };
          }
          deliveredPages += 1;
        }
      } catch {
        const fallbackDelivery = await safeSendMessage(
          api,
          buildReplyMessageParams(
            message,
            deliveredPages > 0
              ? buildHelpCardPartialFailureMessage(language)
              : buildHelpTextMessage(language, { omniEnabled: true }),
          ),
          handledSession,
          lifecycleManager,
        );
        if (fallbackDelivery.parked) {
          handledSession = fallbackDelivery.session || handledSession;
          if (handledSession) {
            await sessionService.recordHandledSession(
              serviceState,
              handledSession,
              command.name,
            );
          }
          markCommandHandled(serviceState, command.name);
          return { handled: true, command: command.name, reason: "topic-unavailable" };
        }
      }
    }

    if (handledSession) {
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
    }
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name };
  }

  if (command.name === "guide") {
    let handledSession = topicId
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const language = handledSession
      ? getSessionUiLanguage(handledSession)
      : await resolveGeneralUiLanguage(globalControlPanelStore);
    const inGeneralTopic =
      !topicId
      && String(message.chat?.id ?? "") === String(config.telegramForumChatId ?? "");

    if (!inGeneralTopic) {
      const delivery = await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildGuideGeneralOnlyMessage(language),
        ),
        handledSession,
        lifecycleManager,
      );
      if (delivery.parked) {
        handledSession = delivery.session || handledSession;
        if (handledSession) {
          await sessionService.recordHandledSession(
            serviceState,
            handledSession,
            command.name,
          );
        }
        markCommandHandled(serviceState, command.name);
        return { handled: true, command: command.name, reason: "topic-unavailable" };
      }

      if (handledSession) {
        await sessionService.recordHandledSession(
          serviceState,
          handledSession,
          command.name,
        );
      }
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "guide-general-only" };
    }

    try {
      const guidebook = await getGuidebookAsset(language, {
        stateRoot: config.stateRoot,
      });
      const delivery = await safeSendDocumentToTopic(
        api,
        message,
        guidebook,
        handledSession,
        lifecycleManager,
      );
      if (delivery.parked) {
        handledSession = delivery.session || handledSession;
        if (handledSession) {
          await sessionService.recordHandledSession(
            serviceState,
            handledSession,
            command.name,
          );
        }
        markCommandHandled(serviceState, command.name);
        return { handled: true, command: command.name, reason: "topic-unavailable" };
      }
    } catch (error) {
      const fallbackDelivery = await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildGuideGenerationFailureMessage(language, error),
        ),
        handledSession,
        lifecycleManager,
      );
      if (fallbackDelivery.parked) {
        handledSession = fallbackDelivery.session || handledSession;
        if (handledSession) {
          await sessionService.recordHandledSession(
            serviceState,
            handledSession,
            command.name,
          );
        }
        markCommandHandled(serviceState, command.name);
        return { handled: true, command: command.name, reason: "topic-unavailable" };
      }
    }

    if (handledSession) {
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
    }
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name };
  }

  if (command.name === "clear") {
    const inGeneralTopic = isGeneralForumMessage(message, config);
    const language = await resolveGeneralUiLanguage(globalControlPanelStore);

    if (!inGeneralTopic) {
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildClearGeneralOnlyMessage(language),
        ),
        null,
        lifecycleManager,
      );
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "clear-general-only" };
    }

    if (!globalControlPanelStore || !generalMessageLedgerStore) {
      await safeSendMessage(
        api,
        buildReplyMessageParams(message, buildClearFailedMessage(language)),
        null,
        lifecycleManager,
      );
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "clear-unavailable" };
    }

    const existingControlState = await globalControlPanelStore.load({ force: true });

    await handleGlobalControlCommand({
      activeScreen: existingControlState.active_screen,
      api,
      config,
      dispatchCommand: dispatchGlobalControlCommand,
      globalControlPanelStore,
      message,
      promptFragmentAssembler,
      sessionService,
    });
    const controlState = await globalControlPanelStore.load({ force: true });
    const preservedMessageId = controlState.menu_message_id;

    if (!Number.isInteger(preservedMessageId) || preservedMessageId <= 0) {
      await safeSendMessage(
        api,
        buildReplyMessageParams(message, buildClearFailedMessage(language)),
        null,
        lifecycleManager,
      );
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "clear-menu-missing" };
    }

    const cleanupResult = await clearTrackedGeneralMessages({
      api,
      chatId: message.chat.id,
      generalMessageLedgerStore,
      preservedMessageIds: [preservedMessageId],
    });

    if (cleanupResult.failedMessageIds.length > 0) {
      await safeSendMessage(
        api,
        {
          chat_id: message.chat.id,
          text: buildClearFailedMessage(
            language,
            cleanupResult.failedMessageIds.length,
          ),
        },
        null,
        lifecycleManager,
      );
    }

    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name };
  }

  if (command.name === "suffix" && suffixCommand?.scope === "global") {
    let handledSession = topicId
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const language = handledSession
      ? getSessionUiLanguage(handledSession)
      : generalUiLanguage;
    let responseText = null;

    if (suffixCommand.action === "show") {
      responseText = buildPromptSuffixMessage(
        await sessionService.getGlobalPromptSuffix(),
        "Global prompt suffix",
        "global",
        language,
      );
    } else if (suffixCommand.action === "set") {
      const suffixText = normalizePromptSuffixText(suffixCommand.text);
      if (!suffixText) {
        responseText = buildPromptSuffixEmptyMessage("global", language);
      } else if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
        responseText = buildPromptSuffixTooLongMessage(PROMPT_SUFFIX_MAX_CHARS, language);
      } else {
        const updated = await sessionService.updateGlobalPromptSuffix({
          text: suffixText,
          enabled: true,
        });
        responseText = buildPromptSuffixMessage(
          updated,
          "Global prompt suffix updated.",
          "global",
          language,
        );
      }
    } else if (suffixCommand.action === "on") {
      const current = await sessionService.getGlobalPromptSuffix();
      if (!normalizePromptSuffixText(current.prompt_suffix_text)) {
        responseText = buildPromptSuffixEmptyMessage("global", language);
      } else {
        const updated = await sessionService.updateGlobalPromptSuffix({
          enabled: true,
        });
        responseText = buildPromptSuffixMessage(
          updated,
          "Global prompt suffix enabled.",
          "global",
          language,
        );
      }
    } else if (suffixCommand.action === "off") {
      const updated = await sessionService.updateGlobalPromptSuffix({
        enabled: false,
      });
      responseText = buildPromptSuffixMessage(
        updated,
        "Global prompt suffix disabled.",
        "global",
        language,
      );
    } else if (suffixCommand.action === "clear") {
      const updated = await sessionService.clearGlobalPromptSuffix();
      responseText = buildPromptSuffixMessage(
        updated,
        "Global prompt suffix cleared.",
        "global",
        language,
      );
    }

    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, responseText),
      handledSession,
      lifecycleManager,
    );
    if (delivery.parked) {
      handledSession = delivery.session || handledSession;
      if (handledSession) {
        await sessionService.recordHandledSession(
          serviceState,
          handledSession,
          command.name,
        );
      }
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "topic-unavailable" };
    }

    if (handledSession) {
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
    }
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name };
  }

  if (
    scopedRuntimeSettingCommand &&
    scopedRuntimeSettingCommand.scope === "global"
  ) {
    let handledSession = topicId
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const language = handledSession
      ? getSessionUiLanguage(handledSession)
      : generalUiLanguage;
    const result = await handleScopedRuntimeSettingCommand({
      commandName: command.name,
      parsedCommand: scopedRuntimeSettingCommand,
      session: handledSession,
      sessionService,
      config,
      language,
    });
    handledSession = result.handledSession;
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, result.responseText),
      handledSession,
      lifecycleManager,
    );
    if (delivery.parked) {
      handledSession = delivery.session || handledSession;
      if (handledSession) {
        await sessionService.recordHandledSession(
          serviceState,
          handledSession,
          command.name,
        );
      }
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "topic-unavailable" };
    }

    if (handledSession) {
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
    }
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name };
  }

  if (
    command.name === "wait"
    && waitCommand?.scope === "global"
    && !topicId
  ) {
    const language = generalUiLanguage;
    let responseText = null;

    if (!promptFragmentAssembler) {
      responseText = buildWaitUnavailableMessage(language);
    } else if (waitCommand.action === "show") {
      responseText = buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        "Global collection window",
        language,
        "global",
      );
    } else if (waitCommand.action === "off") {
      const canceled = promptFragmentAssembler.cancelPendingForMessage(message, {
        scope: "global",
      });
      responseText = buildWaitDisabledMessage(canceled, "global", language);
    } else if (waitCommand.action === "set") {
      promptFragmentAssembler.openWindow({
        message,
        flushDelayMs: waitCommand.delayMs,
        scope: "global",
        flush: buildBufferedPromptFlush({
          api,
          config,
          lifecycleManager,
          promptStartGuard,
          serviceState,
          sessionService,
          workerPool,
        }),
      });
      responseText = buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        "Global collection window enabled.",
        language,
        "global",
      );
    } else {
      responseText = buildWaitUsageMessage(language);
    }

    await safeSendMessage(
      api,
      buildReplyMessageParams(message, responseText),
      null,
      lifecycleManager,
    );
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name };
  }

  if (!topicId) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildNoSessionTopicMessage(generalUiLanguage)),
      null,
      lifecycleManager,
    );
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name, reason: "general-topic" };
  }

  const session = await sessionService.ensureSessionForMessage(message);
  const language = getSessionUiLanguage(session);

  let responseText = null;
  let handledSession = session;
  let backgroundCompactPromise = null;
  if (command.name === "status") {
    const activeRun = workerPool.getActiveRun(session.session_key);
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
    handledSession = contextState.session;
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
      serviceState,
      "spike",
    );
    const omniRuntimeProfile =
      config.omniEnabled !== false
        ? await resolveStatusRuntimeProfile(
            sessionService,
            handledSession,
            serviceState,
            "omni",
          )
        : null;
    responseText = buildStatusMessage(
      serviceState,
      message,
      handledSession,
      activeRun,
      contextState.snapshot,
      {
        spike: spikeRuntimeProfile,
        ...(config.omniEnabled !== false
          ? { omni: omniRuntimeProfile }
          : {}),
      },
      language,
    );
  } else if (command.name === "interrupt") {
    responseText = buildInterruptMessage(
      message,
      session,
      workerPool.interrupt(session.session_key),
      language,
    );
  } else if (command.name === "language") {
    if (languageCommand.action === "show") {
      responseText = buildLanguageStateMessage(session, language);
    } else if (languageCommand.action === "set") {
      handledSession = await sessionService.updateUiLanguage(session, {
        language: languageCommand.language,
      });
      responseText = buildLanguageUpdatedMessage(handledSession);
    } else {
      responseText = buildLanguageUsageMessage(language);
    }
  } else if (command.name === "wait") {
    if (!promptFragmentAssembler) {
      responseText = buildWaitUnavailableMessage(language);
    } else if (waitCommand.action === "show") {
      const heading =
        waitCommand.scope === "global"
          ? "Global collection window"
          : waitCommand.scope === "topic"
            ? "Local collection window"
            : "Collection windows";
      responseText = buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        heading,
        language,
        waitCommand.scope,
      );
    } else if (waitCommand.action === "off") {
      const canceled = promptFragmentAssembler.cancelPendingForMessage(message, {
        scope: waitCommand.scope,
      });
      responseText = buildWaitDisabledMessage(canceled, waitCommand.scope, language);
    } else if (waitCommand.action === "set") {
      promptFragmentAssembler.openWindow({
        message,
        flushDelayMs: waitCommand.delayMs,
        scope: waitCommand.scope,
        flush: buildBufferedPromptFlush({
          api,
          config,
          lifecycleManager,
          promptStartGuard,
          serviceState,
          sessionService,
          workerPool,
        }),
      });
      const heading =
        waitCommand.scope === "global"
          ? "Global collection window enabled."
          : "Local collection window enabled.";
      responseText = buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        heading,
        language,
        waitCommand.scope,
      );
    } else {
      responseText = buildWaitUsageMessage(language);
    }
  } else if (command.name === "diff") {
    const diffArtifact = await sessionService.createDiffArtifact(session);
    if (diffArtifact.clean) {
      responseText = buildDiffCleanMessage(session, diffArtifact.generatedAt, language);
    } else {
      const sent = await safeSendDocumentToTopic(
        api,
        message,
        {
          filePath: diffArtifact.filePath,
          fileName: diffArtifact.artifact.file_name,
          caption: [
            isEnglish(language) ? "Workspace diff snapshot" : "Workspace diff snapshot",
            `session_key: ${session.session_key}`,
          ].join("\n"),
        },
        handledSession,
        lifecycleManager,
      );
      handledSession = diffArtifact.session;
      if (sent.parked) {
        handledSession = sent.session || handledSession;
        await sessionService.recordHandledSession(
          serviceState,
          handledSession,
          command.name,
        );
        markCommandHandled(serviceState, command.name);
        return { handled: true, command: command.name, reason: "topic-unavailable" };
      }
      if (!sent.delivered) {
        responseText = buildDocumentTooLargeMessage(
          session,
          diffArtifact.filePath,
          sent.sizeBytes,
          language,
        );
      }
    }
  } else if (command.name === "compact") {
    if (session.lifecycle_state === "purged") {
      responseText = buildPurgedSessionMessage(session, language);
    } else if (sessionService.isCompacting?.(session)) {
      responseText = buildCompactAlreadyRunningMessage(session, language);
    } else {
      backgroundCompactPromise = sessionService.compactSession(session);
      responseText = buildCompactStartedMessage(session, language);
    }
  } else if (command.name === "suffix") {
    if (suffixCommand.scope === "topic-control") {
      if (suffixCommand.action === "show") {
        responseText = buildTopicPromptSuffixStateMessage(
          session,
          "Topic prompt suffix routing",
          language,
        );
      } else if (suffixCommand.action === "on") {
        handledSession = await sessionService.updatePromptSuffixTopicState(session, {
          enabled: true,
        });
        responseText = buildTopicPromptSuffixStateMessage(
          handledSession,
          "Topic prompt suffix routing enabled.",
          getSessionUiLanguage(handledSession),
        );
      } else if (suffixCommand.action === "off") {
        handledSession = await sessionService.updatePromptSuffixTopicState(session, {
          enabled: false,
        });
        responseText = buildTopicPromptSuffixStateMessage(
          handledSession,
          "Topic prompt suffix routing disabled.",
          getSessionUiLanguage(handledSession),
        );
      } else {
        responseText = buildTopicPromptSuffixUsageMessage(language);
      }
    } else if (suffixCommand.action === "show") {
      responseText = buildPromptSuffixMessage(
        session,
        isEnglish(language) ? "Prompt suffix" : "Prompt suffix",
        "topic",
        language,
      );
    } else if (suffixCommand.action === "set") {
      const suffixText = normalizePromptSuffixText(suffixCommand.text);
      if (!suffixText) {
        responseText = buildPromptSuffixEmptyMessage("topic", language);
      } else if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
        responseText = buildPromptSuffixTooLongMessage(PROMPT_SUFFIX_MAX_CHARS, language);
      } else {
        handledSession = await sessionService.updatePromptSuffix(session, {
          text: suffixText,
          enabled: true,
        });
        responseText = buildPromptSuffixMessage(
          handledSession,
          "Prompt suffix updated.",
          "topic",
          getSessionUiLanguage(handledSession),
        );
      }
    } else if (suffixCommand.action === "on") {
      if (!normalizePromptSuffixText(session.prompt_suffix_text)) {
        responseText = buildPromptSuffixEmptyMessage("topic", language);
      } else {
        handledSession = await sessionService.updatePromptSuffix(session, {
          enabled: true,
        });
        responseText = buildPromptSuffixMessage(
          handledSession,
          "Prompt suffix enabled.",
          "topic",
          getSessionUiLanguage(handledSession),
        );
      }
    } else if (suffixCommand.action === "off") {
      handledSession = await sessionService.updatePromptSuffix(session, {
        enabled: false,
      });
      responseText = buildPromptSuffixMessage(
        handledSession,
        "Prompt suffix disabled.",
        "topic",
        getSessionUiLanguage(handledSession),
      );
    } else if (suffixCommand.action === "clear") {
      handledSession = await sessionService.clearPromptSuffix(session);
      responseText = buildPromptSuffixMessage(
        handledSession,
        "Prompt suffix cleared.",
        "topic",
        getSessionUiLanguage(handledSession),
      );
    }
  } else if (scopedRuntimeSettingCommand) {
    const result = await handleScopedRuntimeSettingCommand({
      commandName: command.name,
      parsedCommand: scopedRuntimeSettingCommand,
      session,
      sessionService,
      config,
      language,
    });
    handledSession = result.handledSession ?? handledSession;
    responseText = result.responseText;
  } else if (command.name === "purge") {
    if (workerPool.getActiveRun(session.session_key)) {
      responseText = buildPurgeBusyMessage(session, language);
    } else {
      handledSession = await sessionService.purgeSession(session);
      responseText = buildPurgeAckMessage(
        handledSession,
        getSessionUiLanguage(handledSession),
      );
    }
  } else {
    responseText = buildUnknownCommandMessage(language, {
      omniEnabled: config.omniEnabled !== false,
    });
  }

  if (responseText) {
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, responseText),
      handledSession,
      lifecycleManager,
    );
    if (delivery.parked) {
      handledSession = delivery.session || handledSession;
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "topic-unavailable" };
    }
  }
  await sessionService.recordHandledSession(
    serviceState,
    handledSession,
    command.name,
  );
  markCommandHandled(serviceState, command.name);

  if (backgroundCompactPromise) {
    launchCompactionInBackground({
      api,
      lifecycleManager,
      message,
      session,
      compactPromise: backgroundCompactPromise,
    });
  }

  return { handled: true, command: command.name };
}

export async function handleIncomingCallbackQuery({
  api,
  botUsername,
  callbackQuery,
  config,
  lifecycleManager = null,
  globalControlPanelStore = null,
  generalMessageLedgerStore = null,
  topicControlPanelStore = null,
  zooService = null,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  const dispatchGlobalControlCommand = async ({
    actor,
    chat,
    commandText,
  }) =>
    handleIncomingMessage({
      api,
      botUsername,
      config,
      lifecycleManager,
      globalControlPanelStore,
      generalMessageLedgerStore,
      topicControlPanelStore,
      zooService,
      message: buildSyntheticCommandMessage(actor, chat, commandText),
      promptStartGuard,
      promptFragmentAssembler,
      queuePromptAssembler,
      serviceState,
      sessionService,
      workerPool,
    });
  const applyGlobalWaitChange = async ({
    actor,
    chat,
    value,
  }) => {
    if (!promptFragmentAssembler) {
      return { available: false };
    }

    const syntheticMessage = buildSyntheticCommandMessage(
      actor,
      chat,
      value === "off" ? "/wait global off" : `/wait global ${value}`,
    );

    if (value === "off") {
      promptFragmentAssembler.cancelPendingForMessage(syntheticMessage, {
        scope: "global",
      });
      return { available: true };
    }

    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      return { available: false };
    }

    promptFragmentAssembler.openWindow({
      message: syntheticMessage,
      flushDelayMs: seconds * 1000,
      scope: "global",
      flush: buildBufferedPromptFlush({
        api,
        config,
        lifecycleManager,
        promptStartGuard,
        serviceState,
        sessionService,
        workerPool,
      }),
    });
    return { available: true };
  };
  const applyTopicWaitChange = buildApplyTopicWaitChange({
    api,
    config,
    lifecycleManager,
    promptStartGuard,
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool,
  });

  if (zooService) {
    const zooResult = await zooService.handleCallbackQuery({
      api,
      callbackQuery,
    });
    if (zooResult?.handled) {
      return zooResult;
    }
  }

  const topicResult = await handleTopicControlCallbackQuery({
    applyTopicWaitChange,
    api,
    callbackQuery,
    config,
    dispatchCommand: dispatchGlobalControlCommand,
    promptFragmentAssembler,
    sessionService,
    topicControlPanelStore,
  });

  if (topicResult.handled) {
    return topicResult;
  }

  const result = await handleGlobalControlCallbackQuery({
    applyGlobalWaitChange,
    api,
    callbackQuery,
    config,
    dispatchCommand: dispatchGlobalControlCommand,
    globalControlPanelStore,
    promptFragmentAssembler,
    sessionService,
  });

  if (!result.handled) {
    serviceState.ignoredUpdates += 1;
  }

  return result;
}
