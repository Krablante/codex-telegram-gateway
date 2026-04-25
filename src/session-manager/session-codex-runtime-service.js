import {
  buildEmptyGlobalCodexSettingsState,
  getGlobalRuntimeSettingFieldName,
  getSupportedReasoningLevelsForModel,
  getSessionRuntimeSettingFieldName,
  normalizeReasoningEffort,
  resolveCodexRuntimeProfile,
} from "./codex-runtime-settings.js";
import {
  loadAvailableCodexModelsForSession,
  loadVisibleCodexModelsForSession,
} from "./codex-runtime-host.js";

function buildEmptyCodexLimitsSummary() {
  return {
    available: false,
    capturedAt: null,
    source: null,
    planType: null,
    limitName: null,
    unlimited: false,
    windows: [],
    primary: null,
    secondary: null,
  };
}

async function loadCurrentSession(sessionStore, session) {
  return (await sessionStore.load(session.chat_id, session.topic_id)) || session;
}

export class SessionCodexRuntimeService {
  constructor({
    sessionStore,
    config,
    globalCodexSettingsStore = null,
    codexLimitsService = null,
    hostRegistryService = null,
  }) {
    this.sessionStore = sessionStore;
    this.config = config;
    this.globalCodexSettingsStore = globalCodexSettingsStore;
    this.codexLimitsService = codexLimitsService;
    this.hostRegistryService = hostRegistryService;
  }

  async getGlobalCodexSettings() {
    if (!this.globalCodexSettingsStore) {
      return buildEmptyGlobalCodexSettingsState();
    }

    return this.globalCodexSettingsStore.load({ force: true });
  }

  async loadAvailableCodexModels(session = null) {
    return loadAvailableCodexModelsForSession({
      session,
      defaultConfigPath: this.config.codexConfigPath,
      hostRegistryService: this.hostRegistryService,
    });
  }

  async loadVisibleCodexModels(session = null) {
    return loadVisibleCodexModelsForSession({
      session,
      defaultConfigPath: this.config.codexConfigPath,
      hostRegistryService: this.hostRegistryService,
    });
  }

  async clearIncompatibleGlobalReasoningSetting(target, globalSettings) {
    const reasoningField = getGlobalRuntimeSettingFieldName(target, "reasoning");
    const configuredReasoning = reasoningField
      ? normalizeReasoningEffort(globalSettings?.[reasoningField])
      : null;
    if (!reasoningField || !configuredReasoning || !this.globalCodexSettingsStore) {
      return globalSettings;
    }

    const availableModels = await this.loadAvailableCodexModels();
    const runtimeProfile = resolveCodexRuntimeProfile({
      session: null,
      globalSettings,
      config: this.config,
      target,
      availableModels,
    });
    const supportedLevels = new Set(
      getSupportedReasoningLevelsForModel(
        availableModels,
        runtimeProfile.model,
      ).map((entry) => entry.value),
    );
    if (supportedLevels.has(configuredReasoning)) {
      return globalSettings;
    }

    return this.globalCodexSettingsStore.patch({
      [reasoningField]: null,
    });
  }

  async clearIncompatibleSessionReasoningSetting(session, target) {
    const reasoningField = getSessionRuntimeSettingFieldName(target, "reasoning");
    const configuredReasoning = reasoningField
      ? normalizeReasoningEffort(session?.[reasoningField])
      : null;
    if (!reasoningField || !configuredReasoning) {
      return session;
    }

    const availableModels = await this.loadAvailableCodexModels(session);
    const globalSettings = await this.getGlobalCodexSettings();
    const runtimeProfile = resolveCodexRuntimeProfile({
      session,
      globalSettings,
      config: this.config,
      target,
      availableModels,
    });
    const supportedLevels = new Set(
      getSupportedReasoningLevelsForModel(
        availableModels,
        runtimeProfile.model,
      ).map((entry) => entry.value),
    );
    if (supportedLevels.has(configuredReasoning)) {
      return session;
    }

    return this.sessionStore.patch(session, {
      [reasoningField]: null,
    });
  }

  async updateGlobalCodexSetting(target, kind, value) {
    const fieldName = getGlobalRuntimeSettingFieldName(target, kind);
    if (!fieldName) {
      throw new Error(`Unsupported global Codex setting target=${target} kind=${kind}`);
    }

    if (!this.globalCodexSettingsStore) {
      return {
        ...(await this.getGlobalCodexSettings()),
        [fieldName]: value,
      };
    }

    const nextSettings = await this.globalCodexSettingsStore.patch({
      [fieldName]: value,
    });
    if (kind !== "model") {
      return nextSettings;
    }

    return this.clearIncompatibleGlobalReasoningSetting(target, nextSettings);
  }

  async clearGlobalCodexSetting(target, kind) {
    return this.updateGlobalCodexSetting(target, kind, null);
  }

  async updateSessionCodexSetting(session, target, kind, value) {
    const fieldName = getSessionRuntimeSettingFieldName(target, kind);
    if (!fieldName) {
      throw new Error(`Unsupported session Codex setting target=${target} kind=${kind}`);
    }

    const updatedSession = await this.sessionStore.patch(session, {
      [fieldName]: value,
    });
    if (kind !== "model") {
      return updatedSession;
    }

    return this.clearIncompatibleSessionReasoningSetting(updatedSession, target);
  }

  async clearSessionCodexSetting(session, target, kind) {
    return this.updateSessionCodexSetting(session, target, kind, null);
  }

  async resolveCodexRuntimeProfile(session, { target = "spike" } = {}) {
    const current = await loadCurrentSession(this.sessionStore, session);
    const globalSettings = await this.getGlobalCodexSettings();
    const availableModels = await this.loadAvailableCodexModels(current);
    return resolveCodexRuntimeProfile({
      session: current,
      globalSettings,
      config: this.config,
      target,
      availableModels,
    });
  }

  async getCodexLimitsSummary({ force = false, allowStale = false } = {}) {
    if (!this.codexLimitsService) {
      return buildEmptyCodexLimitsSummary();
    }

    return this.codexLimitsService.getSummary({ force, allowStale });
  }
}
