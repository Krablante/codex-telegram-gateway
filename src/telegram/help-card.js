import { fileURLToPath } from "node:url";

import { normalizeUiLanguage } from "../i18n/ui-language.js";

const HELP_CARD_ASSETS = {
  rus: [
    {
      filePath: fileURLToPath(
        new URL("../../assets/help/telegram-help-card-rus-1.png", import.meta.url),
      ),
      fileName: "severus-help-summer-rus-1.png",
    },
    {
      filePath: fileURLToPath(
        new URL("../../assets/help/telegram-help-card-rus-2.png", import.meta.url),
      ),
      fileName: "severus-help-summer-rus-2.png",
    },
  ],
  eng: [
    {
      filePath: fileURLToPath(
        new URL("../../assets/help/telegram-help-card-eng-1.png", import.meta.url),
      ),
      fileName: "severus-help-summer-eng-1.png",
    },
    {
      filePath: fileURLToPath(
        new URL("../../assets/help/telegram-help-card-eng-2.png", import.meta.url),
      ),
      fileName: "severus-help-summer-eng-2.png",
    },
  ],
};

export function getHelpCardAssets(language) {
  return HELP_CARD_ASSETS[normalizeUiLanguage(language)] || HELP_CARD_ASSETS.rus;
}
