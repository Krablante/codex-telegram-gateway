import {
  DEFAULT_UI_LANGUAGE,
  formatUiLanguageLabel,
  normalizeUiLanguage,
} from "../i18n/ui-language.js";
import {
  formatReasoningEffort,
  getSupportedReasoningLevelsForModel,
  loadAvailableCodexModels,
  resolveCodexRuntimeProfile,
} from "../session-manager/codex-runtime-settings.js";
import { buildCodexLimitsMenuLines } from "../codex-runtime/limits.js";
import {
  normalizePromptSuffixText,
  PROMPT_SUFFIX_MAX_CHARS,
} from "../session-manager/prompt-suffix.js";
import { resolveStatusView } from "./status-view.js";

export const TOPIC_CONTROL_PANEL_CALLBACK_PREFIX = "tcfg";

const SCREEN_CODES = {
  root: "r",
  status: "st",
  wait: "w",
  suffix: "s",
  language: "l",
  bot_settings: "b",
  spike_model: "sm",
  spike_reasoning: "sr",
  omni_model: "om",
  omni_reasoning: "or",
};
const SCREEN_IDS = Object.fromEntries(
  Object.entries(SCREEN_CODES).map(([screenId, code]) => [code, screenId]),
);
const TARGET_CODES = {
  spike: "s",
  omni: "o",
};
const TARGET_IDS = {
  s: "spike",
  o: "omni",
};
const WAIT_PRESETS = [
  { label: "30s", seconds: 30 },
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "10m", seconds: 600 },
  { label: "30m", seconds: 1800 },
];

function isEnglish(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng";
}

function getLanguageLabel(language = DEFAULT_UI_LANGUAGE) {
  return formatUiLanguageLabel(language);
}

function buildInlineKeyboardButton(text, callbackData) {
  return {
    text,
    callback_data: callbackData,
  };
}

function chunkIntoRows(entries, size = 2) {
  const rows = [];
  for (let index = 0; index < entries.length; index += size) {
    rows.push(entries.slice(index, index + size));
  }
  return rows;
}

export function normalizeTopicControlScreenId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SCREEN_CODES[normalized] ? normalized : "root";
}

function formatWaitDuration(seconds, language = DEFAULT_UI_LANGUAGE) {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return isEnglish(language) ? "off" : "выключен";
  }

  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }

  return `${seconds}s`;
}

function formatConfiguredValue(value) {
  return value || "default";
}

function formatReasoningValue(value) {
  return formatReasoningEffort(value) || "default";
}

function buildRootSummaryLine(label, configuredValue, effectiveValue) {
  return configuredValue
    ? `${label}: ${configuredValue}`
    : `${label}: default -> ${effectiveValue}`;
}

function formatCompactReasoningValue(value) {
  return value || "default";
}

function buildPendingInputLabel(kind) {
  if (kind === "suffix_text") {
    return "suffix text, reply to this menu";
  }

  if (kind === "wait_custom") {
    return "custom local wait, reply with 45s / 2m / off";
  }

  return "manual input pending";
}

function buildSuffixPreview(session, language = DEFAULT_UI_LANGUAGE) {
  const suffixText = normalizePromptSuffixText(session?.prompt_suffix_text);
  if (!suffixText) {
    return isEnglish(language) ? "empty" : "empty";
  }

  return suffixText;
}

function buildBotProfileLine(label, profile) {
  return `${label}: ${profile.model} (${formatCompactReasoningValue(profile.reasoningEffort)})`;
}

function buildTopicControlPanelText({
  availableModels,
  globalPromptSuffix,
  limitsSummary = null,
  language = DEFAULT_UI_LANGUAGE,
  omniEnabled = true,
  pendingInput = null,
  profiles,
  screen = "root",
  session,
  statusText = null,
  waitState,
}) {
  const english = isEnglish(language);
  const waitSeconds = waitState?.local?.active
    ? Math.round((waitState.local.flushDelayMs ?? 0) / 1000)
    : null;

  if (screen === "status") {
    return statusText || (english ? "Status is unavailable." : "Статус недоступен.");
  }

  if (screen === "wait") {
    return [
      "Topic wait",
      "",
      `${english ? "current" : "текущее"}: ${formatWaitDuration(waitSeconds, language)}`,
      english
        ? "Tap a preset or choose Custom and reply to this menu."
        : "Выбери preset или нажми Custom и ответь на это menu.",
      english
        ? "This is a one-topic manual collection window."
        : "Это manual collection window только для этого топика.",
    ].join("\n");
  }

  if (screen === "suffix") {
    const suffixText = normalizePromptSuffixText(session?.prompt_suffix_text);
    const globalSuffixText = normalizePromptSuffixText(globalPromptSuffix?.prompt_suffix_text);
    return [
      "Topic suffix",
      "",
      `status: ${session?.prompt_suffix_enabled && suffixText ? "on" : "off"}`,
      `text: ${suffixText ? "set" : "empty"}`,
      `global suffix routing: ${session?.prompt_suffix_topic_enabled !== false ? "on" : "off"}`,
      `global suffix: ${
        globalPromptSuffix?.prompt_suffix_enabled && globalSuffixText ? "on" : "off"
      }`,
      "",
      buildSuffixPreview(session, language),
      ...(pendingInput?.kind === "suffix_text"
        ? [
            "",
            `pending input: ${buildPendingInputLabel(pendingInput.kind)}`,
          ]
        : []),
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
        ? "Open the bot you want to tune for this topic."
        : "Выбери бота, настройки которого хочешь менять в этом топике.",
      "",
      buildBotProfileLine("spike", profiles.spike),
      ...(omniEnabled
        ? [buildBotProfileLine("omni", profiles.omni)]
        : []),
    ].join("\n");
  }

  if (screen === "spike_model" || screen === "omni_model") {
    const target = screen === "spike_model" ? "spike" : "omni";
    const title =
      target === "spike"
        ? "Spike topic model"
        : "Omni topic model";
    const configuredValue = session?.[`${target}_model_override`] ?? null;
    return [
      title,
      "",
      `${english ? "configured" : "настроено"}: ${formatConfiguredValue(configuredValue)}`,
      `${english ? "effective" : "effective"}: ${profiles[target].model}`,
      "",
      english ? "Tap a model or clear it." : "Выбери модель кнопкой или сбрось.",
      "",
      `models: ${availableModels.length}`,
    ].join("\n");
  }

  if (screen === "spike_reasoning" || screen === "omni_reasoning") {
    const target = screen === "spike_reasoning" ? "spike" : "omni";
    const title =
      target === "spike"
        ? "Spike topic reasoning"
        : "Omni topic reasoning";
    const configuredValue = session?.[`${target}_reasoning_effort_override`] ?? null;
    return [
      title,
      "",
      `${english ? "configured" : "настроено"}: ${formatReasoningValue(configuredValue)}`,
      `${english ? "effective" : "effective"}: ${formatReasoningValue(profiles[target].reasoningEffort)}`,
      `${english ? "model basis" : "модель-основа"}: ${profiles[target].model}`,
      "",
      english ? "Tap a supported level or clear it." : "Выбери поддерживаемый уровень или сбрось.",
    ].join("\n");
  }

  return [
    "Topic control panel",
    "",
    english
      ? "Buttons change values for this topic; text values are set by replying to this menu."
      : "Кнопки меняют значения только для этого топика, текстовые значения задаются ответом на это menu.",
    "",
    `interface language: ${getLanguageLabel(language)}`,
    buildRootSummaryLine(
      "wait topic",
      waitState?.local?.active ? formatWaitDuration(waitSeconds, language) : null,
      waitState?.local?.active
        ? formatWaitDuration(waitSeconds, language)
        : (english ? "off" : "выключен"),
    ),
    buildRootSummaryLine(
      "suffix topic",
      session?.prompt_suffix_enabled
        ? (normalizePromptSuffixText(session?.prompt_suffix_text) ? "on" : null)
        : null,
      normalizePromptSuffixText(session?.prompt_suffix_text)
        ? (session?.prompt_suffix_enabled ? "on" : "set / off")
        : "empty",
    ),
    `global suffix routing: ${session?.prompt_suffix_topic_enabled !== false ? "on" : "off"}`,
    buildBotProfileLine("spike", profiles.spike),
    ...(omniEnabled
      ? [
          buildBotProfileLine("omni", profiles.omni),
        ]
      : []),
    ...buildCodexLimitsMenuLines(limitsSummary, language),
    ...(pendingInput
      ? [
          "",
          `pending input: ${buildPendingInputLabel(pendingInput.kind)}`,
        ]
      : []),
  ].join("\n");
}

function buildRootKeyboard(omniEnabled, pendingInput) {
  return [
    [
      buildInlineKeyboardButton("Bot Settings", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.bot_settings}`),
      buildInlineKeyboardButton("Status", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.status}`),
    ],
    [
      buildInlineKeyboardButton("Suffix", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.suffix}`),
      buildInlineKeyboardButton("Wait", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.wait}`),
    ],
    [
      buildInlineKeyboardButton("Purge", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:cmd:purge`),
      buildInlineKeyboardButton("Interrupt", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:cmd:interrupt`),
    ],
    [buildInlineKeyboardButton("Compact", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:cmd:compact`)],
    ...(pendingInput
      ? [[buildInlineKeyboardButton("Cancel pending input", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:p:clear`)]]
      : []),
    [buildInlineKeyboardButton("Refresh", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildBotSettingsKeyboard(omniEnabled) {
  return [
    [
      buildInlineKeyboardButton("Spike model", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.spike_model}`),
      buildInlineKeyboardButton("Spike reasoning", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.spike_reasoning}`),
    ],
    ...(omniEnabled
      ? [[
          buildInlineKeyboardButton("Omni model", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.omni_model}`),
          buildInlineKeyboardButton("Omni reasoning", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.omni_reasoning}`),
        ]]
      : []),
    [buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildStatusKeyboard() {
  return [[
    buildInlineKeyboardButton("Refresh", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.status}`),
    buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`),
  ]];
}

function buildWaitKeyboard() {
  return [
    ...chunkIntoRows(
      WAIT_PRESETS.map((preset) =>
        buildInlineKeyboardButton(
          preset.label,
          `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:w:${preset.seconds}`,
        )),
    ),
    [
      buildInlineKeyboardButton("Custom", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:w:input`),
      buildInlineKeyboardButton("Off", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:w:off`),
    ],
    [buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildSuffixKeyboard(pendingInput) {
  return [
    [
      buildInlineKeyboardButton("Set text", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:s:input`),
      buildInlineKeyboardButton("On", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:s:on`),
    ],
    [
      buildInlineKeyboardButton("Off", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:s:off`),
      buildInlineKeyboardButton("Clear", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:s:clear`),
    ],
    [
      buildInlineKeyboardButton("Global routing on", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:t:on`),
      buildInlineKeyboardButton("Global routing off", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:t:off`),
    ],
    ...(pendingInput?.kind === "suffix_text"
      ? [[buildInlineKeyboardButton("Cancel pending input", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:p:clear`)]]
      : []),
    [buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildModelKeyboard(target, availableModels) {
  return [
    ...chunkIntoRows(
      availableModels.map((model) =>
        buildInlineKeyboardButton(
          model.displayName || model.slug,
          `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:m:${TARGET_CODES[target]}:${model.slug}`,
        )),
    ),
    [
      buildInlineKeyboardButton("Clear", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:m:${TARGET_CODES[target]}:clear`),
      buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.bot_settings}`),
    ],
  ];
}

function buildReasoningKeyboard(target, availableLevels) {
  return [
    ...chunkIntoRows(
      availableLevels.map((entry) =>
        buildInlineKeyboardButton(
          entry.label,
          `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:r:${TARGET_CODES[target]}:${entry.value}`,
        )),
    ),
    [
      buildInlineKeyboardButton("Clear", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:r:${TARGET_CODES[target]}:clear`),
      buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.bot_settings}`),
    ],
  ];
}

function buildLanguageKeyboard() {
  return [
    [
      buildInlineKeyboardButton("RUS", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:l:rus`),
      buildInlineKeyboardButton("ENG", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:l:eng`),
    ],
    [buildInlineKeyboardButton("Back", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildTopicControlPanelMarkup({
  availableModels,
  omniEnabled = true,
  pendingInput = null,
  profiles,
  screen = "root",
}) {
  if (screen === "wait") {
    return { inline_keyboard: buildWaitKeyboard() };
  }

  if (screen === "suffix") {
    return { inline_keyboard: buildSuffixKeyboard(pendingInput) };
  }

  if (screen === "language") {
    return { inline_keyboard: buildLanguageKeyboard() };
  }

  if (screen === "status") {
    return { inline_keyboard: buildStatusKeyboard() };
  }

  if (screen === "bot_settings") {
    return { inline_keyboard: buildBotSettingsKeyboard(omniEnabled) };
  }

  if (screen === "spike_model") {
    return { inline_keyboard: buildModelKeyboard("spike", availableModels) };
  }

  if (screen === "omni_model" && omniEnabled) {
    return { inline_keyboard: buildModelKeyboard("omni", availableModels) };
  }

  if (screen === "spike_reasoning") {
    return {
      inline_keyboard: buildReasoningKeyboard(
        "spike",
        getSupportedReasoningLevelsForModel(availableModels, profiles.spike.model),
      ),
    };
  }

  if (screen === "omni_reasoning" && omniEnabled) {
    return {
      inline_keyboard: buildReasoningKeyboard(
        "omni",
        getSupportedReasoningLevelsForModel(availableModels, profiles.omni.model),
      ),
    };
  }

  return {
    inline_keyboard: buildRootKeyboard(omniEnabled, pendingInput),
  };
}

export async function loadTopicControlPanelView({
  config,
  message,
  promptFragmentAssembler,
  session,
  sessionService,
  screen = "root",
  workerPool = null,
}) {
  const needsWaitState = screen === "root" || screen === "wait";
  const needsPromptSuffix = screen === "root" || screen === "suffix";
  const needsRuntimeProfiles =
    screen === "root"
    || screen === "bot_settings"
    || screen === "spike_model"
    || screen === "omni_model"
    || screen === "spike_reasoning"
    || screen === "omni_reasoning";

  let availableModels = [];
  let globalPromptSuffix = null;
  let globalSettings = null;
  let limitsSummary = null;
  let resolvedSession = session;
  let spikeProfile = {
    model: null,
    reasoningEffort: null,
  };
  let omniProfile = {
    model: null,
    reasoningEffort: null,
  };
  let statusText = null;

  if (screen === "status") {
    const statusView = await resolveStatusView({
      state: config,
      message,
      session,
      sessionService,
      workerPool,
    });
    resolvedSession = statusView.session;
    statusText = statusView.text;
  }

  if (needsRuntimeProfiles) {
    availableModels = await loadAvailableCodexModels({
      configPath: config.codexConfigPath,
    });
    globalSettings = await sessionService.getGlobalCodexSettings();
    spikeProfile = resolveCodexRuntimeProfile({
      session,
      globalSettings,
      config,
      target: "spike",
      availableModels,
    });
    omniProfile = resolveCodexRuntimeProfile({
      session,
      globalSettings,
      config,
      target: "omni",
      availableModels,
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

  return {
    availableModels,
    globalPromptSuffix,
    limitsSummary,
    session: resolvedSession,
    profiles: {
      spike: spikeProfile,
      omni: omniProfile,
    },
    statusText,
    waitState:
      needsWaitState && typeof promptFragmentAssembler?.getStateForMessage === "function"
        ? promptFragmentAssembler.getStateForMessage(message)
        : {
            active: false,
            local: {
              active: false,
              flushDelayMs: null,
            },
          },
  };
}

export function buildTopicControlPanelPayload({
  language = DEFAULT_UI_LANGUAGE,
  omniEnabled = true,
  pendingInput = null,
  screen = "root",
  session,
  view,
}) {
  return {
    text: buildTopicControlPanelText({
      availableModels: view.availableModels,
      globalPromptSuffix: view.globalPromptSuffix,
      limitsSummary: view.limitsSummary,
      language,
      omniEnabled,
      pendingInput,
      profiles: view.profiles,
      screen,
      session,
      statusText: view.statusText,
      waitState: view.waitState,
    }),
    reply_markup: buildTopicControlPanelMarkup({
      availableModels: view.availableModels,
      omniEnabled,
      pendingInput,
      profiles: view.profiles,
      screen,
    }),
  };
}

export function buildTopicOnlyMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? [
        "Use /menu inside a topic.",
        "",
        "This menu changes settings only for the current topic.",
      ].join("\n")
    : [
        "Используй /menu внутри топика.",
        "",
        "Это menu меняет настройки только текущего топика.",
      ].join("\n");
}

export function buildPendingInputStartedMessage(kind, language = DEFAULT_UI_LANGUAGE) {
  if (kind === "suffix_text") {
    return isEnglish(language)
      ? "Reply to the menu with the new topic suffix text."
      : "Ответь на menu новым текстом topic suffix.";
  }

  return isEnglish(language)
    ? "Reply to the menu with 45s, 2m, 600, or off."
    : "Ответь на menu значением 45s, 2m, 600 или off.";
}

export function buildPendingInputCanceledMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Pending manual input cleared."
    : "Ожидание ручного ввода очищено.";
}

export function buildPendingInputUnauthorizedMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "This pending input belongs to another operator."
    : "Этот pending input принадлежит другому оператору.";
}

export function buildPendingInputNeedsTextMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Reply with text to the menu message."
    : "Ответь на сообщение-меню обычным текстом.";
}

export function buildInvalidCustomWaitMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Invalid custom topic wait. Reply with 45s, 2m, 600, or off."
    : "Некорректный Custom topic wait. Ответь 45s, 2m, 600 или off.";
}

export function buildInvalidSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Topic suffix text is empty."
    : "Текст topic suffix пустой.";
}

export function buildTooLongSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return [
    isEnglish(language)
      ? "Topic suffix is too long."
      : "Topic suffix слишком длинный.",
    "",
    `max_chars: ${PROMPT_SUFFIX_MAX_CHARS}`,
  ].join("\n");
}

export function buildLanguageUpdatedMessage(language = DEFAULT_UI_LANGUAGE) {
  return [
    isEnglish(language) ? "Interface language updated." : "Язык интерфейса обновлён.",
    "",
    `current: ${getLanguageLabel(language)}`,
  ].join("\n");
}

export function buildWaitUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Manual collection windows are unavailable right now."
    : "Manual collection window сейчас недоступен.";
}

export function buildMenuRefreshMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Topic control panel is already current."
    : "Topic control panel уже актуален.";
}

export function buildUnavailableModelMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "The selected model is unavailable."
    : "Выбранный model недоступен.";
}

export function buildUnsupportedReasoningMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "The selected reasoning level is unsupported for the current model."
    : "Выбранный reasoning level не поддерживается текущей model.";
}

export function parseTopicControlCallbackData(data) {
  const [prefix, group, ...rest] = String(data ?? "").split(":");
  if (prefix !== TOPIC_CONTROL_PANEL_CALLBACK_PREFIX || !group) {
    return null;
  }

  if (group === "n") {
    return {
      kind: "navigate",
      screen: SCREEN_IDS[rest[0]] ?? "root",
    };
  }

  if (group === "w") {
    const value = rest[0] ?? "";
    if (value === "input") {
      return { kind: "wait_input" };
    }
    if (value === "off") {
      return { kind: "wait_set", value: "off" };
    }
    const seconds = Number(value);
    if (Number.isInteger(seconds) && seconds > 0) {
      return { kind: "wait_set", value: String(seconds) };
    }
    return null;
  }

  if (group === "s") {
    const value = rest[0] ?? "";
    if (["on", "off", "clear"].includes(value)) {
      return { kind: "suffix_set", value };
    }
    if (value === "input") {
      return { kind: "suffix_input" };
    }
    return null;
  }

  if (group === "t") {
    const value = rest[0] ?? "";
    if (!["on", "off"].includes(value)) {
      return null;
    }
    return { kind: "suffix_routing_set", value };
  }

  if (group === "l") {
    const value = String(rest[0] ?? "").trim().toLowerCase();
    if (!["rus", "eng"].includes(value)) {
      return null;
    }
    return {
      kind: "language_set",
      value,
    };
  }

  if (group === "m") {
    const target = TARGET_IDS[rest[0]];
    const value = rest[1] ?? null;
    if (!target || !value) {
      return null;
    }
    return {
      kind: "model_set",
      target,
      value,
    };
  }

  if (group === "r") {
    const target = TARGET_IDS[rest[0]];
    const value = rest[1] ?? null;
    if (!target || !value) {
      return null;
    }
    return {
      kind: "reasoning_set",
      target,
      value,
    };
  }

  if (group === "p" && rest[0] === "clear") {
    return { kind: "pending_clear" };
  }

  if (group === "h" && rest[0] === "show") {
    return { kind: "help_show" };
  }

  if (group === "cmd") {
    const command = String(rest[0] ?? "").trim().toLowerCase();
    if (!["compact", "purge", "interrupt"].includes(command)) {
      return null;
    }
    return {
      kind: "command_dispatch",
      command,
    };
  }

  return null;
}
