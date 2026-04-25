import {
  DEFAULT_UI_LANGUAGE,
  formatUiLanguageLabel,
  normalizeUiLanguage,
} from "../i18n/ui-language.js";
import { formatReasoningEffort } from "../session-manager/codex-runtime-settings.js";
import { normalizePromptSuffixText } from "../session-manager/prompt-suffix.js";

const WAIT_PRESETS = [
  { label: "30s", seconds: 30 },
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "10m", seconds: 600 },
  { label: "30m", seconds: 1800 },
];

export function isEnglish(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng";
}

export function getLanguageLabel(language = DEFAULT_UI_LANGUAGE) {
  return formatUiLanguageLabel(language);
}

export function buildInlineKeyboardButton(text, callbackData) {
  return {
    text,
    callback_data: callbackData,
  };
}

export function chunkIntoRows(entries, size = 2) {
  const rows = [];
  for (let index = 0; index < entries.length; index += size) {
    rows.push(entries.slice(index, index + size));
  }
  return rows;
}

export function normalizeControlScreenId(value, screenCodes) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return screenCodes[normalized] ? normalized : "root";
}

export function formatWaitDuration(seconds, language = DEFAULT_UI_LANGUAGE) {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return isEnglish(language) ? "off" : "выключен";
  }

  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }

  return `${seconds}s`;
}

export function formatConfiguredValue(value, language = DEFAULT_UI_LANGUAGE) {
  return value || (isEnglish(language) ? "default" : "default");
}

export function formatReasoningValue(value, language = DEFAULT_UI_LANGUAGE) {
  return formatReasoningEffort(value) || (isEnglish(language) ? "default" : "default");
}

export function buildRootSummaryLine(label, configuredValue, effectiveValue) {
  return configuredValue
    ? `${label}: ${configuredValue}`
    : `${label}: default -> ${effectiveValue}`;
}

function formatProfileReasoningValue(value) {
  return value || "default";
}

export function buildPendingInputLabel(kind, language = DEFAULT_UI_LANGUAGE, overrides = {}) {
  if (kind === "suffix_text") {
    return overrides.suffix_text || (
      isEnglish(language)
        ? "suffix text; send the next text message"
        : "текст suffix; отправь следующее текстовое сообщение"
    );
  }

  if (kind === "wait_custom") {
    return overrides.wait_custom || (
      isEnglish(language)
        ? "manual wait; send 45s / 2m / off"
        : "ручной wait; отправь 45s / 2m / off"
    );
  }

  if (kind === "new_topic_title") {
    return overrides.new_topic_title || (
      isEnglish(language)
        ? "topic title; send the next text message"
        : "название топика; отправь следующее текстовое сообщение"
    );
  }

  return overrides.default || "manual input pending";
}

export function buildSuffixPreview(promptSuffixText, language = DEFAULT_UI_LANGUAGE) {
  const suffixText = normalizePromptSuffixText(promptSuffixText);
  if (!suffixText) {
    return isEnglish(language) ? "empty" : "empty";
  }

  return suffixText;
}

export function buildBotProfileLine(label, profile) {
  return `${label}: ${profile.model} (${formatProfileReasoningValue(profile.reasoningEffort)})`;
}

export function buildWaitKeyboard({
  backScreenCode,
  callbackPrefix,
  customLabel = "Custom",
  offLabel = "Off",
  presets = WAIT_PRESETS,
}) {
  return [
    ...chunkIntoRows(
      presets.map((entry) =>
        buildInlineKeyboardButton(entry.label, `${callbackPrefix}:w:${entry.seconds}`),
      ),
      2,
    ),
    [
      buildInlineKeyboardButton(customLabel, `${callbackPrefix}:w:input`),
      buildInlineKeyboardButton(offLabel, `${callbackPrefix}:w:off`),
    ],
    [buildInlineKeyboardButton("Back", `${callbackPrefix}:n:${backScreenCode}`)],
  ];
}

export function buildLanguageKeyboard({
  backScreenCode,
  callbackPrefix,
}) {
  return [
    [
      buildInlineKeyboardButton("RUS", `${callbackPrefix}:l:rus`),
      buildInlineKeyboardButton("ENG", `${callbackPrefix}:l:eng`),
    ],
    [buildInlineKeyboardButton("Back", `${callbackPrefix}:n:${backScreenCode}`)],
  ];
}

export function parseStandardControlCallbackData(data, {
  extraGroups = {},
  prefix,
  screenIds,
  targetIds,
}) {
  const [callbackPrefix, group, ...rest] = String(data ?? "").split(":");
  if (callbackPrefix !== prefix || !group) {
    return null;
  }

  if (group === "n") {
    return {
      kind: "navigate",
      screen: screenIds[rest[0]] ?? "root",
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
    const target = targetIds[rest[0]];
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
    const target = targetIds[rest[0]];
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

  if (typeof extraGroups[group] === "function") {
    return extraGroups[group](rest);
  }

  return null;
}
