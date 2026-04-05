export const config = {
  telegramAllowedUserId: "1234567890",
  telegramAllowedUserIds: ["1234567890"],
  telegramAllowedBotIds: ["2234567890"],
  telegramForumChatId: "-1001234567890",
  maxParallelSessions: 4,
  codexModel: "gpt-5.4",
  codexReasoningEffort: "medium",
  codexContextWindow: 320000,
  codexAutoCompactTokenLimit: 300000,
  codexConfigPath: "/tmp/codex-telegram-gateway-tests-missing-config.toml",
};

export function buildUnlimitedLimitsSummary(overrides = {}) {
  return {
    available: true,
    capturedAt: "2026-04-04T13:00:00.000Z",
    source: "windows_rtx",
    planType: "business",
    limitName: "codex",
    unlimited: true,
    windows: [],
    primary: null,
    secondary: null,
    ...overrides,
  };
}

export function createGlobalControlPanelStore(initialState = {}) {
  let state = {
    schema_version: 1,
    updated_at: null,
    menu_message_id: null,
    active_screen: "root",
    ui_language: "rus",
    pending_input: null,
    ...initialState,
  };

  return {
    async load() {
      return JSON.parse(JSON.stringify(state));
    },
    async patch(patch) {
      state = {
        ...state,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      return JSON.parse(JSON.stringify(state));
    },
    getState() {
      return JSON.parse(JSON.stringify(state));
    },
  };
}

export function createGlobalControlSessionService(overrides = {}) {
  const globalSuffixState = {
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
  };
  const globalCodexSettings = {
    spike_model: null,
    spike_reasoning_effort: null,
    omni_model: null,
    omni_reasoning_effort: null,
  };

  return {
    async getGlobalCodexSettings() {
      return { ...globalCodexSettings };
    },
    async getGlobalPromptSuffix() {
      return { ...globalSuffixState };
    },
    async updateGlobalPromptSuffix(patch) {
      globalSuffixState.prompt_suffix_text =
        patch.text ?? globalSuffixState.prompt_suffix_text;
      globalSuffixState.prompt_suffix_enabled =
        patch.enabled ?? globalSuffixState.prompt_suffix_enabled;
      return { ...globalSuffixState };
    },
    async clearGlobalPromptSuffix() {
      globalSuffixState.prompt_suffix_text = null;
      globalSuffixState.prompt_suffix_enabled = false;
      return { ...globalSuffixState };
    },
    async getCodexLimitsSummary() {
      return buildUnlimitedLimitsSummary();
    },
    async updateGlobalCodexSetting(target, kind, value) {
      const field =
        kind === "model"
          ? `${target}_model`
          : `${target}_reasoning_effort`;
      globalCodexSettings[field] = value;
      return { ...globalCodexSettings };
    },
    async clearGlobalCodexSetting(target, kind) {
      const field =
        kind === "model"
          ? `${target}_model`
          : `${target}_reasoning_effort`;
      globalCodexSettings[field] = null;
      return { ...globalCodexSettings };
    },
    ...overrides,
  };
}

export function createTopicControlPanelStore(initialState = {}) {
  const states = new Map();

  function getKey(session) {
    return String(session?.session_key ?? `${session?.chat_id}:${session?.topic_id}`);
  }

  function ensureState(session) {
    const key = getKey(session);
    if (!states.has(key)) {
      states.set(key, {
        schema_version: 1,
        updated_at: null,
        menu_message_id: null,
        active_screen: "root",
        pending_input: null,
        ...initialState,
      });
    }
    return states.get(key);
  }

  return {
    async load(session) {
      return JSON.parse(JSON.stringify(ensureState(session)));
    },
    async patch(session, patch) {
      const key = getKey(session);
      const nextState = {
        ...ensureState(session),
        ...patch,
        updated_at: new Date().toISOString(),
      };
      states.set(key, nextState);
      return JSON.parse(JSON.stringify(nextState));
    },
    getState(session) {
      return JSON.parse(JSON.stringify(ensureState(session)));
    },
  };
}

export function buildIdleWorkerPool() {
  return {
    getActiveRun() {
      return null;
    },
    interrupt() {
      return false;
    },
  };
}

export function createServiceState(overrides = {}) {
  return {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
    ...overrides,
  };
}

export function createTopicSession(overrides = {}) {
  return {
    session_key: "-1001234567890:55",
    chat_id: "-1001234567890",
    topic_id: "55",
    topic_name: "Slice 4 test",
    ui_language: "rus",
    prompt_suffix_topic_enabled: true,
    prompt_suffix_text: null,
    prompt_suffix_enabled: false,
    spike_model_override: null,
    spike_reasoning_effort_override: null,
    omni_model_override: null,
    omni_reasoning_effort_override: null,
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
    ...overrides,
  };
}

export function createTopicSessionService(session, overrides = {}) {
  let currentSession = { ...session };

  return {
    async ensureSessionForMessage() {
      return currentSession;
    },
    async getGlobalCodexSettings() {
      return {
        spike_model: null,
        spike_reasoning_effort: null,
        omni_model: null,
        omni_reasoning_effort: null,
      };
    },
    async getGlobalPromptSuffix() {
      return {
        prompt_suffix_enabled: false,
        prompt_suffix_text: null,
      };
    },
    async getCodexLimitsSummary() {
      return buildUnlimitedLimitsSummary();
    },
    async updatePromptSuffix(_session, patch) {
      currentSession = {
        ...currentSession,
        prompt_suffix_text: patch.text ?? currentSession.prompt_suffix_text,
        prompt_suffix_enabled: patch.enabled ?? currentSession.prompt_suffix_enabled,
      };
      return currentSession;
    },
    async clearPromptSuffix() {
      currentSession = {
        ...currentSession,
        prompt_suffix_text: null,
        prompt_suffix_enabled: false,
      };
      return currentSession;
    },
    async updatePromptSuffixTopicState(_session, patch) {
      currentSession = {
        ...currentSession,
        prompt_suffix_topic_enabled: patch.enabled,
      };
      return currentSession;
    },
    async updateSessionCodexSetting(_session, target, kind, value) {
      const field =
        kind === "model"
          ? `${target}_model_override`
          : `${target}_reasoning_effort_override`;
      currentSession = {
        ...currentSession,
        [field]: value,
      };
      return currentSession;
    },
    async clearSessionCodexSetting(_session, target, kind) {
      const field =
        kind === "model"
          ? `${target}_model_override`
          : `${target}_reasoning_effort_override`;
      currentSession = {
        ...currentSession,
        [field]: null,
      };
      return currentSession;
    },
    async updateUiLanguage(_session, patch) {
      currentSession = {
        ...currentSession,
        ui_language: patch.language,
      };
      return currentSession;
    },
    async recordHandledSession() {},
    getCurrentSession() {
      return currentSession;
    },
    ...overrides,
  };
}
