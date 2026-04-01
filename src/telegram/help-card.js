import { fileURLToPath } from "node:url";

import { normalizeUiLanguage } from "../i18n/ui-language.js";

const HELP_CARD_ASSETS = {
  rus: {
    filePath: fileURLToPath(
      new URL("../../assets/help/telegram-help-card-rus.png", import.meta.url),
    ),
    fileName: "severus-help-summer-rus.png",
  },
  eng: {
    filePath: fileURLToPath(
      new URL("../../assets/help/telegram-help-card-eng.png", import.meta.url),
    ),
    fileName: "severus-help-summer-eng.png",
  },
};

export function getHelpCardAsset(language) {
  return HELP_CARD_ASSETS[normalizeUiLanguage(language)] || HELP_CARD_ASSETS.rus;
}
