import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import {
  isTopicPromptSuffixEnabled,
  normalizePromptSuffixText,
} from "../../../session-manager/prompt-suffix.js";
import { DEFAULT_UI_LANGUAGE, isEnglish } from "./common.js";

export function buildPromptSuffixMessage(
  promptSuffixState,
  heading,
  scope = "topic",
  language = DEFAULT_UI_LANGUAGE,
) {
  const suffixText = normalizePromptSuffixText(
    promptSuffixState?.prompt_suffix_text,
  );
  const setCommand =
    scope === "global" ? "/suffix global <text>" : "/suffix <text>";

  return [
    heading,
    "",
    `scope: ${scope}`,
    `status: ${promptSuffixState?.prompt_suffix_enabled && suffixText ? "on" : "off"}`,
    `text: ${suffixText ? "set" : "empty"}`,
    "",
    suffixText ||
      (isEnglish(language)
        ? `Set it with ${setCommand}.`
        : `Задай его через ${setCommand}.`),
  ].join("\n");
}

export function buildPromptSuffixTooLongMessage(
  maxChars,
  language = DEFAULT_UI_LANGUAGE,
) {
  return [
    isEnglish(language) ? "Prompt suffix is too long." : "Prompt suffix слишком длинный.",
    "",
    `max_chars: ${maxChars}`,
  ].join("\n");
}

export function buildPromptSuffixEmptyMessage(
  scope = "topic",
  language = DEFAULT_UI_LANGUAGE,
) {
  const setCommand =
    scope === "global" ? "/suffix global <text>" : "/suffix <text>";

  return [
    isEnglish(language)
      ? "Prompt suffix text is empty."
      : "Текст Prompt suffix пустой.",
    "",
    isEnglish(language)
      ? `Set it first with ${setCommand}.`
      : `Сначала задай его через ${setCommand}.`,
  ].join("\n");
}

export function buildPromptSuffixHelpMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Suffix help",
      "",
      "Local suffix in the current topic:",
      "/suffix <text>",
      "/suffix",
      "/suffix on | off | clear",
      "",
      "Global suffix for the whole gateway:",
      "/suffix global <text>",
      "/suffix global",
      "/suffix global on | off | clear",
      "",
      "Topic kill switch:",
      "/suffix topic",
      "/suffix topic off",
      "/suffix topic on",
      "",
      "Priority:",
      "1. /suffix topic off => no suffixes in this topic",
      "2. local suffix on => local overrides global",
      "3. otherwise global suffix if it is enabled",
    ].join("\n");
  }

  return [
    "Prompt suffix help",
    "",
    "Local prompt suffix в текущем топике:",
    "/suffix <text>",
    "/suffix",
    "/suffix on | off | clear",
    "",
    "Global prompt suffix для всего gateway:",
    "/suffix global <text>",
    "/suffix global",
    "/suffix global on | off | clear",
    "",
    "Топик-рубильник:",
    "/suffix topic",
    "/suffix topic off",
    "/suffix topic on",
    "",
    "Приоритет:",
    "1. /suffix topic off => prompt suffixes не применяются в этом топике",
    "2. local suffix on => local перекрывает global",
    "3. иначе применяется global prompt suffix, если он включён",
  ].join("\n");
}

export function buildTopicPromptSuffixStateMessage(
  session,
  heading,
  language = getSessionUiLanguage(session),
) {
  return [
    heading,
    "",
    "scope: topic-routing",
    `status: ${isTopicPromptSuffixEnabled(session) ? "on" : "off"}`,
    "",
    isEnglish(language)
      ? "When off, this topic ignores both local and global prompt suffixes."
      : "Когда выключено, этот топик игнорирует и local, и global prompt suffix.",
    isEnglish(language)
      ? "Use /suffix topic on or /suffix topic off."
      : "Используй /suffix topic on или /suffix topic off.",
  ].join("\n");
}

export function buildTopicPromptSuffixUsageMessage(
  language = DEFAULT_UI_LANGUAGE,
) {
  return [
    isEnglish(language)
      ? "Topic prompt suffix routing command is invalid."
      : "Команда Topic prompt suffix routing некорректна.",
    "",
    isEnglish(language)
      ? "Use /suffix topic on, /suffix topic off, or /suffix topic."
      : "Используй /suffix topic on, /suffix topic off или /suffix topic.",
  ].join("\n");
}
