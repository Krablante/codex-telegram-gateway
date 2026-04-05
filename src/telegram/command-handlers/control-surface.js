import {
  DEFAULT_UI_LANGUAGE,
  normalizeUiLanguage,
} from "../../i18n/ui-language.js";
import { buildReplyMessageParams } from "../command-parsing.js";
import { clearTrackedGeneralMessages } from "../general-message-cleanup.js";
import {
  handleGlobalControlCommand,
  isGeneralForumMessage,
} from "../global-control-panel.js";
import { safeSendMessage } from "../topic-delivery.js";

function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}

export async function resolveGeneralUiLanguage(globalControlPanelStore = null) {
  if (!globalControlPanelStore) {
    return DEFAULT_UI_LANGUAGE;
  }

  try {
    const state = await globalControlPanelStore.load({ force: true });
    return normalizeUiLanguage(state?.ui_language);
  } catch {
    return DEFAULT_UI_LANGUAGE;
  }
}

function buildClearGeneralOnlyMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "/clear works in General only.",
      "",
      "Run it there to keep only the active General menu.",
    ].join("\n");
  }

  return [
    "/clear работает только в General.",
    "",
    "Запусти его там, чтобы оставить только активное General menu.",
  ].join("\n");
}

function buildClearFailedMessage(language = DEFAULT_UI_LANGUAGE, failedCount = 0) {
  if (isEnglish(language)) {
    return failedCount > 0
      ? `General cleanup finished with ${failedCount} undeleted message(s).`
      : "General cleanup could not run right now.";
  }

  return failedCount > 0
    ? `General cleanup завершился с ${failedCount} неудалёнными сообщениями.`
    : "Сейчас не смог выполнить General cleanup.";
}

export async function handleClearCommand({
  api,
  config,
  lifecycleManager = null,
  message,
  globalControlPanelStore = null,
  generalMessageLedgerStore = null,
  promptFragmentAssembler = null,
  sessionService,
  language,
  refreshGeneralMenu,
}) {
  const inGeneralTopic = isGeneralForumMessage(message, config);

  if (!inGeneralTopic) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildClearGeneralOnlyMessage(language),
      ),
      null,
      lifecycleManager,
    );
    return { reason: "clear-general-only" };
  }

  if (!globalControlPanelStore || !generalMessageLedgerStore) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildClearFailedMessage(language)),
      null,
      lifecycleManager,
    );
    return { reason: "clear-unavailable" };
  }

  const existingControlState = await globalControlPanelStore.load({ force: true });

  await (refreshGeneralMenu ?? handleGlobalControlCommand)({
    activeScreen: existingControlState.active_screen,
    api,
    config,
    globalControlPanelStore,
    message,
    promptFragmentAssembler,
    sessionService,
  });
  const controlState = await globalControlPanelStore.load({ force: true });
  const preservedMessageId = controlState.menu_message_id;

  if (!Number.isInteger(preservedMessageId) || preservedMessageId <= 0) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildClearFailedMessage(language)),
      null,
      lifecycleManager,
    );
    return { reason: "clear-menu-missing" };
  }

  const cleanupResult = await clearTrackedGeneralMessages({
    api,
    chatId: message.chat.id,
    generalMessageLedgerStore,
    preservedMessageIds: [preservedMessageId],
  });

  if (cleanupResult.failedMessageIds.length > 0) {
    await safeSendMessage(
      api,
      {
        chat_id: message.chat.id,
        text: buildClearFailedMessage(
          language,
          cleanupResult.failedMessageIds.length,
        ),
      },
      null,
      lifecycleManager,
    );
  }

  return { reason: "clear-complete" };
}
