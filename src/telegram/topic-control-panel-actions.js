import {
  getSupportedReasoningLevelsForModel,
  loadAvailableCodexModels,
  normalizeModelOverride,
  normalizeReasoningEffort,
  resolveCodexRuntimeProfile,
} from "../session-manager/codex-runtime-settings.js";
import {
  normalizePromptSuffixText,
} from "../session-manager/prompt-suffix.js";
import {
  buildLanguageUpdatedMessage,
  buildInvalidSuffixMessage,
  buildUnavailableModelMessage,
  buildUnsupportedReasoningMessage,
  buildWaitUnavailableMessage,
} from "./topic-control-panel-view.js";

export async function applyTopicControlActionDirect({
  action,
  config,
  language,
  message,
  session,
  sessionService,
  applyTopicWaitChange,
}) {
  if (action.kind === "wait_set") {
    if (typeof applyTopicWaitChange !== "function") {
      return {
        handled: true,
        statusMessage: buildWaitUnavailableMessage(language),
      };
    }

    const applied = await applyTopicWaitChange({
      message,
      value: action.value,
    });
    if (!applied?.available) {
      return {
        handled: true,
        statusMessage: buildWaitUnavailableMessage(language),
      };
    }
    return { handled: true };
  }

  if (action.kind === "suffix_set") {
    if (action.value === "clear") {
      return {
        handled: true,
        session: await sessionService.clearPromptSuffix(session),
      };
    }

    if (action.value === "off") {
      return {
        handled: true,
        session: await sessionService.updatePromptSuffix(session, {
          enabled: false,
        }),
      };
    }

    if (!normalizePromptSuffixText(session?.prompt_suffix_text)) {
      return {
        handled: true,
        statusMessage: buildInvalidSuffixMessage(language),
      };
    }

    return {
      handled: true,
      session: await sessionService.updatePromptSuffix(session, {
        enabled: true,
      }),
    };
  }

  if (action.kind === "suffix_routing_set") {
    return {
      handled: true,
      session: await sessionService.updatePromptSuffixTopicState(session, {
        enabled: action.value === "on",
      }),
    };
  }

  if (action.kind === "model_set") {
    if (action.value === "clear") {
      return {
        handled: true,
        session: await sessionService.clearSessionCodexSetting(
          session,
          action.target,
          "model",
        ),
      };
    }

    const availableModels = await loadAvailableCodexModels({
      configPath: config.codexConfigPath,
    });
    const normalizedModel = normalizeModelOverride(action.value, availableModels);
    if (!normalizedModel) {
      return {
        handled: true,
        statusMessage: buildUnavailableModelMessage(language),
      };
    }

    return {
      handled: true,
      session: await sessionService.updateSessionCodexSetting(
        session,
        action.target,
        "model",
        normalizedModel,
      ),
    };
  }

  if (action.kind === "reasoning_set") {
    if (action.value === "clear") {
      return {
        handled: true,
        session: await sessionService.clearSessionCodexSetting(
          session,
          action.target,
          "reasoning",
        ),
      };
    }

    const normalizedReasoning = normalizeReasoningEffort(action.value);
    const availableModels = await loadAvailableCodexModels({
      configPath: config.codexConfigPath,
    });
    const globalSettings = await sessionService.getGlobalCodexSettings();
    const runtimeProfile = resolveCodexRuntimeProfile({
      session,
      globalSettings,
      config,
      target: action.target,
      availableModels,
    });
    const supportedLevels = getSupportedReasoningLevelsForModel(
      availableModels,
      runtimeProfile.model,
    ).map((entry) => entry.value);

    if (!normalizedReasoning || !supportedLevels.includes(normalizedReasoning)) {
      return {
        handled: true,
        statusMessage: buildUnsupportedReasoningMessage(language),
      };
    }

    return {
      handled: true,
      session: await sessionService.updateSessionCodexSetting(
        session,
        action.target,
        "reasoning",
        normalizedReasoning,
      ),
    };
  }

  if (action.kind === "language_set") {
    const nextSession = await sessionService.updateUiLanguage(session, {
      language: action.value,
    });
    return {
      handled: true,
      session: nextSession,
      statusMessage: buildLanguageUpdatedMessage(nextSession.ui_language),
    };
  }

  return { handled: false };
}

export function getRefreshScreenForAction(action) {
  if (action.kind === "wait_set") {
    return "wait";
  }

  if (action.kind === "suffix_set" || action.kind === "suffix_routing_set") {
    return "suffix";
  }

  if (action.kind === "model_set") {
    return `${action.target}_model`;
  }

  if (action.kind === "reasoning_set") {
    return `${action.target}_reasoning`;
  }

  return "root";
}
