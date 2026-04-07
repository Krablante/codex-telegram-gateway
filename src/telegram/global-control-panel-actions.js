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
  buildGlobalInvalidSuffixMessage,
  buildGlobalUnavailableModelMessage,
  buildGlobalUnsupportedReasoningMessage,
  buildGlobalWaitUnavailableMessage,
} from "./global-control-panel-view.js";

export function buildDispatchCommandText(action) {
  const commandNameForTarget = (target, kind) => {
    if (target === "spike") {
      return kind === "model" ? "model" : "reasoning";
    }

    if (target === "omni") {
      return kind === "model" ? "omni_model" : "omni_reasoning";
    }

    return null;
  };

  if (action.kind === "wait_set") {
    return `/wait global ${action.value}`;
  }

  if (action.kind === "suffix_set") {
    return `/suffix global ${action.value}`;
  }

  if (action.kind === "model_set") {
    const commandName = commandNameForTarget(action.target, "model");
    return commandName ? `/${commandName} global ${action.value}` : null;
  }

  if (action.kind === "reasoning_set") {
    const commandName = commandNameForTarget(action.target, "reasoning");
    return commandName ? `/${commandName} global ${action.value}` : null;
  }

  return null;
}

export function getRefreshScreenForAction(action) {
  if (action.kind === "wait_set") {
    return "wait";
  }

  if (action.kind === "suffix_set") {
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

export async function applyGlobalControlActionDirect({
  action,
  actor,
  chat,
  config,
  language,
  applyGlobalWaitChange,
  sessionService,
}) {
  if (action.kind === "wait_set") {
    if (typeof applyGlobalWaitChange !== "function") {
      return { handled: false };
    }

    const applied = await applyGlobalWaitChange({
      actor,
      chat,
      value: action.value,
    });
    if (!applied?.available) {
      return {
        handled: true,
        statusMessage: buildGlobalWaitUnavailableMessage(language),
      };
    }
    return { handled: true };
  }

  if (action.kind === "suffix_set") {
    if (typeof sessionService?.getGlobalPromptSuffix !== "function") {
      return { handled: false };
    }

    if (action.value === "clear") {
      await sessionService.clearGlobalPromptSuffix();
      return { handled: true };
    }

    if (action.value === "off") {
      await sessionService.updateGlobalPromptSuffix({ enabled: false });
      return { handled: true };
    }

    const currentSuffix = await sessionService.getGlobalPromptSuffix();
    if (!normalizePromptSuffixText(currentSuffix?.prompt_suffix_text)) {
      return {
        handled: true,
        statusMessage: buildGlobalInvalidSuffixMessage(language),
      };
    }

    await sessionService.updateGlobalPromptSuffix({ enabled: true });
    return { handled: true };
  }

  if (action.kind === "model_set") {
    if (typeof sessionService?.updateGlobalCodexSetting !== "function") {
      return { handled: false };
    }

    if (action.value === "clear") {
      await sessionService.clearGlobalCodexSetting(action.target, "model");
      return { handled: true };
    }

    const availableModels = await loadAvailableCodexModels({
      configPath: config.codexConfigPath,
    });
    const normalizedModel = normalizeModelOverride(action.value, availableModels);
    if (!normalizedModel) {
      return {
        handled: true,
        statusMessage: buildGlobalUnavailableModelMessage(language),
      };
    }

    await sessionService.updateGlobalCodexSetting(action.target, "model", normalizedModel);
    return { handled: true };
  }

  if (action.kind === "reasoning_set") {
    if (typeof sessionService?.updateGlobalCodexSetting !== "function") {
      return { handled: false };
    }

    if (action.value === "clear") {
      await sessionService.clearGlobalCodexSetting(action.target, "reasoning");
      return { handled: true };
    }

    const normalizedReasoning = normalizeReasoningEffort(action.value);
    const availableModels = await loadAvailableCodexModels({
      configPath: config.codexConfigPath,
    });
    const globalSettings = await sessionService.getGlobalCodexSettings();
    const runtimeProfile = resolveCodexRuntimeProfile({
      session: null,
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
        statusMessage: buildGlobalUnsupportedReasoningMessage(language),
      };
    }

    await sessionService.updateGlobalCodexSetting(
      action.target,
      "reasoning",
      normalizedReasoning,
    );
    return { handled: true };
  }

  return { handled: false };
}
