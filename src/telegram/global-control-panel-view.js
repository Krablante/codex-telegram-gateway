import {
  DEFAULT_UI_LANGUAGE,
  normalizeUiLanguage,
} from "../i18n/ui-language.js";
import {
  getSupportedReasoningLevelsForModel,
  loadVisibleCodexModels,
  resolveCodexRuntimeProfile,
} from "../session-manager/codex-runtime-settings.js";
import { buildCodexLimitsMenuLines } from "../codex-runtime/limits.js";
import {
  normalizePromptSuffixText,
  PROMPT_SUFFIX_MAX_CHARS,
} from "../session-manager/prompt-suffix.js";
import {
  buildHostsOverviewMessage,
} from "./command-handlers/host-commands.js";
import {
  buildBotProfileLine,
  buildInlineKeyboardButton,
  buildLanguageKeyboard as buildSharedLanguageKeyboard,
  buildPendingInputLabel as buildSharedPendingInputLabel,
  buildRootSummaryLine,
  buildSuffixPreview,
  buildWaitKeyboard as buildSharedWaitKeyboard,
  chunkIntoRows,
  formatConfiguredValue,
  formatReasoningValue,
  formatWaitDuration,
  getLanguageLabel,
  isEnglish,
  normalizeControlScreenId,
  parseStandardControlCallbackData,
} from "./control-panel-view-common.js";
import {
  buildInvalidCustomWaitMessage as buildSharedInvalidCustomWaitMessage,
  buildInvalidSuffixMessage as buildSharedInvalidSuffixMessage,
  buildLanguageUpdatedMessage as buildSharedLanguageUpdatedMessage,
  buildMenuRefreshMessage as buildSharedMenuRefreshMessage,
  buildOnlyMessage as buildSharedOnlyMessage,
  buildPendingInputCanceledMessage as buildSharedPendingInputCanceledMessage,
  buildPendingInputNeedsTextMessage as buildSharedPendingInputNeedsTextMessage,
  buildPendingInputStartedMessage as buildSharedPendingInputStartedMessage,
  buildTooLongSuffixMessage as buildSharedTooLongSuffixMessage,
  buildUnavailableModelMessage as buildSharedUnavailableModelMessage,
  buildUnsupportedReasoningMessage as buildSharedUnsupportedReasoningMessage,
  buildWaitUnavailableMessage as buildSharedWaitUnavailableMessage,
} from "./control-panel-view-messages.js";

export const GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX = "gcfg";

const SCREEN_CODES = {
  root: "r",
  hosts: "hs",
  new_topic: "nt",
  wait: "w",
  suffix: "s",
  language: "l",
  bot_settings: "b",
  spike_model: "sm",
  spike_reasoning: "sr",
  compact_model: "cm",
  compact_reasoning: "cr",
};
const SCREEN_IDS = Object.fromEntries(
  Object.entries(SCREEN_CODES).map(([screenId, code]) => [code, screenId]),
);
const TARGET_CODES = {
  spike: "s",
  compact: "c",
};
const TARGET_IDS = {
  s: "spike",
  c: "compact",
};

export function getGlobalControlLanguage(controlState = null) {
  return normalizeUiLanguage(controlState?.ui_language);
}

export async function loadGlobalControlLanguage(globalControlPanelStore) {
  if (!globalControlPanelStore) {
    return DEFAULT_UI_LANGUAGE;
  }

  try {
    return getGlobalControlLanguage(await globalControlPanelStore.load({ force: true }));
  } catch {
    return DEFAULT_UI_LANGUAGE;
  }
}

export function normalizeGlobalControlScreenId(value) {
  return normalizeControlScreenId(value, SCREEN_CODES);
}

function buildPendingInputLabel(kind, language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputLabel(kind, language, {
    wait_custom: isEnglish(language)
      ? "custom global wait; send 45s / 2m / off"
      : "custom global wait; отправь 45s / 2m / off",
  });
}

function buildStatusLines({
  language = DEFAULT_UI_LANGUAGE,
  notice = null,
  pendingInput = null,
}) {
  const english = isEnglish(language);
  const lines = [];
  if (pendingInput) {
    lines.push(
      "",
      `${english ? "pending input" : "pending input"}: ${buildPendingInputLabel(pendingInput.kind, language)}`,
    );
    if (pendingInput.status_message) {
      lines.push(`${english ? "status" : "status"}: ${pendingInput.status_message}`);
    }
  } else if (notice) {
    lines.push("", `${english ? "notice" : "notice"}: ${notice}`);
  }
  return lines;
}

function buildHostButtonLabel(hostStatus) {
  return formatExecutionHostButtonLabel(hostStatus.hostLabel, hostStatus.hostId);
}

function formatExecutionHostButtonLabel(hostLabel, hostId) {
  return String(hostLabel || hostId || "unknown").trim() || "unknown";
}

function buildGlobalControlPanelText({
  availableModels,
  globalSettings,
  globalPromptSuffix,
  limitsSummary = null,
  language = DEFAULT_UI_LANGUAGE,
  notice = null,
  pendingInput = null,
  profiles,
  screen = "root",
  topicCreationHosts = [],
  waitState,
}) {
  const english = isEnglish(language);
  const waitSeconds = waitState?.global?.active
    ? Math.round((waitState.global.flushDelayMs ?? 0) / 1000)
    : null;
  const readyHosts = topicCreationHosts.filter((host) => host?.ok);
  const unavailableHosts = topicCreationHosts.filter((host) => !host?.ok);

  if (screen === "hosts") {
    return buildHostsOverviewMessage(topicCreationHosts, language, {
      heading: english ? "Host status" : "Статус хостов",
    });
  }

  if (screen === "new_topic") {
    return [
      buildHostsOverviewMessage(topicCreationHosts, language, {
        heading: english ? "New topic host picker" : "Выбор хоста для нового топика",
        includeCreationHint: true,
      }),
      ...(pendingInput?.kind === "new_topic_title"
        ? [
            "",
            english
              ? `pending host: ${pendingInput.requested_host_label || pendingInput.requested_host_id || "unknown"}`
              : `ожидаемый хост: ${pendingInput.requested_host_label || pendingInput.requested_host_id || "unknown"}`,
          ]
        : []),
      ...buildStatusLines({ language, notice, pendingInput }),
    ].join("\n");
  }

  if (screen === "wait") {
    return [
      "Global wait",
      "",
      `${english ? "current" : "текущее"}: ${formatWaitDuration(waitSeconds, language)}`,
      english
        ? "Tap a preset or choose Custom, then send the next text message."
        : "Выбери preset или нажми Custom, затем отправь следующее текстовое сообщение.",
      english
        ? "This is the same persistent /wait global window across topics."
        : "Это тот же persistent /wait global для всех тем.",
      ...buildStatusLines({ language, notice, pendingInput }),
    ].join("\n");
  }

  if (screen === "suffix") {
    const suffixText = normalizePromptSuffixText(globalPromptSuffix?.prompt_suffix_text);
    return [
      "Global suffix",
      "",
      `status: ${globalPromptSuffix?.prompt_suffix_enabled && suffixText ? "on" : "off"}`,
      `text: ${suffixText ? "set" : "empty"}`,
      "",
      buildSuffixPreview(globalPromptSuffix?.prompt_suffix_text, language),
      ...(pendingInput?.kind === "suffix_text"
        ? [
            "",
            `pending input: ${buildPendingInputLabel(pendingInput.kind, language)}`,
            ...(pendingInput.status_message ? [`status: ${pendingInput.status_message}`] : []),
          ]
        : []),
      ...(pendingInput ? [] : (notice ? ["", `notice: ${notice}`] : [])),
    ].join("\n");
  }

  if (screen === "language") {
    return [
      english ? "Interface language" : "Язык интерфейса",
      "",
      `current: ${getLanguageLabel(language)}`,
      "",
      english ? "Tap RUS or ENG." : "Выбери RUS или ENG.",
    ].join("\n");
  }

  if (screen === "bot_settings") {
    return [
      english ? "Bot settings" : "Настройки ботов",
      "",
      english
        ? "Choose what you want to tune."
        : "Выбери, что хочешь настроить.",
      english
        ? "The /compact profile is used only when the bot rebuilds the brief."
        : "Профиль /compact используется только когда бот пересобирает brief.",
      "",
      buildBotProfileLine("spike", profiles.spike),
      buildBotProfileLine("/compact", profiles.compact),
    ].join("\n");
  }

  if (
    screen === "spike_model"
    || screen === "compact_model"
  ) {
    const target =
      screen === "spike_model"
        ? "spike"
        : "compact";
    const title =
      target === "spike"
        ? "Spike global model"
        : "Compact summarizer model";
    const configuredValue = globalSettings?.[`${target}_model`] ?? null;
    return [
      title,
      "",
      `${english ? "configured" : "настроено"}: ${formatConfiguredValue(configuredValue, language)}`,
      `${english ? "effective" : "effective"}: ${profiles[target].model}`,
      ...(target === "compact"
        ? [
            english
              ? "Used only by the temporary /compact summarizer."
              : "Используется только временным summarizer для /compact.",
          ]
        : []),
      "",
      english ? "Tap a model or clear it." : "Выбери модель кнопкой или сбрось.",
      "",
      `models: ${availableModels.length}`,
    ].join("\n");
  }

  if (
    screen === "spike_reasoning"
    || screen === "compact_reasoning"
  ) {
    const target =
      screen === "spike_reasoning"
        ? "spike"
        : "compact";
    const title =
      target === "spike"
        ? "Spike global reasoning"
        : "Compact summarizer reasoning";
    const configuredValue = globalSettings?.[`${target}_reasoning_effort`] ?? null;
    return [
      title,
      "",
      `${english ? "configured" : "настроено"}: ${formatReasoningValue(configuredValue, language)}`,
      `${english ? "effective" : "effective"}: ${formatReasoningValue(profiles[target].reasoningEffort, language)}`,
      `${english ? "model basis" : "модель-основа"}: ${profiles[target].model}`,
      ...(target === "compact"
        ? [
            english
              ? "Used only by the temporary /compact summarizer."
              : "Используется только временным summarizer для /compact.",
          ]
        : []),
      "",
      english ? "Tap a supported level or clear it." : "Выбери поддерживаемый уровень или сбрось.",
    ].join("\n");
  }

  return [
    "Global control panel",
    "",
    english
      ? "Buttons change stable values; text values are set by sending the next text message."
      : "Кнопки меняют стабильные значения, текстовые значения задаются следующим текстовым сообщением.",
    "",
    `interface language: ${getLanguageLabel(language)}`,
    `topic hosts: ${readyHosts.length} ready / ${topicCreationHosts.length}`,
    ...(unavailableHosts.length > 0
      ? [
          english
            ? `offline hosts: ${unavailableHosts.map((host) => host.hostLabel || host.hostId).join(", ")}`
            : `недоступные хосты: ${unavailableHosts.map((host) => host.hostLabel || host.hostId).join(", ")}`,
        ]
      : []),
    buildRootSummaryLine(
      "wait global",
      waitState?.global?.active ? formatWaitDuration(waitSeconds, language) : null,
      waitState?.global?.active ? formatWaitDuration(waitSeconds, language) : (english ? "off" : "выключен"),
    ),
    buildRootSummaryLine(
      "suffix global",
      globalPromptSuffix?.prompt_suffix_enabled
        ? (normalizePromptSuffixText(globalPromptSuffix.prompt_suffix_text) ? "on" : null)
        : null,
      normalizePromptSuffixText(globalPromptSuffix?.prompt_suffix_text)
        ? (globalPromptSuffix?.prompt_suffix_enabled ? "on" : "set / off")
        : "empty",
    ),
    buildBotProfileLine("spike", profiles.spike),
    ...buildCodexLimitsMenuLines(limitsSummary, language),
    ...(pendingInput
      ? [
          "",
          `pending input: ${buildPendingInputLabel(pendingInput.kind, language)}`,
          ...(pendingInput.status_message ? [`status: ${pendingInput.status_message}`] : []),
        ]
      : []),
    ...(pendingInput ? [] : (notice ? ["", `notice: ${notice}`] : [])),
  ].join("\n");
}

function buildRootKeyboard(pendingInput) {
  return [
    [
      buildInlineKeyboardButton("New Topic", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.new_topic}`),
      buildInlineKeyboardButton("Hosts", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.hosts}`),
    ],
    [
      buildInlineKeyboardButton("Bot Settings", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.bot_settings}`),
      buildInlineKeyboardButton("Language", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.language}`),
    ],
    [
      buildInlineKeyboardButton("Guide", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:g:show`),
      buildInlineKeyboardButton("Help", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:h:show`),
    ],
    [
      buildInlineKeyboardButton("Wait", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.wait}`),
      buildInlineKeyboardButton("Suffix", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.suffix}`),
    ],
    [
      buildInlineKeyboardButton("Zoo", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:z:show`),
      buildInlineKeyboardButton("Clear", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:c:run`),
    ],
    ...(pendingInput
      ? [[buildInlineKeyboardButton("Cancel input", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:p:clear`)]]
      : []),
    [buildInlineKeyboardButton("Refresh", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildHostsKeyboard() {
  return [
    [
      buildInlineKeyboardButton("New Topic", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.new_topic}`),
      buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`),
    ],
    [buildInlineKeyboardButton("Refresh", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.hosts}`)],
  ];
}

function buildNewTopicKeyboard(topicCreationHosts, pendingInput) {
  const readyButtons = chunkIntoRows(
    topicCreationHosts
      .filter((host) => host?.ok)
      .map((host) =>
        buildInlineKeyboardButton(
          buildHostButtonLabel(host),
          `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:nh:${host.hostId}`,
        )
      ),
    2,
  );

  return [
    ...readyButtons,
    ...(pendingInput?.kind === "new_topic_title"
      ? [[buildInlineKeyboardButton("Cancel input", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:p:clear`)]]
      : []),
    [
      buildInlineKeyboardButton("Refresh", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.new_topic}`),
      buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`),
    ],
  ];
}

function buildBotSettingsKeyboard() {
  return [
    [
      buildInlineKeyboardButton("Spike model", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.spike_model}`),
      buildInlineKeyboardButton("Spike reasoning", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.spike_reasoning}`),
    ],
    [
      buildInlineKeyboardButton("/compact model", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.compact_model}`),
      buildInlineKeyboardButton("/compact reasoning", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.compact_reasoning}`),
    ],
    [buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildWaitKeyboard() {
  return buildSharedWaitKeyboard({
    backScreenCode: SCREEN_CODES.root,
    callbackPrefix: GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX,
  });
}

function buildSuffixKeyboard(pendingInput) {
  return [
    [
      buildInlineKeyboardButton("On", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:s:on`),
      buildInlineKeyboardButton("Off", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:s:off`),
    ],
    [
      buildInlineKeyboardButton("Set text", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:s:input`),
      buildInlineKeyboardButton("Clear", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:s:clear`),
    ],
    ...(pendingInput?.kind === "suffix_text"
      ? [[buildInlineKeyboardButton("Cancel input", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:p:clear`)]]
      : []),
    [buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildModelKeyboard(target, availableModels) {
  return [
    ...chunkIntoRows(
      availableModels.map((model) =>
        buildInlineKeyboardButton(
          model.displayName || model.slug,
          `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:m:${TARGET_CODES[target]}:${model.slug}`,
        ),
      ),
      2,
    ),
    [buildInlineKeyboardButton("Clear", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:m:${TARGET_CODES[target]}:clear`)],
    [buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.bot_settings}`)],
  ];
}

function buildReasoningKeyboard(target, availableLevels) {
  return [
    ...chunkIntoRows(
      availableLevels.map((entry) =>
        buildInlineKeyboardButton(
          entry.label,
          `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:r:${TARGET_CODES[target]}:${entry.value}`,
        ),
      ),
      2,
    ),
    [buildInlineKeyboardButton("Clear", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:r:${TARGET_CODES[target]}:clear`)],
    [buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.bot_settings}`)],
  ];
}

function buildLanguageKeyboard() {
  return buildSharedLanguageKeyboard({
    backScreenCode: SCREEN_CODES.root,
    callbackPrefix: GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX,
  });
}

function buildGlobalControlPanelMarkup({
  availableModels,
  runtimeModels = availableModels,
  pendingInput = null,
  profiles,
  screen = "root",
  topicCreationHosts = [],
}) {
  if (screen === "hosts") {
    return { inline_keyboard: buildHostsKeyboard() };
  }

  if (screen === "new_topic") {
    return { inline_keyboard: buildNewTopicKeyboard(topicCreationHosts, pendingInput) };
  }

  if (screen === "wait") {
    return { inline_keyboard: buildWaitKeyboard() };
  }

  if (screen === "suffix") {
    return { inline_keyboard: buildSuffixKeyboard(pendingInput) };
  }

  if (screen === "language") {
    return { inline_keyboard: buildLanguageKeyboard() };
  }

  if (screen === "bot_settings") {
    return { inline_keyboard: buildBotSettingsKeyboard() };
  }

  if (screen === "spike_model") {
    return { inline_keyboard: buildModelKeyboard("spike", availableModels) };
  }

  if (screen === "compact_model") {
    return { inline_keyboard: buildModelKeyboard("compact", availableModels) };
  }

  if (screen === "spike_reasoning") {
    return {
      inline_keyboard: buildReasoningKeyboard(
        "spike",
        getSupportedReasoningLevelsForModel(runtimeModels, profiles.spike.model),
      ),
    };
  }

  if (screen === "compact_reasoning") {
    return {
      inline_keyboard: buildReasoningKeyboard(
        "compact",
        getSupportedReasoningLevelsForModel(runtimeModels, profiles.compact.model),
      ),
    };
  }

  return {
    inline_keyboard: buildRootKeyboard(pendingInput),
  };
}

export async function loadGlobalControlPanelView({
  actor,
  config,
  promptFragmentAssembler,
  sessionService,
  screen = "root",
}) {
  const needsTopicCreationHosts =
    screen === "root"
    || screen === "hosts"
    || screen === "new_topic";
  const needsWaitState = screen === "root" || screen === "wait";
  const needsPromptSuffix = screen === "root" || screen === "suffix";
  const needsRuntimeProfiles =
    screen === "root"
    || screen === "bot_settings"
    || screen === "spike_model"
    || screen === "compact_model"
    || screen === "spike_reasoning"
    || screen === "compact_reasoning";

  let availableModels = [];
  let runtimeModels = [];
  let globalSettings = null;
  let globalPromptSuffix = null;
  let limitsSummary = null;
  let topicCreationHosts = [];
  let spikeProfile = {
    model: null,
    reasoningEffort: null,
  };
  let compactProfile = {
    model: null,
    reasoningEffort: null,
  };

  if (needsRuntimeProfiles) {
    runtimeModels =
      typeof sessionService.loadAvailableCodexModels === "function"
        ? await sessionService.loadAvailableCodexModels()
        : [];
    availableModels =
      typeof sessionService.loadVisibleCodexModels === "function"
        ? await sessionService.loadVisibleCodexModels()
        : await loadVisibleCodexModels({
          configPath: config.codexConfigPath,
        });
    globalSettings = await sessionService.getGlobalCodexSettings();
    spikeProfile = resolveCodexRuntimeProfile({
      session: null,
      globalSettings,
      config,
      target: "spike",
      availableModels: runtimeModels,
    });
    compactProfile = resolveCodexRuntimeProfile({
      session: null,
      globalSettings,
      config,
      target: "compact",
      availableModels: runtimeModels,
    });
  }

  if (needsPromptSuffix) {
    globalPromptSuffix = await sessionService.getGlobalPromptSuffix();
  }

  if (screen === "root" && typeof sessionService.getCodexLimitsSummary === "function") {
    limitsSummary = await sessionService.getCodexLimitsSummary({
      allowStale: true,
    });
  }

  if (needsTopicCreationHosts && typeof sessionService.listTopicCreationHosts === "function") {
    topicCreationHosts = await sessionService.listTopicCreationHosts();
  }

  const waitMessage = {
    chat: {
      id: actor?.chat?.id ?? config.telegramForumChatId,
    },
    from: {
      id: actor?.from?.id,
    },
  };

  return {
    availableModels,
    runtimeModels,
    globalSettings,
    globalPromptSuffix,
    limitsSummary,
    profiles: {
      spike: spikeProfile,
      compact: compactProfile,
    },
    topicCreationHosts,
    waitState:
      needsWaitState
        && typeof promptFragmentAssembler?.getStateForMessage === "function"
        ? promptFragmentAssembler.getStateForMessage(waitMessage)
        : {
            active: false,
            global: {
              active: false,
              flushDelayMs: null,
            },
          },
  };
}

export function buildGlobalControlPanelPayload({
  language = DEFAULT_UI_LANGUAGE,
  notice = null,
  pendingInput = null,
  screen = "root",
  view,
}) {
  return {
    text: buildGlobalControlPanelText({
      availableModels: view.availableModels,
      globalSettings: view.globalSettings,
      globalPromptSuffix: view.globalPromptSuffix,
      limitsSummary: view.limitsSummary,
      language,
      notice,
      pendingInput,
      profiles: view.profiles,
      screen,
      topicCreationHosts: view.topicCreationHosts,
      waitState: view.waitState,
    }),
    reply_markup: buildGlobalControlPanelMarkup({
      availableModels: view.availableModels,
      runtimeModels: view.runtimeModels,
      pendingInput,
      profiles: view.profiles,
      screen,
      topicCreationHosts: view.topicCreationHosts,
    }),
  };
}

export function buildGlobalMenuRefreshMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedMenuRefreshMessage({
    language,
    scopeLabel: "Global",
  });
}

export function buildGeneralOnlyMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedOnlyMessage({
    command: "/global in General",
    description: {
      english: "It controls gateway-wide defaults and keeps one pin-friendly menu message there.",
      russian: "Там живёт одно pin-friendly меню для глобальных настроек всего gateway.",
    },
    language,
  });
}

export function buildGlobalPendingInputStartedMessage(kind, language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputStartedMessage({
    kind,
    language,
    newTopicText: {
      english: "Send the next text message with the new topic title.",
      russian: "Отправь следующее текстовое сообщение названием нового топика.",
    },
    suffixText: {
      english: "Send the next text message with the new global suffix text.",
      russian: "Отправь следующее текстовое сообщение новым текстом для Global suffix.",
    },
    waitText: {
      english: "Send 45s, 2m, 600, or off as the next text message.",
      russian: "Отправь 45s, 2m, 600 или off следующим текстовым сообщением.",
    },
  });
}

export function buildGlobalPendingInputCanceledMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputCanceledMessage(language);
}

export function buildGlobalPendingInputNeedsTextMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputNeedsTextMessage(language);
}

export function buildGlobalInvalidCustomWaitMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedInvalidCustomWaitMessage({
    language,
    scopeLabel: "global",
  });
}

export function buildGlobalWaitUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedWaitUnavailableMessage(language);
}

export function buildGlobalInvalidSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedInvalidSuffixMessage({
    language,
    scopeLabel: "Global",
  });
}

export function buildGlobalTooLongSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedTooLongSuffixMessage({
    language,
    maxChars: PROMPT_SUFFIX_MAX_CHARS,
    scopeLabel: "Global",
  });
}

export function buildGlobalLanguageUpdatedMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedLanguageUpdatedMessage({
    currentLabel: getLanguageLabel(language),
    language,
  });
}

export function buildGlobalUnavailableModelMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedUnavailableModelMessage(language);
}

export function buildGlobalUnsupportedReasoningMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedUnsupportedReasoningMessage(language);
}

export function parseGlobalControlCallbackData(data) {
  return parseStandardControlCallbackData(data, {
    prefix: GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX,
    screenIds: SCREEN_IDS,
    targetIds: TARGET_IDS,
    extraGroups: {
      nh: (rest) => {
        const hostId = String(rest[0] ?? "").trim().toLowerCase();
        if (!hostId) {
          return null;
        }
        return {
          kind: "new_topic_host_select",
          hostId,
        };
      },
      g: (rest) => (rest[0] === "show" ? { kind: "guide_show" } : null),
      z: (rest) => (rest[0] === "show" ? { kind: "zoo_show" } : null),
      c: (rest) => (rest[0] === "run" ? { kind: "clear_run" } : null),
    },
  });
}
