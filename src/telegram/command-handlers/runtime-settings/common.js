import {
  normalizeUiLanguage,
} from "../../../i18n/ui-language.js";
import {
  getGlobalRuntimeSettingFieldName,
  getSessionRuntimeSettingFieldName,
  loadVisibleCodexModels,
  resolveCodexRuntimeProfile,
} from "../../../session-manager/codex-runtime-settings.js";

export function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
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
};

export function getCodexRuntimeCommandSpec(commandName) {
  return CODEX_RUNTIME_COMMANDS[commandName] ?? null;
}

export async function resolveRuntimeCommandState({
  spec,
  session = null,
  sessionService,
  config,
}) {
  const availableModels =
    typeof sessionService.loadVisibleCodexModels === "function"
      ? await sessionService.loadVisibleCodexModels(session)
      : await loadVisibleCodexModels({
        configPath: config.codexConfigPath,
      });
  const runtimeModels =
    typeof sessionService.loadAvailableCodexModels === "function"
      ? await sessionService.loadAvailableCodexModels(session)
      : availableModels;
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
        availableModels: runtimeModels,
      });

  return {
    availableModels,
    runtimeModels,
    globalSettings,
    topicField,
    globalField,
    effectiveProfile,
  };
}
