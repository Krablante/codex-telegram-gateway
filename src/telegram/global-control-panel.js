import {
  DEFAULT_UI_LANGUAGE,
  formatUiLanguageLabel,
  normalizeUiLanguage,
} from "../i18n/ui-language.js";
import {
  formatReasoningEffort,
  getSupportedReasoningLevelsForModel,
  loadAvailableCodexModels,
  normalizeModelOverride,
  normalizeReasoningEffort,
  resolveCodexRuntimeProfile,
} from "../session-manager/codex-runtime-settings.js";
import {
  normalizePromptSuffixText,
  PROMPT_SUFFIX_MAX_CHARS,
} from "../session-manager/prompt-suffix.js";
import { isAuthorizedMessage, parseWaitCommandArgs } from "./command-parsing.js";

export const GLOBAL_CONTROL_PANEL_COMMAND = "global";

const CALLBACK_PREFIX = "gcfg";
const SCREEN_CODES = {
  root: "r",
  wait: "w",
  suffix: "s",
  language: "l",
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
const GLOBAL_CONTROL_OPERATION_CHAINS = new Map();

function isEnglish(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng";
}

function getControlLanguage(controlState = null) {
  return normalizeUiLanguage(controlState?.ui_language);
}

function getLanguageLabel(language = DEFAULT_UI_LANGUAGE) {
  return formatUiLanguageLabel(language);
}

async function loadControlLanguage(globalControlPanelStore) {
  if (!globalControlPanelStore) {
    return DEFAULT_UI_LANGUAGE;
  }

  try {
    return getControlLanguage(await globalControlPanelStore.load({ force: true }));
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

function normalizeScreenId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SCREEN_CODES[normalized] ? normalized : "root";
}

function isGeneralForumMessage(message, config) {
  return (
    message
    && String(message.chat?.id ?? "") === String(config.telegramForumChatId ?? "")
    && message.message_thread_id === undefined
    && message.message_thread_id !== 0
  );
}

function buildAuthMessageForCallbackQuery(callbackQuery) {
  return {
    from: callbackQuery?.from ?? null,
    chat: callbackQuery?.message?.chat ?? null,
    message_thread_id: callbackQuery?.message?.message_thread_id,
  };
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

function buildGlobalControlPanelText({
  availableModels,
  globalSettings,
  globalPromptSuffix,
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
    buildRootSummaryLine(
      "spike model",
      globalSettings?.spike_model ?? null,
      profiles.spike.model,
    ),
    buildRootSummaryLine(
      "spike reasoning",
      globalSettings?.spike_reasoning_effort
        ? formatReasoningEffort(globalSettings.spike_reasoning_effort)
        : null,
      formatReasoningEffort(profiles.spike.reasoningEffort) || profiles.spike.reasoningEffort,
    ),
    ...(omniEnabled
      ? [
          buildRootSummaryLine(
            "omni model",
            globalSettings?.omni_model ?? null,
            profiles.omni.model,
          ),
          buildRootSummaryLine(
            "omni reasoning",
            globalSettings?.omni_reasoning_effort
              ? formatReasoningEffort(globalSettings.omni_reasoning_effort)
              : null,
            formatReasoningEffort(profiles.omni.reasoningEffort) || profiles.omni.reasoningEffort,
          ),
        ]
      : []),
    ...(pendingInput
      ? [
          "",
          `pending input: ${buildPendingInputLabel(pendingInput.kind, language)}`,
        ]
      : []),
  ].join("\n");
}

function buildRootKeyboard(omniEnabled, pendingInput, language = DEFAULT_UI_LANGUAGE) {
  const english = isEnglish(language);
  return [
    [
      buildInlineKeyboardButton("Wait", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.wait}`),
      buildInlineKeyboardButton("Suffix", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.suffix}`),
    ],
    [
      buildInlineKeyboardButton(
        "Spike model",
        `${CALLBACK_PREFIX}:n:${SCREEN_CODES.spike_model}`,
      ),
      buildInlineKeyboardButton(
        "Spike reasoning",
        `${CALLBACK_PREFIX}:n:${SCREEN_CODES.spike_reasoning}`,
      ),
    ],
    ...(omniEnabled
      ? [
          [
            buildInlineKeyboardButton(
              "Omni model",
              `${CALLBACK_PREFIX}:n:${SCREEN_CODES.omni_model}`,
            ),
            buildInlineKeyboardButton(
              "Omni reasoning",
              `${CALLBACK_PREFIX}:n:${SCREEN_CODES.omni_reasoning}`,
            ),
          ],
        ]
      : []),
    [
      buildInlineKeyboardButton(
        "Language",
        `${CALLBACK_PREFIX}:n:${SCREEN_CODES.language}`,
      ),
      buildInlineKeyboardButton(
        "Help",
        `${CALLBACK_PREFIX}:h:show`,
      ),
    ],
    ...(pendingInput
      ? [[buildInlineKeyboardButton(
        "Cancel input",
        `${CALLBACK_PREFIX}:p:clear`,
      )]]
      : []),
    [buildInlineKeyboardButton("Refresh", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildWaitKeyboard(language = DEFAULT_UI_LANGUAGE) {
  const english = isEnglish(language);
  return [
    ...chunkIntoRows(
      WAIT_PRESETS.map((entry) =>
        buildInlineKeyboardButton(entry.label, `${CALLBACK_PREFIX}:w:${entry.seconds}`),
      ),
      2,
    ),
    [
      buildInlineKeyboardButton("Custom", `${CALLBACK_PREFIX}:w:input`),
      buildInlineKeyboardButton("Off", `${CALLBACK_PREFIX}:w:off`),
    ],
    [buildInlineKeyboardButton("Back", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildSuffixKeyboard(pendingInput, language = DEFAULT_UI_LANGUAGE) {
  const english = isEnglish(language);
  return [
    [
      buildInlineKeyboardButton("On", `${CALLBACK_PREFIX}:s:on`),
      buildInlineKeyboardButton("Off", `${CALLBACK_PREFIX}:s:off`),
    ],
    [
      buildInlineKeyboardButton("Set text", `${CALLBACK_PREFIX}:s:input`),
      buildInlineKeyboardButton("Clear", `${CALLBACK_PREFIX}:s:clear`),
    ],
    ...(pendingInput?.kind === "suffix_text"
      ? [[buildInlineKeyboardButton(
        "Cancel input",
        `${CALLBACK_PREFIX}:p:clear`,
      )]]
      : []),
    [buildInlineKeyboardButton("Back", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildModelKeyboard(target, availableModels, language = DEFAULT_UI_LANGUAGE) {
  const english = isEnglish(language);
  return [
    ...chunkIntoRows(
      availableModels.map((model) =>
        buildInlineKeyboardButton(
          model.displayName || model.slug,
          `${CALLBACK_PREFIX}:m:${TARGET_CODES[target]}:${model.slug}`,
        ),
      ),
      2,
    ),
    [
      buildInlineKeyboardButton("Clear", `${CALLBACK_PREFIX}:m:${TARGET_CODES[target]}:clear`),
    ],
    [buildInlineKeyboardButton("Back", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildReasoningKeyboard(target, availableLevels, language = DEFAULT_UI_LANGUAGE) {
  const english = isEnglish(language);
  return [
    ...chunkIntoRows(
      availableLevels.map((entry) =>
        buildInlineKeyboardButton(
          entry.label,
          `${CALLBACK_PREFIX}:r:${TARGET_CODES[target]}:${entry.value}`,
        ),
      ),
      2,
    ),
    [
      buildInlineKeyboardButton("Clear", `${CALLBACK_PREFIX}:r:${TARGET_CODES[target]}:clear`),
    ],
    [buildInlineKeyboardButton("Back", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildLanguageKeyboard(language = DEFAULT_UI_LANGUAGE) {
  const english = isEnglish(language);
  return [
    [
      buildInlineKeyboardButton("RUS", `${CALLBACK_PREFIX}:l:rus`),
      buildInlineKeyboardButton("ENG", `${CALLBACK_PREFIX}:l:eng`),
    ],
    [buildInlineKeyboardButton("Back", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
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

async function loadGlobalControlPanelView({
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
    || screen === "spike_model"
    || screen === "omni_model"
    || screen === "spike_reasoning"
    || screen === "omni_reasoning";

  let availableModels = [];
  let globalSettings = null;
  let globalPromptSuffix = null;
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

function buildGlobalControlPanelPayload({
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

function buildMenuRefreshMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Global control panel is already current."
    : "Global control panel уже актуален.";
}

function buildGeneralOnlyMessage(language = DEFAULT_UI_LANGUAGE) {
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

function buildPendingInputStartedMessage(kind, language = DEFAULT_UI_LANGUAGE) {
  if (kind === "suffix_text") {
    return isEnglish(language)
      ? "Reply to the menu with the new global suffix text."
      : "Ответь на menu новым текстом для Global suffix.";
  }

  return isEnglish(language)
    ? "Reply to the menu with 45s, 2m, 600, or off."
    : "Ответь на menu значением 45s, 2m, 600 или off.";
}

function buildPendingInputCanceledMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Pending manual input cleared."
    : "Ожидание ручного ввода очищено.";
}

function buildPendingInputUnauthorizedMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "This pending input belongs to another operator."
    : "Этот pending input принадлежит другому оператору.";
}

function buildPendingInputNeedsTextMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Reply with text to the menu message."
    : "Ответь на сообщение-меню обычным текстом.";
}

function buildInvalidCustomWaitMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Invalid custom global wait. Reply with 45s, 2m, 600, or off."
    : "Некорректный Custom global wait. Ответь 45s, 2m, 600 или off.";
}

function buildInvalidSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Global suffix text is empty."
    : "Текст Global suffix пустой.";
}

function buildTooLongSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return [
    isEnglish(language)
      ? "Global suffix is too long."
      : "Global suffix слишком длинный.",
    "",
    `max_chars: ${PROMPT_SUFFIX_MAX_CHARS}`,
  ].join("\n");
}

function buildLanguageUpdatedMessage(language = DEFAULT_UI_LANGUAGE) {
  return [
    isEnglish(language) ? "Interface language updated." : "Язык интерфейса обновлён.",
    "",
    `current: ${getLanguageLabel(language)}`,
  ].join("\n");
}

function parseCallbackData(data) {
  const [prefix, group, ...rest] = String(data ?? "").split(":");
  if (prefix !== CALLBACK_PREFIX || !group) {
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

  return null;
}

function isRecoverableEditError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("message to edit not found")
    || message.includes("message can't be edited")
  );
}

function isNotModifiedError(error) {
  return String(error?.message ?? "").toLowerCase().includes("message is not modified");
}

async function sendStatusMessage(api, chatId, text) {
  await api.sendMessage({
    chat_id: chatId,
    text,
  });
}

async function answerCallbackQuerySafe(api, callbackQueryId, text = undefined) {
  if (!callbackQueryId) {
    return;
  }

  try {
    await api.answerCallbackQuery(
      text
        ? {
            callback_query_id: callbackQueryId,
            text,
          }
        : {
            callback_query_id: callbackQueryId,
          },
    );
  } catch {}
}

async function runSerializedGlobalControlOperation(key, operation) {
  const previous = GLOBAL_CONTROL_OPERATION_CHAINS.get(key) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(operation);

  GLOBAL_CONTROL_OPERATION_CHAINS.set(key, current);

  try {
    return await current;
  } finally {
    if (GLOBAL_CONTROL_OPERATION_CHAINS.get(key) === current) {
      GLOBAL_CONTROL_OPERATION_CHAINS.delete(key);
    }
  }
}

function syncPendingInputMessageId(pendingInput, menuMessageId) {
  if (!pendingInput) {
    return null;
  }

  return {
    ...pendingInput,
    menu_message_id: menuMessageId,
  };
}

async function ensureGlobalControlPanelMessage({
  activeScreen = "root",
  actor,
  api,
  config,
  controlState = null,
  forceStatusMessage = false,
  globalControlPanelStore,
  preferredMessageId = null,
  promptFragmentAssembler,
  sessionService,
}) {
  const resolvedControlState =
    controlState ?? await globalControlPanelStore.load({ force: true });
  const screen = normalizeScreenId(activeScreen ?? resolvedControlState.active_screen);
  const language = getControlLanguage(resolvedControlState);
  const view = await loadGlobalControlPanelView({
    actor,
    config,
    promptFragmentAssembler,
    sessionService,
    screen,
  });
  const payload = buildGlobalControlPanelPayload({
    language,
    omniEnabled: config.omniEnabled !== false,
    pendingInput: resolvedControlState.pending_input,
    screen,
    view,
  });
  const chatId = actor?.chat?.id ?? config.telegramForumChatId;
  const messageId = preferredMessageId ?? resolvedControlState.menu_message_id;

  if (messageId) {
    try {
      await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: payload.text,
        reply_markup: payload.reply_markup,
      });
      await globalControlPanelStore.patch({
        menu_message_id: messageId,
        active_screen: screen,
        pending_input: syncPendingInputMessageId(
          resolvedControlState.pending_input,
          messageId,
        ),
      });
      return {
        created: false,
        messageId,
      };
    } catch (error) {
      if (isNotModifiedError(error)) {
        await globalControlPanelStore.patch({
          menu_message_id: messageId,
          active_screen: screen,
          pending_input: syncPendingInputMessageId(
            resolvedControlState.pending_input,
            messageId,
          ),
        });
        if (forceStatusMessage) {
          await sendStatusMessage(api, chatId, buildMenuRefreshMessage(language));
        }
        return {
          created: false,
          messageId,
          unchanged: true,
        };
      }

      if (!isRecoverableEditError(error)) {
        throw error;
      }
    }
  }

  const sent = await api.sendMessage({
    chat_id: chatId,
    text: payload.text,
    reply_markup: payload.reply_markup,
  });
  const nextMessageId =
    Number.isInteger(sent?.message_id) && sent.message_id > 0
      ? sent.message_id
      : null;
  const resolvedMessageId = nextMessageId ?? messageId;
  await globalControlPanelStore.patch({
    menu_message_id: resolvedMessageId,
    active_screen: screen,
    pending_input: syncPendingInputMessageId(
      resolvedControlState.pending_input,
      resolvedMessageId,
    ),
  });
  return {
    created: true,
    messageId: resolvedMessageId,
  };
}

function buildDispatchCommandText(action) {
  if (action.kind === "wait_set") {
    return `/wait global ${action.value}`;
  }

  if (action.kind === "suffix_set") {
    return `/suffix global ${action.value}`;
  }

  if (action.kind === "model_set") {
    return `/${action.target === "spike" ? "model" : "omni_model"} global ${action.value}`;
  }

  if (action.kind === "reasoning_set") {
    return `/${action.target === "spike" ? "reasoning" : "omni_reasoning"} global ${action.value}`;
  }

  return null;
}

function getRefreshScreenForAction(action) {
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

function buildUnavailableModelMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "The selected model is unavailable."
    : "Выбранный model недоступен.";
}

function buildUnsupportedReasoningMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "The selected reasoning level is unsupported for the current model."
    : "Выбранный reasoning level не поддерживается текущей model.";
}

async function applyGlobalControlActionDirect({
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
        statusMessage: buildWaitUnavailableMessage(language),
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
        statusMessage: buildInvalidSuffixMessage(language),
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
        statusMessage: buildUnavailableModelMessage(language),
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
        statusMessage: buildUnsupportedReasoningMessage(language),
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

export function isGlobalControlCallbackQuery(callbackQuery) {
  return String(callbackQuery?.data ?? "").startsWith(`${CALLBACK_PREFIX}:`);
}

export async function handleGlobalControlCommand({
  api,
  config,
  dispatchCommand,
  globalControlPanelStore,
  message,
  promptFragmentAssembler,
  sessionService,
}) {
  if (!globalControlPanelStore) {
    return { handled: false, reason: "missing-global-control-store" };
  }

  const language = await loadControlLanguage(globalControlPanelStore);
  if (!isGeneralForumMessage(message, config)) {
    await sendStatusMessage(api, message.chat.id, buildGeneralOnlyMessage(language));
    return {
      handled: true,
      reason: "general-only",
    };
  }

  await ensureGlobalControlPanelMessage({
    activeScreen: "root",
    actor: message,
    api,
    config,
    forceStatusMessage: false,
    globalControlPanelStore,
    promptFragmentAssembler,
    sessionService,
  });
  void dispatchCommand;
  return {
    handled: true,
    reason: "global-control-menu-opened",
  };
}

export async function maybeHandleGlobalControlReply({
  api,
  config,
  dispatchCommand,
  globalControlPanelStore,
  message,
  promptFragmentAssembler,
  sessionService,
}) {
  if (!globalControlPanelStore || !isGeneralForumMessage(message, config)) {
    return { handled: false };
  }

  const controlState = await globalControlPanelStore.load({ force: true });
  const pendingInput = controlState.pending_input;
  const language = getControlLanguage(controlState);
  if (!pendingInput) {
    return { handled: false };
  }

  const replyToMessageId = Number(message?.reply_to_message?.message_id ?? 0);
  if (!replyToMessageId || replyToMessageId !== pendingInput.menu_message_id) {
    return { handled: false };
  }

  if (
    pendingInput.requested_by_user_id
    && String(message.from?.id ?? "") !== pendingInput.requested_by_user_id
  ) {
    await sendStatusMessage(
      api,
      message.chat.id,
      buildPendingInputUnauthorizedMessage(language),
    );
    return {
      handled: true,
      reason: "global-control-pending-input-owner-mismatch",
    };
  }

  const text = String(message.text ?? message.caption ?? "");
  if (!text.trim()) {
    await sendStatusMessage(
      api,
      message.chat.id,
      buildPendingInputNeedsTextMessage(language),
    );
    return {
      handled: true,
      reason: "global-control-pending-input-needs-text",
    };
  }

  if (pendingInput.kind === "wait_custom") {
    const parsed = parseWaitCommandArgs(text);
    if (!["set", "off"].includes(parsed.action)) {
      await sendStatusMessage(
        api,
        message.chat.id,
        buildInvalidCustomWaitMessage(language),
      );
      return {
        handled: true,
        reason: "global-control-invalid-custom-wait",
      };
    }
  }

  if (pendingInput.kind === "suffix_text") {
    const suffixText = normalizePromptSuffixText(text);
    if (!suffixText) {
      await sendStatusMessage(api, message.chat.id, buildInvalidSuffixMessage(language));
      return {
        handled: true,
        reason: "global-control-invalid-suffix",
      };
    }
    if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
      await sendStatusMessage(api, message.chat.id, buildTooLongSuffixMessage(language));
      return {
        handled: true,
        reason: "global-control-suffix-too-long",
      };
    }
  }

  const commandText =
    pendingInput.kind === "suffix_text"
      ? `/suffix global ${text}`
      : `/wait global ${text}`;
  await dispatchCommand({
    actor: message.from,
    chat: message.chat,
    commandText,
  });
  await globalControlPanelStore.patch({
    pending_input: null,
    active_screen: pendingInput.screen || controlState.active_screen,
    menu_message_id: pendingInput.menu_message_id,
  });
  await ensureGlobalControlPanelMessage({
    activeScreen: pendingInput.screen || controlState.active_screen,
    actor: message,
    api,
    config,
    globalControlPanelStore,
    preferredMessageId: pendingInput.menu_message_id,
    promptFragmentAssembler,
    sessionService,
  });
  return {
    handled: true,
    reason: "global-control-pending-input-applied",
  };
}

export async function handleGlobalControlCallbackQuery({
  applyGlobalWaitChange = null,
  api,
  callbackQuery,
  config,
  dispatchCommand,
  globalControlPanelStore,
  promptFragmentAssembler,
  sessionService,
}) {
  if (!isGlobalControlCallbackQuery(callbackQuery)) {
    return { handled: false };
  }

  if (!globalControlPanelStore) {
    await answerCallbackQuerySafe(
      api,
      callbackQuery.id,
      "global control panel is unavailable",
    );
    return {
      handled: true,
      reason: "missing-global-control-store",
    };
  }

  if (!isAuthorizedMessage(buildAuthMessageForCallbackQuery(callbackQuery), config)) {
    await answerCallbackQuerySafe(api, callbackQuery.id);
    return {
      handled: false,
      reason: "unauthorized",
    };
  }

  const menuMessage = callbackQuery.message;
  if (!isGeneralForumMessage(menuMessage, config)) {
    await answerCallbackQuerySafe(
      api,
      callbackQuery.id,
      buildGeneralOnlyMessage(await loadControlLanguage(globalControlPanelStore)),
    );
    return {
      handled: true,
      reason: "general-only",
    };
  }

  const parsed = parseCallbackData(callbackQuery.data);
  if (!parsed) {
    await answerCallbackQuerySafe(api, callbackQuery.id);
    return {
      handled: true,
      reason: "invalid-global-control-callback",
    };
  }

  const actor = {
    chat: menuMessage.chat,
    from: callbackQuery.from,
  };

  if (
    (parsed.screen === "omni_model" || parsed.screen === "omni_reasoning")
    && config.omniEnabled === false
  ) {
    await answerCallbackQuerySafe(api, callbackQuery.id, "Omni is disabled");
    return {
      handled: true,
      reason: "omni-disabled",
    };
  }

  await answerCallbackQuerySafe(api, callbackQuery.id);
  return runSerializedGlobalControlOperation(String(menuMessage.chat?.id ?? "global"), async () => {
    const controlState = await globalControlPanelStore.load({ force: true });
    const language = getControlLanguage(controlState);

    if (parsed.kind === "navigate") {
      await ensureGlobalControlPanelMessage({
        activeScreen: parsed.screen,
        actor,
        api,
        config,
        controlState,
        globalControlPanelStore,
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        sessionService,
      });
      return {
        handled: true,
        reason: "global-control-menu-navigated",
      };
    }

    if (parsed.kind === "language_set") {
      await globalControlPanelStore.patch({
        ui_language: parsed.value,
        menu_message_id: menuMessage.message_id,
        active_screen: "root",
        pending_input: controlState.pending_input,
      });
      await ensureGlobalControlPanelMessage({
        activeScreen: "root",
        actor,
        api,
        config,
        controlState: {
          ...controlState,
          ui_language: parsed.value,
          menu_message_id: menuMessage.message_id,
          active_screen: "root",
        },
        globalControlPanelStore,
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        sessionService,
      });
      await sendStatusMessage(
        api,
        menuMessage.chat.id,
        buildLanguageUpdatedMessage(parsed.value),
      );
      return {
        handled: true,
        reason: "global-control-language-updated",
      };
    }

    if (parsed.kind === "help_show") {
      await dispatchCommand({
        actor: callbackQuery.from,
        chat: menuMessage.chat,
        commandText: "/help",
      });
      return {
        handled: true,
        reason: "global-control-help-sent",
      };
    }

    if (parsed.kind === "suffix_input" || parsed.kind === "wait_input") {
      const nextPendingInput = {
        kind: parsed.kind === "suffix_input" ? "suffix_text" : "wait_custom",
        requested_at: new Date().toISOString(),
        requested_by_user_id: String(callbackQuery.from.id),
        menu_message_id: menuMessage.message_id,
        screen: parsed.kind === "suffix_input" ? "suffix" : "wait",
      };
      await globalControlPanelStore.patch({
        pending_input: nextPendingInput,
        menu_message_id: menuMessage.message_id,
        active_screen: nextPendingInput.screen,
      });
      await ensureGlobalControlPanelMessage({
        activeScreen: nextPendingInput.screen,
        actor,
        api,
        config,
        controlState: {
          ...controlState,
          pending_input: nextPendingInput,
          menu_message_id: menuMessage.message_id,
          active_screen: nextPendingInput.screen,
        },
        globalControlPanelStore,
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        sessionService,
      });
      await sendStatusMessage(
        api,
        menuMessage.chat.id,
        buildPendingInputStartedMessage(nextPendingInput.kind, language),
      );
      return {
        handled: true,
        reason: "global-control-pending-input-started",
      };
    }

    if (parsed.kind === "pending_clear") {
      await globalControlPanelStore.patch({
        pending_input: null,
        menu_message_id: menuMessage.message_id,
        active_screen: controlState.active_screen,
        ui_language: language,
      });
      await ensureGlobalControlPanelMessage({
        activeScreen: controlState.active_screen,
        actor,
        api,
        config,
        controlState: {
          ...controlState,
          pending_input: null,
          menu_message_id: menuMessage.message_id,
        },
        globalControlPanelStore,
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        sessionService,
      });
      await sendStatusMessage(
        api,
        menuMessage.chat.id,
        buildPendingInputCanceledMessage(language),
      );
      return {
        handled: true,
        reason: "global-control-pending-input-cleared",
      };
    }

    const directAction = await applyGlobalControlActionDirect({
      action: parsed,
      actor: callbackQuery.from,
      chat: menuMessage.chat,
      config,
      language,
      applyGlobalWaitChange,
      sessionService,
    });
    if (directAction.handled) {
      const refreshScreen = getRefreshScreenForAction(parsed);
      await globalControlPanelStore.patch({
        menu_message_id: menuMessage.message_id,
        active_screen: refreshScreen,
        ui_language: language,
        pending_input: controlState.pending_input,
      });
      await ensureGlobalControlPanelMessage({
        activeScreen: refreshScreen,
        actor,
        api,
        config,
        controlState: {
          ...controlState,
          menu_message_id: menuMessage.message_id,
          active_screen: refreshScreen,
        },
        globalControlPanelStore,
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        sessionService,
      });
      if (directAction.statusMessage) {
        await sendStatusMessage(api, menuMessage.chat.id, directAction.statusMessage);
      }
      return {
        handled: true,
        reason: "global-control-action-applied",
      };
    }

    const commandText = buildDispatchCommandText(parsed);
    if (!commandText) {
      return {
        handled: true,
        reason: "unsupported-global-control-action",
      };
    }

    await dispatchCommand({
      actor: callbackQuery.from,
      chat: menuMessage.chat,
      commandText,
    });
    const refreshedControlState = await globalControlPanelStore.load({ force: true });
    const refreshScreen = getRefreshScreenForAction(parsed);
    await globalControlPanelStore.patch({
      menu_message_id: menuMessage.message_id,
      active_screen: refreshScreen,
      ui_language: language,
      pending_input: refreshedControlState.pending_input,
    });
    await ensureGlobalControlPanelMessage({
      activeScreen: refreshScreen,
      actor,
      api,
      config,
      controlState: {
        ...refreshedControlState,
        menu_message_id: menuMessage.message_id,
        active_screen: refreshScreen,
        ui_language: language,
      },
      globalControlPanelStore,
      preferredMessageId: menuMessage.message_id,
      promptFragmentAssembler,
      sessionService,
    });
    return {
      handled: true,
      reason: "global-control-action-applied",
    };
  });
}
