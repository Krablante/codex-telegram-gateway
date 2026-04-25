import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import {
  DEFAULT_UI_LANGUAGE,
  formatWaitWindow,
  getLanguageLabel,
  getWaitScopeLabel,
  isEnglish,
  selectWaitStateByScope,
} from "./common.js";

export function buildWaitUsageMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Collection windows",
      "",
      "Usage:",
      "/wait 60",
      "wait 600",
      "/wait 1m",
      "/wait global 60",
      "/wait global 1m",
      "/wait",
      "/wait off",
      "/wait global off",
      "",
      "Plain /wait <time> arms a local one-shot window for the next prompt in this topic.",
      "The local window resets automatically after that prompt is sent.",
      "/wait global <time> enables the persistent global window across topics in this chat.",
      "If both exist, the local one-shot window wins in this topic.",
      "Each new message inside the active prompt resets the timer.",
      "Send a separate `All`, `Все`, or `Всё` message to flush immediately.",
    ].join("\n");
  }

  return [
    "Collection windows",
    "",
    "Использование:",
    "/wait 60",
    "wait 600",
    "/wait 1m",
    "/wait global 60",
    "/wait global 1m",
    "/wait",
    "/wait off",
    "/wait global off",
    "",
    "Обычный /wait <время> включает local one-shot window для следующего prompt в этом топике.",
    "Local one-shot window само сбрасывается после отправки этого prompt.",
    "/wait global <время> включает persistent global window для всех тем этого чата.",
    "Если активны оба режима, в этом топике приоритет у local one-shot window.",
    "Каждое новое сообщение внутри активного prompt сбрасывает таймер.",
    "Отправь отдельным сообщением `Все`, `Всё` или `All`, чтобы запустить сразу.",
  ].join("\n");
}

export function buildWaitStateMessage(
  waitState,
  heading = "Collection windows",
  language = DEFAULT_UI_LANGUAGE,
  scope = "effective",
) {
  const english = isEnglish(language);
  const selectedState = selectWaitStateByScope(waitState, scope);
  if (!selectedState?.active) {
    return [
      heading,
      "",
      "status: off",
      "",
      scope === "global"
        ? (english
          ? "Enable it with: /wait global 60 or /wait global 1m"
          : "Включить: /wait global 60 или /wait global 1m")
        : scope === "topic"
          ? (english
            ? "Enable it with: /wait 60, wait 600, or /wait 1m"
            : "Включить: /wait 60, wait 600 или /wait 1m")
          : (english
            ? "Enable local with /wait 60 or global with /wait global 60"
            : "Включить локальный через /wait 60 или global через /wait global 60"),
    ].join("\n");
  }

  const seconds = Number.isInteger(selectedState.flushDelayMs)
    ? Math.round(selectedState.flushDelayMs / 1000)
    : null;
  const lines = [
    heading,
    "",
    "status: on",
    `scope: ${getWaitScopeLabel(selectedState.scope, language)}`,
    `timeout: ${formatWaitWindow(seconds, language)}`,
    `buffered parts: ${selectedState.messageCount ?? 0}`,
  ];

  if (scope === "effective") {
    lines.push(
      "",
      english
        ? `local one-shot: ${waitState?.local?.active ? "on" : "off"}`
        : `local one-shot: ${waitState?.local?.active ? "on" : "off"}`,
      english
        ? `global persistent: ${waitState?.global?.active ? "on" : "off"}`
        : `global persistent: ${waitState?.global?.active ? "on" : "off"}`,
    );
  }

  lines.push(
    "",
    selectedState.scope === "global"
      ? (english
        ? "This window stays enabled until /wait global off or a new /wait global <time>."
        : "Это окно остается включенным до /wait global off или нового /wait global <время>.")
      : (english
        ? "This window is local to this topic and resets after the next prompt is sent."
        : "Это окно локально для этого топика и само сбрасывается после отправки следующего prompt."),
    english
      ? "Each new message inside the active prompt resets the timer."
      : "Каждое новое сообщение внутри активного prompt сбрасывает таймер.",
    english
      ? "Send a separate `All`, `Все`, or `Всё` message to flush immediately."
      : "Отправь отдельным сообщением `Все`, `Всё` или `All`, чтобы запустить сразу.",
    selectedState.scope === "global"
      ? (english ? "Disable it: /wait global off" : "Отключить: /wait global off")
      : (english ? "Disable it: /wait off" : "Отключить: /wait off"),
  );

  return lines.join("\n");
}

export function buildWaitDisabledMessage(
  canceled,
  scope = "topic",
  language = DEFAULT_UI_LANGUAGE,
) {
  return [
    isEnglish(language)
      ? scope === "global"
        ? "Global wait is off."
        : "Local wait is off."
      : scope === "global"
        ? "Global wait is off."
        : "Local wait is off.",
    "",
    `discarded parts: ${canceled?.messageCount ?? 0}`,
  ].join("\n");
}

export function buildWaitUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "The collection window is unavailable in this runtime."
    : "Collection window недоступно в этом runtime.";
}

export function buildLanguageStateMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  const selected = getLanguageLabel(session?.ui_language ?? language);
  if (isEnglish(language)) {
    return [
      "Interface language",
      "",
      `current: ${selected}`,
      "",
      "Usage:",
      "/language",
      "/language rus",
      "/language eng",
    ].join("\n");
  }

  return [
    "Язык интерфейса",
    "",
    `current: ${selected}`,
    "",
    "Использование:",
    "/language",
    "/language rus",
    "/language eng",
  ].join("\n");
}

export function buildLanguageUpdatedMessage(session) {
  const language = getSessionUiLanguage(session);
  return [
    isEnglish(language) ? "Interface language updated." : "Язык интерфейса обновлён.",
    "",
    `current: ${getLanguageLabel(language)}`,
  ].join("\n");
}

export function buildLanguageUsageMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Language command is invalid.",
      "",
      "Use /language, /language rus, or /language eng.",
    ].join("\n");
  }

  return [
    "Команда language некорректна.",
    "",
    "Используй /language, /language rus или /language eng.",
  ].join("\n");
}
