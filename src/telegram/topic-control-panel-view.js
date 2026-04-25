import {
  DEFAULT_UI_LANGUAGE,
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
import { resolveStatusView } from "./status-view.js";
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
};
const SCREEN_IDS = Object.fromEntries(
  Object.entries(SCREEN_CODES).map(([screenId, code]) => [code, screenId]),
);
const TARGET_CODES = {
  spike: "s",
};
const TARGET_IDS = {
  s: "spike",
};

export function normalizeTopicControlScreenId(value) {
  return normalizeControlScreenId(value, SCREEN_CODES);
}

function buildPendingInputLabel(kind, language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputLabel(kind, language, {
    wait_custom: isEnglish(language)
      ? "custom local wait; send 45s / 2m / off"
      : "custom local wait; отправь 45s / 2m / off",
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

function buildTopicControlPanelText({
  availableModels,
  globalPromptSuffix,
  limitsSummary = null,
  language = DEFAULT_UI_LANGUAGE,
  notice = null,
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
        ? "Tap a preset or choose Custom, then send the next text message."
        : "Выбери preset или нажми Custom, затем отправь следующее текстовое сообщение.",
      english
        ? "This is a one-topic manual collection window."
        : "Это manual collection window только для этого топика.",
      ...buildStatusLines({ language, notice, pendingInput }),
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
      buildSuffixPreview(session?.prompt_suffix_text, language),
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
        ? "Open the bot you want to tune for this topic."
        : "Выбери бота, настройки которого хочешь менять в этом топике.",
      "",
      buildBotProfileLine("spike", profiles.spike),
    ].join("\n");
  }

  if (screen === "spike_model") {
    const target = "spike";
    const title = "Spike topic model";
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

  if (screen === "spike_reasoning") {
    const target = "spike";
    const title = "Spike topic reasoning";
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
      ? "Buttons change values for this topic; text values are set by sending the next text message."
      : "Кнопки меняют значения только для этого топика, текстовые значения задаются следующим текстовым сообщением.",
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

function buildBotSettingsKeyboard() {
  return [
    [
      buildInlineKeyboardButton("Spike model", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.spike_model}`),
      buildInlineKeyboardButton("Spike reasoning", `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:n:${SCREEN_CODES.spike_reasoning}`),
    ],
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
  return buildSharedWaitKeyboard({
    backScreenCode: SCREEN_CODES.root,
    callbackPrefix: TOPIC_CONTROL_PANEL_CALLBACK_PREFIX,
  });
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
  return buildSharedLanguageKeyboard({
    backScreenCode: SCREEN_CODES.root,
    callbackPrefix: TOPIC_CONTROL_PANEL_CALLBACK_PREFIX,
  });
}

function buildTopicControlPanelMarkup({
  availableModels,
  runtimeModels = availableModels,
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
    return { inline_keyboard: buildBotSettingsKeyboard() };
  }

  if (screen === "spike_model") {
    return { inline_keyboard: buildModelKeyboard("spike", availableModels) };
  }

  if (screen === "spike_reasoning") {
    return {
      inline_keyboard: buildReasoningKeyboard(
        "spike",
        getSupportedReasoningLevelsForModel(runtimeModels, profiles.spike.model),
      ),
    };
  }

  return {
    inline_keyboard: buildRootKeyboard(pendingInput),
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
    || screen === "spike_reasoning";

  let availableModels = [];
  let runtimeModels = [];
  let globalPromptSuffix = null;
  let limitsSummary = null;
  let resolvedSession = session;
  let spikeProfile = {
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
    runtimeModels =
      typeof sessionService.loadAvailableCodexModels === "function"
        ? await sessionService.loadAvailableCodexModels(session)
        : [];
    availableModels =
      typeof sessionService.loadVisibleCodexModels === "function"
        ? await sessionService.loadVisibleCodexModels(session)
        : await loadVisibleCodexModels({
          configPath: config.codexConfigPath,
        });
    const globalSettings = await sessionService.getGlobalCodexSettings();
    spikeProfile = resolveCodexRuntimeProfile({
      session,
      globalSettings,
      config,
      target: "spike",
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

  return {
    availableModels,
    runtimeModels,
    globalPromptSuffix,
    limitsSummary,
    session: resolvedSession,
    profiles: {
      spike: spikeProfile,
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
  notice = null,
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
      notice,
      pendingInput,
      profiles: view.profiles,
      screen,
      session,
      statusText: view.statusText,
      waitState: view.waitState,
    }),
    reply_markup: buildTopicControlPanelMarkup({
      availableModels: view.availableModels,
      runtimeModels: view.runtimeModels,
      pendingInput,
      profiles: view.profiles,
      screen,
    }),
  };
}

export function buildTopicOnlyMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedOnlyMessage({
    command: "/menu inside a topic",
    description: {
      english: "This menu changes settings only for the current topic.",
      russian: "Это menu меняет настройки только текущего топика.",
    },
    language,
  });
}

export function buildPendingInputStartedMessage(kind, language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputStartedMessage({
    kind,
    language,
    suffixText: {
      english: "Send the next text message with the new topic suffix text.",
      russian: "Отправь следующее текстовое сообщение новым текстом topic suffix.",
    },
    waitText: {
      english: "Send 45s, 2m, 600, or off as the next text message.",
      russian: "Отправь 45s, 2m, 600 или off следующим текстовым сообщением.",
    },
  });
}

export function buildPendingInputCanceledMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputCanceledMessage(language);
}

export function buildPendingInputNeedsTextMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedPendingInputNeedsTextMessage(language);
}

export function buildInvalidCustomWaitMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedInvalidCustomWaitMessage({
    language,
    scopeLabel: "topic",
  });
}

export function buildInvalidSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedInvalidSuffixMessage({
    language,
    scopeLabel: "Topic",
  });
}

export function buildTooLongSuffixMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedTooLongSuffixMessage({
    language,
    maxChars: PROMPT_SUFFIX_MAX_CHARS,
    scopeLabel: "Topic",
  });
}

export function buildLanguageUpdatedMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedLanguageUpdatedMessage({
    currentLabel: getLanguageLabel(language),
    language,
  });
}

export function buildWaitUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedWaitUnavailableMessage(language);
}

export function buildMenuRefreshMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedMenuRefreshMessage({
    language,
    scopeLabel: "Topic",
  });
}

export function buildUnavailableModelMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedUnavailableModelMessage(language);
}

export function buildUnsupportedReasoningMessage(language = DEFAULT_UI_LANGUAGE) {
  return buildSharedUnsupportedReasoningMessage(language);
}

export function parseTopicControlCallbackData(data) {
  return parseStandardControlCallbackData(data, {
    prefix: TOPIC_CONTROL_PANEL_CALLBACK_PREFIX,
    screenIds: SCREEN_IDS,
    targetIds: TARGET_IDS,
    extraGroups: {
      t: (rest) => {
        const value = rest[0] ?? "";
        if (!["on", "off"].includes(value)) {
          return null;
        }
        return { kind: "suffix_routing_set", value };
      },
      cmd: (rest) => {
        const command = String(rest[0] ?? "").trim().toLowerCase();
        if (!["compact", "purge", "interrupt"].includes(command)) {
          return null;
        }
        return {
          kind: "command_dispatch",
          command,
        };
      },
    },
  });
}
