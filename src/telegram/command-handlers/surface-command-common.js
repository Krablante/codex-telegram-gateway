import {
  getSessionUiLanguage,
  normalizeUiLanguage,
} from "../../i18n/ui-language.js";
import { getTopicLabel } from "../command-parsing.js";

export function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}

export function buildInterruptMessage(
  message,
  session,
  interrupted,
  language = getSessionUiLanguage(session),
) {
  return [
    interrupted
      ? (isEnglish(language) ? "Stopping the run." : "Останавливаю run.")
      : (isEnglish(language)
          ? "There is no active run here right now."
          : "Сейчас тут нет активного run."),
    "",
    `session_key: ${session.session_key}`,
    `chat_id: ${message.chat.id}`,
    `topic_id: ${getTopicLabel(message)}`,
  ].join("\n");
}

export async function finalizeHandledCommand({
  commandName,
  handledSession = null,
  markCommandHandled,
  reason = null,
  serviceState,
  sessionService,
}) {
  if (handledSession) {
    await sessionService.recordHandledSession(
      serviceState,
      handledSession,
      commandName,
    );
  }
  markCommandHandled(serviceState, commandName);
  return {
    handled: true,
    command: commandName,
    ...(reason ? { reason } : {}),
  };
}

export async function maybeFinalizeParkedDelivery({
  commandName,
  delivery,
  handledSession = null,
  markCommandHandled,
  serviceState,
  sessionService,
}) {
  if (!delivery?.parked) {
    return null;
  }

  return finalizeHandledCommand({
    commandName,
    handledSession: delivery.session || handledSession,
    markCommandHandled,
    reason: "topic-unavailable",
    serviceState,
    sessionService,
  });
}
