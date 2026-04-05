import {
  DEFAULT_UI_LANGUAGE,
  normalizeUiLanguage,
} from "../../i18n/ui-language.js";
import {
  formatReasoningEffort,
  getGlobalRuntimeSettingFieldName,
  getSessionRuntimeSettingFieldName,
  getSupportedReasoningLevelsForModel,
  loadAvailableCodexModels,
  normalizeModelOverride,
  normalizeReasoningEffort,
  resolveCodexRuntimeProfile,
} from "../../session-manager/codex-runtime-settings.js";

function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
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

export function getCodexRuntimeCommandSpec(commandName) {
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
  };
}

export async function handleScopedRuntimeSettingCommand({
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
      responseText: buildCodexSettingUsageMessage(commandName, language),
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
