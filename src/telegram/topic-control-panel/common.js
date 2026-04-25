import { DEFAULT_UI_LANGUAGE } from "../../i18n/ui-language.js";

export function isTopicControlCallbackQuery(callbackQuery, callbackPrefix) {
  return String(callbackQuery?.data ?? "").startsWith(`${callbackPrefix}:`);
}

export function buildExpiredTopicMenuMessage(language = DEFAULT_UI_LANGUAGE) {
  return String(language || "").toLowerCase() === "eng"
    ? "This /menu is expired. Reopen /menu."
    : "Это меню /menu устарело. Открой /menu заново.";
}
