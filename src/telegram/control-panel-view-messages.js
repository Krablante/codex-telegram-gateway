import { DEFAULT_UI_LANGUAGE } from "../i18n/ui-language.js";
import { isEnglish } from "./control-panel-view-common.js";

export function buildOnlyMessage({
  command,
  description,
  language = DEFAULT_UI_LANGUAGE,
}) {
  return isEnglish(language)
    ? [
        `Use ${command}.`,
        "",
        description.english,
      ].join("\n")
    : [
        `Используй ${command}.`,
        "",
        description.russian,
      ].join("\n");
}

export function buildPendingInputStartedMessage({
  kind,
  language = DEFAULT_UI_LANGUAGE,
  newTopicText = null,
  suffixText,
  waitText,
}) {
  if (kind === "suffix_text") {
    return isEnglish(language) ? suffixText.english : suffixText.russian;
  }

  if (kind === "new_topic_title" && newTopicText) {
    return isEnglish(language) ? newTopicText.english : newTopicText.russian;
  }

  return isEnglish(language) ? waitText.english : waitText.russian;
}

export function buildPendingInputCanceledMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Pending manual input cleared."
    : "Ожидание ручного ввода очищено.";
}

export function buildPendingInputNeedsTextMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Send the next plain text message."
    : "Отправь следующее обычное текстовое сообщение.";
}

export function buildInvalidCustomWaitMessage({
  language = DEFAULT_UI_LANGUAGE,
  scopeLabel,
}) {
  return isEnglish(language)
    ? `Invalid custom ${scopeLabel} wait. Send 45s, 2m, 600, or off.`
    : `Некорректный Custom ${scopeLabel} wait. Отправь 45s, 2m, 600 или off.`;
}

export function buildWaitUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Manual collection windows are unavailable right now."
    : "Manual collection window сейчас недоступен.";
}

export function buildInvalidSuffixMessage({
  language = DEFAULT_UI_LANGUAGE,
  scopeLabel,
}) {
  return isEnglish(language)
    ? `${scopeLabel} suffix text is empty.`
    : `Текст ${scopeLabel} suffix пустой.`;
}

export function buildTooLongSuffixMessage({
  language = DEFAULT_UI_LANGUAGE,
  maxChars,
  scopeLabel,
}) {
  return [
    isEnglish(language)
      ? `${scopeLabel} suffix is too long.`
      : `${scopeLabel} suffix слишком длинный.`,
    "",
    `max_chars: ${maxChars}`,
  ].join("\n");
}

export function buildLanguageUpdatedMessage({
  currentLabel,
  language = DEFAULT_UI_LANGUAGE,
}) {
  return [
    isEnglish(language) ? "Interface language updated." : "Язык интерфейса обновлён.",
    "",
    `current: ${currentLabel}`,
  ].join("\n");
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

export function buildMenuRefreshMessage({
  language = DEFAULT_UI_LANGUAGE,
  scopeLabel,
}) {
  return isEnglish(language)
    ? `${scopeLabel} control panel is already current.`
    : `${scopeLabel} control panel уже актуален.`;
}
