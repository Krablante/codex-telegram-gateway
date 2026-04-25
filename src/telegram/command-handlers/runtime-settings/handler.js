import { DEFAULT_UI_LANGUAGE } from "../../../i18n/ui-language.js";
import {
  getSupportedReasoningLevelsForModel,
  normalizeModelOverride,
  normalizeReasoningEffort,
  resolveCodexRuntimeProfile,
} from "../../../session-manager/codex-runtime-settings.js";
import {
  getCodexRuntimeCommandSpec,
  isEnglish,
  resolveRuntimeCommandState,
} from "./common.js";
import {
  buildCodexSettingListMessage,
  buildCodexSettingStateMessage,
  buildCodexSettingUsageMessage,
  buildInvalidCodexSettingMessage,
  formatCodexModelListEntry,
  formatCodexReasoningListEntry,
} from "./formatters.js";

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
    runtimeModels,
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
          availableModels: runtimeModels,
        }).model
      : effectiveProfile.model;

  const currentTopicValue = topicField ? session?.[topicField] ?? null : null;
  const currentGlobalValue = globalField ? globalSettings?.[globalField] ?? null : null;

  if (parsedCommand.action === "list") {
    const entries =
      spec.kind === "model"
        ? availableModels.map(formatCodexModelListEntry)
        : getSupportedReasoningLevelsForModel(
            runtimeModels,
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
            availableModels: runtimeModels,
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
    let entries;

    if (spec.kind === "model") {
      normalizedValue = normalizeModelOverride(parsedCommand.value, availableModels);
      entries = availableModels.map(formatCodexModelListEntry);
    } else {
      normalizedValue = normalizeReasoningEffort(parsedCommand.value);
      entries = getSupportedReasoningLevelsForModel(
        runtimeModels,
        scopeReasoningModel,
      ).map(formatCodexReasoningListEntry);
      if (
        normalizedValue
        && !getSupportedReasoningLevelsForModel(
          runtimeModels,
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
            availableModels: runtimeModels,
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
