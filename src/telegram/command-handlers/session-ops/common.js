import { normalizeUiLanguage } from "../../../i18n/ui-language.js";

export function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}
