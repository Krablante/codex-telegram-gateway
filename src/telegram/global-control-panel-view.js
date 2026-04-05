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

export const GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX = "gcfg";

const SCREEN_CODES = {
  root: "r",
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

export function getGlobalControlLanguage(controlState = null) {
  return normalizeUiLanguage(controlState?.ui_language);
}

function getLanguageLabel(language = DEFAULT_UI_LANGUAGE) {
  return formatUiLanguageLabel(language);
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

export function normalizeGlobalControlScreenId(value) {
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

function formatConfiguredValue(value, language = DEFAULT_UI_LANGUAGE) {
  return value || (isEnglish(language) ? "default" : "default");
}

function formatReasoningValue(value, language = DEFAULT_UI_LANGUAGE) {
  return formatReasoningEffort(value) || (isEnglish(language) ? "default" : "default");
}

function buildRootSummaryLine(label, configuredValue, effectiveValue) {
  return configuredValue
    ? `${label}: ${configuredValue}`
    : `${label}: default -> ${effectiveValue}`;
}

function formatCompactReasoningValue(value) {
  return value || "default";
}

function buildPendingInputLabel(kind, language = DEFAULT_UI_LANGUAGE) {
  if (kind === "suffix_text") {
    return "suffix text, reply to this menu";
  }

  if (kind === "wait_custom") {
    return "custom global wait, reply with 45s / 2m / off";
  }

  return "manual input pending";
}

function buildSuffixPreview(promptSuffixState, language = DEFAULT_UI_LANGUAGE) {
  const suffixText = normalizePromptSuffixText(promptSuffixState?.prompt_suffix_text);
  if (!suffixText) {
    return isEnglish(language) ? "empty" : "empty";
  }

  return suffixText;
}

function buildBotProfileLine(label, profile, language = DEFAULT_UI_LANGUAGE) {
  return `${label}: ${profile.model} (${formatCompactReasoningValue(profile.reasoningEffort)})`;
}

function buildGlobalControlPanelText({
  availableModels,
  globalSettings,
  globalPromptSuffix,
  limitsSummary = null,
  language = DEFAULT_UI_LANGUAGE,
  omniEnabled = true,
  pendingInput = null,
  profiles,
  screen = "root",
  waitState,
}) {
  const english = isEnglish(language);
  const waitSeconds = waitState?.global?.active
    ? Math.round((waitState.global.flushDelayMs ?? 0) / 1000)
    : null;

  if (screen === "wait") {
    return [
      "Global wait",
      "",
      `${english ? "current" : "текущее"}: ${formatWaitDuration(waitSeconds, language)}`,
      english
        ? "Tap a preset or choose Custom and reply to this menu."
        : "Выбери preset или нажми Custom и ответь на это menu.",
      english
        ? "This is the same persistent /wait global window across topics."
        : "Это тот же persistent /wait global для всех тем.",
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
      buildSuffixPreview(globalPromptSuffix, language),
      ...(pendingInput?.kind === "suffix_text"
        ? [
            "",
            `pending input: ${buildPendingInputLabel(pendingInput.kind, language)}`,
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
        ? "Open the bot you want to tune."
        : "Выбери бота, настройки которого хочешь менять.",
      "",
      buildBotProfileLine("spike", profiles.spike, language),
      ...(omniEnabled
        ? [buildBotProfileLine("omni", profiles.omni, language)]
        : []),
    ].join("\n");
  }

  if (screen === "spike_model" || screen === "omni_model") {
    const target = screen === "spike_model" ? "spike" : "omni";
    const title =
      target === "spike"
        ? "Spike global model"
        : "Omni global model";
    const configuredValue = globalSettings?.[`${target}_model`] ?? null;
    return [
      title,
      "",
      `${english ? "configured" : "настроено"}: ${formatConfiguredValue(configuredValue, language)}`,
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
        ? "Spike global reasoning"
        : "Omni global reasoning";
    const configuredValue = globalSettings?.[`${target}_reasoning_effort`] ?? null;
    return [
      title,
      "",
      `${english ? "configured" : "настроено"}: ${formatReasoningValue(configuredValue, language)}`,
      `${english ? "effective" : "effective"}: ${formatReasoningValue(profiles[target].reasoningEffort, language)}`,
      `${english ? "model basis" : "модель-основа"}: ${profiles[target].model}`,
      "",
      english ? "Tap a supported level or clear it." : "Выбери поддерживаемый уровень или сбрось.",
    ].join("\n");
  }

  return [
    "Global control panel",
    "",
    english
      ? "Buttons change stable values; text values are set by replying to this menu."
      : "Кнопки меняют стабильные значения, текстовые значения задаются ответом на это menu.",
    "",
    `interface language: ${getLanguageLabel(language)}`,
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
    buildBotProfileLine("spike", profiles.spike, language),
    ...(omniEnabled
      ? [
          buildBotProfileLine("omni", profiles.omni, language),
        ]
      : []),
    ...buildCodexLimitsMenuLines(limitsSummary, language),
    ...(pendingInput
      ? [
          "",
          `pending input: ${buildPendingInputLabel(pendingInput.kind, language)}`,
        ]
      : []),
  ].join("\n");
}

function buildRootKeyboard(omniEnabled, pendingInput, language = DEFAULT_UI_LANGUAGE) {
  return [
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

function buildBotSettingsKeyboard(omniEnabled) {
  return [
    [
      buildInlineKeyboardButton("Spike model", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.spike_model}`),
      buildInlineKeyboardButton("Spike reasoning", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.spike_reasoning}`),
    ],
    ...(omniEnabled
      ? [[
          buildInlineKeyboardButton("Omni model", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.omni_model}`),
          buildInlineKeyboardButton("Omni reasoning", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.omni_reasoning}`),
        ]]
      : []),
    [buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildWaitKeyboard(language = DEFAULT_UI_LANGUAGE) {
  return [
    ...chunkIntoRows(
      WAIT_PRESETS.map((entry) =>
        buildInlineKeyboardButton(entry.label, `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:w:${entry.seconds}`),
      ),
      2,
    ),
    [
      buildInlineKeyboardButton("Custom", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:w:input`),
      buildInlineKeyboardButton("Off", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:w:off`),
    ],
    [buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildSuffixKeyboard(pendingInput, language = DEFAULT_UI_LANGUAGE) {
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

function buildModelKeyboard(target, availableModels, language = DEFAULT_UI_LANGUAGE) {
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

function buildReasoningKeyboard(target, availableLevels, language = DEFAULT_UI_LANGUAGE) {
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

function buildLanguageKeyboard(language = DEFAULT_UI_LANGUAGE) {
  return [
    [
      buildInlineKeyboardButton("RUS", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:l:rus`),
      buildInlineKeyboardButton("ENG", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:l:eng`),
    ],
    [buildInlineKeyboardButton("Back", `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildGlobalControlPanelMarkup({
  availableModels,
  language = DEFAULT_UI_LANGUAGE,
  omniEnabled = true,
  pendingInput = null,
  profiles,
  screen = "root",
}) {
  if (screen === "wait") {
    return { inline_keyboard: buildWaitKeyboard(language) };
  }

  if (screen === "suffix") {
    return { inline_keyboard: buildSuffixKeyboard(pendingInput, language) };
  }

  if (screen === "language") {
    return { inline_keyboard: buildLanguageKeyboard(language) };
  }

  if (screen === "bot_settings") {
    return { inline_keyboard: buildBotSettingsKeyboard(omniEnabled) };
  }

  if (screen === "spike_model") {
    return { inline_keyboard: buildModelKeyboard("spike", availableModels, language) };
  }

  if (screen === "omni_model" && omniEnabled) {
    return { inline_keyboard: buildModelKeyboard("omni", availableModels, language) };
  }

  if (screen === "spike_reasoning") {
    return {
      inline_keyboard: buildReasoningKeyboard(
        "spike",
        getSupportedReasoningLevelsForModel(availableModels, profiles.spike.model),
        language,
      ),
    };
  }

  if (screen === "omni_reasoning" && omniEnabled) {
    return {
      inline_keyboard: buildReasoningKeyboard(
        "omni",
        getSupportedReasoningLevelsForModel(availableModels, profiles.omni.model),
        language,
      ),
    };
  }

  return {
    inline_keyboard: buildRootKeyboard(omniEnabled, pendingInput, language),
  };
}

export async function loadGlobalControlPanelView({
  actor,
  config,
  promptFragmentAssembler,
  sessionService,
  screen = "root",
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
  let globalSettings = null;
  let globalPromptSuffix = null;
  let limitsSummary = null;
  let spikeProfile = {
    model: null,
    reasoningEffort: null,
  };
  let omniProfile = {
    model: null,
    reasoningEffort: null,
  };

  if (needsRuntimeProfiles) {
    availableModels = await loadAvailableCodexModels({
      configPath: config.codexConfigPath,
    });
    globalSettings = await sessionService.getGlobalCodexSettings();
    spikeProfile = resolveCodexRuntimeProfile({
      session: null,
      globalSettings,
      config,
      target: "spike",
      availableModels,
    });
    omniProfile = resolveCodexRuntimeProfile({
      session: null,
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
    globalSettings,
    globalPromptSuffix,
    limitsSummary,
    profiles: {
      spike: spikeProfile,
      omni: omniProfile,
    },
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
  omniEnabled = true,
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
      omniEnabled,
      pendingInput,
      profiles: view.profiles,
      screen,
      waitState: view.waitState,
    }),
    reply_markup: buildGlobalControlPanelMarkup({
      availableModels: view.availableModels,
      language,
      omniEnabled,
      pendingInput,
      profiles: view.profiles,
      screen,
    }),
  };
}

export function buildGlobalMenuRefreshMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Global control panel is already current."
    : "Global control panel уже актуален.";
}

export function buildGeneralOnlyMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? [
        "Use /global in General.",
        "",
        "It controls gateway-wide defaults and keeps one pin-friendly menu message there.",
      ].join("\n")
    : [
        "Используй /global в General.",
        "",
        "Там живёт одно pin-friendly меню для глобальных настроек всего gateway.",
      ].join("\n");
}

export function buildGlobalPendingInputStartedMessage(kind, language = DEFAULT_UI_LANGUAGE) {
  if (kind === "suffix_text") {
    return isEnglish(language)
      ? "Reply to the menu with the new global suffix text."
      : "Ответь на menu новым текстом для Global suffix.";
  }

  return isEnglish(language)
    ? "Reply to the menu with 45s, 2m, 600, or off."
    : "Ответь на menu значением 45s, 2m, 600 или off.";
}

export function buildGlobalPendingInputCanceledMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Pending manual input cleared."
    : "Ожидание ручного ввода очищено.";
}

export function buildGlobalPendingInputUnauthorizedMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "This pending input belongs to another operator."
    : "Этот pending input принадлежит другому оператору.";
}

export function buildGlobalPendingInputNeedsTextMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Reply with text to the menu message."
    : "Ответь на сообщение-меню обычным текстом.";
}

export function buildGlobalInvalidCustomWaitMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Invalid custom global wait. Reply with 45s, 2m, 600, or off."
    : "Некорректный Custom global wait. Ответь 45s, 2m, 600 или off.";
}

export function buildGlobalWaitUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Manual collection windows are unavailable right now."
    : "Manual collection window сейчас недоступен.";
}

export function buildGlobalInvalidSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Global suffix text is empty."
    : "Текст Global suffix пустой.";
}

export function buildGlobalTooLongSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return [
    isEnglish(language)
      ? "Global suffix is too long."
      : "Global suffix слишком длинный.",
    "",
    `max_chars: ${PROMPT_SUFFIX_MAX_CHARS}`,
  ].join("\n");
}

export function buildGlobalLanguageUpdatedMessage(language = DEFAULT_UI_LANGUAGE) {
  return [
    isEnglish(language) ? "Interface language updated." : "Язык интерфейса обновлён.",
    "",
    `current: ${getLanguageLabel(language)}`,
  ].join("\n");
}

export function buildGlobalUnavailableModelMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "The selected model is unavailable."
    : "Выбранный model недоступен.";
}

export function buildGlobalUnsupportedReasoningMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "The selected reasoning level is unsupported for the current model."
    : "Выбранный reasoning level не поддерживается текущей model.";
}

export function parseGlobalControlCallbackData(data) {
  const [prefix, group, ...rest] = String(data ?? "").split(":");
  if (prefix !== GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX || !group) {
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

  if (group === "g" && rest[0] === "show") {
    return { kind: "guide_show" };
  }

  if (group === "z" && rest[0] === "show") {
    return { kind: "zoo_show" };
  }

  if (group === "c" && rest[0] === "run") {
    return { kind: "clear_run" };
  }

  return null;
}
