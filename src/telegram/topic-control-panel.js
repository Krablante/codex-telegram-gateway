import {
  DEFAULT_UI_LANGUAGE,
  formatUiLanguageLabel,
  getSessionUiLanguage,
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
import { getTopicIdFromMessage } from "../session-manager/session-key.js";
import { isAuthorizedMessage, parseWaitCommandArgs } from "./command-parsing.js";

export const TOPIC_CONTROL_PANEL_COMMAND = "menu";

const CALLBACK_PREFIX = "tcfg";
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
const TOPIC_CONTROL_OPERATION_CHAINS = new Map();

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

function normalizeScreenId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SCREEN_CODES[normalized] ? normalized : "root";
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

function buildTopicControlPanelText({
  availableModels,
  globalPromptSuffix,
  language = DEFAULT_UI_LANGUAGE,
  omniEnabled = true,
  pendingInput = null,
  profiles,
  screen = "root",
  session,
  waitState,
}) {
  const english = isEnglish(language);
  const waitSeconds = waitState?.local?.active
    ? Math.round((waitState.local.flushDelayMs ?? 0) / 1000)
    : null;

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
    buildRootSummaryLine(
      "spike model",
      session?.spike_model_override ?? null,
      profiles.spike.model,
    ),
    buildRootSummaryLine(
      "spike reasoning",
      session?.spike_reasoning_effort_override
        ? formatReasoningEffort(session.spike_reasoning_effort_override)
        : null,
      formatReasoningEffort(profiles.spike.reasoningEffort) || profiles.spike.reasoningEffort,
    ),
    ...(omniEnabled
      ? [
          buildRootSummaryLine(
            "omni model",
            session?.omni_model_override ?? null,
            profiles.omni.model,
          ),
          buildRootSummaryLine(
            "omni reasoning",
            session?.omni_reasoning_effort_override
              ? formatReasoningEffort(session.omni_reasoning_effort_override)
              : null,
            formatReasoningEffort(profiles.omni.reasoningEffort) || profiles.omni.reasoningEffort,
          ),
        ]
      : []),
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
      buildInlineKeyboardButton("Wait", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.wait}`),
      buildInlineKeyboardButton("Suffix", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.suffix}`),
    ],
    [
      buildInlineKeyboardButton("Spike model", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.spike_model}`),
      buildInlineKeyboardButton(
        "Spike reasoning",
        `${CALLBACK_PREFIX}:n:${SCREEN_CODES.spike_reasoning}`,
      ),
    ],
    ...(omniEnabled
      ? [[
        buildInlineKeyboardButton("Omni model", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.omni_model}`),
        buildInlineKeyboardButton(
          "Omni reasoning",
          `${CALLBACK_PREFIX}:n:${SCREEN_CODES.omni_reasoning}`,
        ),
      ]]
      : []),
    [
      buildInlineKeyboardButton("Language", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.language}`),
      buildInlineKeyboardButton("Help", `${CALLBACK_PREFIX}:h:show`),
    ],
    ...(pendingInput
      ? [[buildInlineKeyboardButton("Cancel input", `${CALLBACK_PREFIX}:p:clear`)]]
      : []),
    [buildInlineKeyboardButton("Refresh", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildWaitKeyboard() {
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

function buildSuffixKeyboard(pendingInput) {
  return [
    [
      buildInlineKeyboardButton("On", `${CALLBACK_PREFIX}:s:on`),
      buildInlineKeyboardButton("Off", `${CALLBACK_PREFIX}:s:off`),
    ],
    [
      buildInlineKeyboardButton("Set text", `${CALLBACK_PREFIX}:s:input`),
      buildInlineKeyboardButton("Clear", `${CALLBACK_PREFIX}:s:clear`),
    ],
    [
      buildInlineKeyboardButton("Route global on", `${CALLBACK_PREFIX}:t:on`),
      buildInlineKeyboardButton("Route global off", `${CALLBACK_PREFIX}:t:off`),
    ],
    ...(pendingInput?.kind === "suffix_text"
      ? [[buildInlineKeyboardButton("Cancel input", `${CALLBACK_PREFIX}:p:clear`)]]
      : []),
    [buildInlineKeyboardButton("Back", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildModelKeyboard(target, availableModels) {
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
    [buildInlineKeyboardButton("Clear", `${CALLBACK_PREFIX}:m:${TARGET_CODES[target]}:clear`)],
    [buildInlineKeyboardButton("Back", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildReasoningKeyboard(target, availableLevels) {
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
    [buildInlineKeyboardButton("Clear", `${CALLBACK_PREFIX}:r:${TARGET_CODES[target]}:clear`)],
    [buildInlineKeyboardButton("Back", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
  ];
}

function buildLanguageKeyboard() {
  return [
    [
      buildInlineKeyboardButton("RUS", `${CALLBACK_PREFIX}:l:rus`),
      buildInlineKeyboardButton("ENG", `${CALLBACK_PREFIX}:l:eng`),
    ],
    [buildInlineKeyboardButton("Back", `${CALLBACK_PREFIX}:n:${SCREEN_CODES.root}`)],
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

async function loadTopicControlPanelView({
  config,
  message,
  promptFragmentAssembler,
  session,
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
  let globalPromptSuffix = null;
  let globalSettings = null;
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

  return {
    availableModels,
    globalPromptSuffix,
    profiles: {
      spike: spikeProfile,
      omni: omniProfile,
    },
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

function buildTopicControlPanelPayload({
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
      language,
      omniEnabled,
      pendingInput,
      profiles: view.profiles,
      screen,
      session,
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

function buildTopicOnlyMessage(language = DEFAULT_UI_LANGUAGE) {
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

function buildPendingInputStartedMessage(kind, language = DEFAULT_UI_LANGUAGE) {
  if (kind === "suffix_text") {
    return isEnglish(language)
      ? "Reply to the menu with the new topic suffix text."
      : "Ответь на menu новым текстом topic suffix.";
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
    ? "Invalid custom topic wait. Reply with 45s, 2m, 600, or off."
    : "Некорректный Custom topic wait. Ответь 45s, 2m, 600 или off.";
}

function buildInvalidSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Topic suffix text is empty."
    : "Текст topic suffix пустой.";
}

function buildTooLongSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return [
    isEnglish(language)
      ? "Topic suffix is too long."
      : "Topic suffix слишком длинный.",
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

function buildWaitUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Manual collection windows are unavailable right now."
    : "Manual collection window сейчас недоступен.";
}

function buildMenuRefreshMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Topic control panel is already current."
    : "Topic control panel уже актуален.";
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

async function sendStatusMessage(api, session, text) {
  await api.sendMessage({
    chat_id: session.chat_id,
    message_thread_id: Number(session.topic_id),
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

async function pinTopicControlPanelMessageSafe(api, session, messageId) {
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return false;
  }

  try {
    await api.pinChatMessage({
      chat_id: session.chat_id,
      message_id: messageId,
      disable_notification: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function runSerializedTopicControlOperation(key, operation) {
  const previous = TOPIC_CONTROL_OPERATION_CHAINS.get(key) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(operation);

  TOPIC_CONTROL_OPERATION_CHAINS.set(key, current);

  try {
    return await current;
  } finally {
    if (TOPIC_CONTROL_OPERATION_CHAINS.get(key) === current) {
      TOPIC_CONTROL_OPERATION_CHAINS.delete(key);
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

export async function ensureTopicControlPanelMessage({
  activeScreen = "root",
  actor,
  api,
  config,
  controlState = null,
  forceStatusMessage = false,
  preferredMessageId = null,
  promptFragmentAssembler,
  session,
  sessionService,
  topicControlPanelStore,
  pin = false,
}) {
  const resolvedControlState =
    controlState ?? await topicControlPanelStore.load(session, { force: true });
  const screen = normalizeScreenId(activeScreen ?? resolvedControlState.active_screen);
  const language = getSessionUiLanguage(session);
  const view = await loadTopicControlPanelView({
    config,
    message: actor,
    promptFragmentAssembler,
    session,
    sessionService,
    screen,
  });
  const payload = buildTopicControlPanelPayload({
    language,
    omniEnabled: config.omniEnabled !== false,
    pendingInput: resolvedControlState.pending_input,
    screen,
    session,
    view,
  });
  const messageId = preferredMessageId ?? resolvedControlState.menu_message_id;

  if (messageId) {
    try {
      await api.editMessageText({
        chat_id: session.chat_id,
        message_id: messageId,
        text: payload.text,
        reply_markup: payload.reply_markup,
      });
      await topicControlPanelStore.patch(session, {
        menu_message_id: messageId,
        active_screen: screen,
        pending_input: syncPendingInputMessageId(
          resolvedControlState.pending_input,
          messageId,
        ),
      });
      if (pin) {
        await pinTopicControlPanelMessageSafe(api, session, messageId);
      }
      return {
        created: false,
        messageId,
      };
    } catch (error) {
      if (isNotModifiedError(error)) {
        await topicControlPanelStore.patch(session, {
          menu_message_id: messageId,
          active_screen: screen,
          pending_input: syncPendingInputMessageId(
            resolvedControlState.pending_input,
            messageId,
          ),
        });
        if (pin) {
          await pinTopicControlPanelMessageSafe(api, session, messageId);
        }
        if (forceStatusMessage) {
          await sendStatusMessage(api, session, buildMenuRefreshMessage(language));
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
    chat_id: session.chat_id,
    message_thread_id: Number(session.topic_id),
    text: payload.text,
    reply_markup: payload.reply_markup,
  });
  const nextMessageId =
    Number.isInteger(sent?.message_id) && sent.message_id > 0
      ? sent.message_id
      : null;
  const resolvedMessageId = nextMessageId ?? messageId;
  await topicControlPanelStore.patch(session, {
    menu_message_id: resolvedMessageId,
    active_screen: screen,
    pending_input: syncPendingInputMessageId(
      resolvedControlState.pending_input,
      resolvedMessageId,
    ),
  });
  if (pin || resolvedMessageId !== messageId) {
    await pinTopicControlPanelMessageSafe(api, session, resolvedMessageId);
  }
  return {
    created: true,
    messageId: resolvedMessageId,
  };
}

async function applyTopicControlActionDirect({
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
      statusMessage: buildLanguageUpdatedMessage(getSessionUiLanguage(nextSession)),
    };
  }

  return { handled: false };
}

function getRefreshScreenForAction(action) {
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

export function isTopicControlCallbackQuery(callbackQuery) {
  return String(callbackQuery?.data ?? "").startsWith(`${CALLBACK_PREFIX}:`);
}

export async function handleTopicControlCommand({
  api,
  config,
  fallbackLanguage = DEFAULT_UI_LANGUAGE,
  message,
  promptFragmentAssembler,
  sessionService,
  topicControlPanelStore,
}) {
  if (!topicControlPanelStore) {
    return { handled: false, reason: "missing-topic-control-store" };
  }

  const topicId = getTopicIdFromMessage(message);
  if (!topicId) {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: buildTopicOnlyMessage(fallbackLanguage),
    });
    return {
      handled: true,
      reason: "topic-only",
    };
  }

  const session = await sessionService.ensureSessionForMessage(message);
  await ensureTopicControlPanelMessage({
    activeScreen: "root",
    actor: message,
    api,
    config,
    promptFragmentAssembler,
    session,
    sessionService,
    topicControlPanelStore,
    pin: true,
  });
  return {
    handled: true,
    reason: "topic-control-menu-opened",
  };
}

export async function maybeHandleTopicControlReply({
  api,
  config,
  message,
  promptFragmentAssembler,
  sessionService,
  topicControlPanelStore,
  applyTopicWaitChange = null,
}) {
  if (!topicControlPanelStore || !getTopicIdFromMessage(message)) {
    return { handled: false };
  }

  const session = await sessionService.ensureSessionForMessage(message);
  const controlState = await topicControlPanelStore.load(session, { force: true });
  const pendingInput = controlState.pending_input;
  const language = getSessionUiLanguage(session);
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
      session,
      buildPendingInputUnauthorizedMessage(language),
    );
    return {
      handled: true,
      reason: "topic-control-pending-input-owner-mismatch",
    };
  }

  const text = String(message.text ?? message.caption ?? "");
  if (!text.trim()) {
    await sendStatusMessage(
      api,
      session,
      buildPendingInputNeedsTextMessage(language),
    );
    return {
      handled: true,
      reason: "topic-control-pending-input-needs-text",
    };
  }

  let nextSession = session;
  if (pendingInput.kind === "wait_custom") {
    const parsed = parseWaitCommandArgs(text);
    if (
      !["set", "off"].includes(parsed.action)
      || parsed.scope !== "topic"
      || typeof applyTopicWaitChange !== "function"
    ) {
      await sendStatusMessage(
        api,
        session,
        buildInvalidCustomWaitMessage(language),
      );
      return {
        handled: true,
        reason: "topic-control-invalid-custom-wait",
      };
    }

    const applied = await applyTopicWaitChange({
      message,
      value: parsed.action === "off" ? "off" : String(parsed.seconds),
    });
    if (!applied?.available) {
      await sendStatusMessage(api, session, buildWaitUnavailableMessage(language));
      return {
        handled: true,
        reason: "topic-control-wait-unavailable",
      };
    }
  }

  if (pendingInput.kind === "suffix_text") {
    const suffixText = normalizePromptSuffixText(text);
    if (!suffixText) {
      await sendStatusMessage(api, session, buildInvalidSuffixMessage(language));
      return {
        handled: true,
        reason: "topic-control-invalid-suffix",
      };
    }
    if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
      await sendStatusMessage(api, session, buildTooLongSuffixMessage(language));
      return {
        handled: true,
        reason: "topic-control-suffix-too-long",
      };
    }

    nextSession = await sessionService.updatePromptSuffix(session, {
      text: suffixText,
      enabled: true,
    });
  }

  await topicControlPanelStore.patch(nextSession, {
    pending_input: null,
    active_screen: pendingInput.screen || controlState.active_screen,
    menu_message_id: pendingInput.menu_message_id,
  });
  await ensureTopicControlPanelMessage({
    activeScreen: pendingInput.screen || controlState.active_screen,
    actor: message,
    api,
    config,
    preferredMessageId: pendingInput.menu_message_id,
    promptFragmentAssembler,
    session: nextSession,
    sessionService,
    topicControlPanelStore,
  });
  return {
    handled: true,
    reason: "topic-control-pending-input-applied",
  };
}

export async function handleTopicControlCallbackQuery({
  applyTopicWaitChange = null,
  api,
  callbackQuery,
  config,
  dispatchCommand,
  promptFragmentAssembler,
  sessionService,
  topicControlPanelStore,
}) {
  if (!isTopicControlCallbackQuery(callbackQuery)) {
    return { handled: false };
  }

  if (!topicControlPanelStore) {
    await answerCallbackQuerySafe(api, callbackQuery.id, "topic control panel is unavailable");
    return {
      handled: true,
      reason: "missing-topic-control-store",
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
  if (!getTopicIdFromMessage(menuMessage)) {
    await answerCallbackQuerySafe(api, callbackQuery.id, "Use /menu inside a topic");
    return {
      handled: true,
      reason: "topic-only",
    };
  }

  const session = await sessionService.ensureSessionForMessage(menuMessage);
  const parsed = parseCallbackData(callbackQuery.data);
  if (!parsed) {
    await answerCallbackQuerySafe(api, callbackQuery.id);
    return {
      handled: true,
      reason: "invalid-topic-control-callback",
    };
  }

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
  return runSerializedTopicControlOperation(session.session_key, async () => {
    const controlState = await topicControlPanelStore.load(session, { force: true });
    const language = getSessionUiLanguage(session);
    const actorMessage = {
      ...menuMessage,
      from: callbackQuery.from,
    };

    if (parsed.kind === "navigate") {
      await ensureTopicControlPanelMessage({
        activeScreen: parsed.screen,
        actor: actorMessage,
        api,
        config,
        controlState,
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        session,
        sessionService,
        topicControlPanelStore,
      });
      return {
        handled: true,
        reason: "topic-control-menu-navigated",
      };
    }

    if (parsed.kind === "help_show") {
      await dispatchCommand({
        actor: callbackQuery.from,
        chat: {
          ...menuMessage.chat,
          message_thread_id: menuMessage.message_thread_id,
        },
        commandText: "/help",
      });
      return {
        handled: true,
        reason: "topic-control-help-sent",
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
      await topicControlPanelStore.patch(session, {
        pending_input: nextPendingInput,
        menu_message_id: menuMessage.message_id,
        active_screen: nextPendingInput.screen,
      });
      await ensureTopicControlPanelMessage({
        activeScreen: nextPendingInput.screen,
        actor: actorMessage,
        api,
        config,
        controlState: {
          ...controlState,
          pending_input: nextPendingInput,
          menu_message_id: menuMessage.message_id,
          active_screen: nextPendingInput.screen,
        },
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        session,
        sessionService,
        topicControlPanelStore,
      });
      await sendStatusMessage(
        api,
        session,
        buildPendingInputStartedMessage(nextPendingInput.kind, language),
      );
      return {
        handled: true,
        reason: "topic-control-pending-input-started",
      };
    }

    if (parsed.kind === "pending_clear") {
      await topicControlPanelStore.patch(session, {
        pending_input: null,
        menu_message_id: menuMessage.message_id,
        active_screen: controlState.active_screen,
      });
      await ensureTopicControlPanelMessage({
        activeScreen: controlState.active_screen,
        actor: actorMessage,
        api,
        config,
        controlState: {
          ...controlState,
          pending_input: null,
          menu_message_id: menuMessage.message_id,
        },
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        session,
        sessionService,
        topicControlPanelStore,
      });
      await sendStatusMessage(
        api,
        session,
        buildPendingInputCanceledMessage(language),
      );
      return {
        handled: true,
        reason: "topic-control-pending-input-cleared",
      };
    }

    const directAction = await applyTopicControlActionDirect({
      action: parsed,
      config,
      language,
      message: actorMessage,
      session,
      sessionService,
      applyTopicWaitChange,
    });
    if (directAction.handled) {
      const nextSession = directAction.session || session;
      const refreshScreen = getRefreshScreenForAction(parsed);
      await topicControlPanelStore.patch(nextSession, {
        menu_message_id: menuMessage.message_id,
        active_screen: refreshScreen,
        pending_input: controlState.pending_input,
      });
      await ensureTopicControlPanelMessage({
        activeScreen: refreshScreen,
        actor: actorMessage,
        api,
        config,
        controlState: {
          ...controlState,
          menu_message_id: menuMessage.message_id,
          active_screen: refreshScreen,
        },
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        session: nextSession,
        sessionService,
        topicControlPanelStore,
      });
      if (directAction.statusMessage) {
        await sendStatusMessage(api, nextSession, directAction.statusMessage);
      }
      return {
        handled: true,
        reason: "topic-control-action-applied",
      };
    }

    return {
      handled: true,
      reason: "unsupported-topic-control-action",
    };
  });
}
