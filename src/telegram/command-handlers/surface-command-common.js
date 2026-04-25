import {
  getSessionUiLanguage,
  normalizeUiLanguage,
} from "../../i18n/ui-language.js";

export function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}

export function buildInterruptMessage(
  message,
  session,
  interrupted,
  language = getSessionUiLanguage(session),
) {
  void message;
  void session;
  return interrupted
    ? (isEnglish(language)
        ? "Stop requested. I will confirm here when the run actually stops."
        : "Запрос на остановку принял. Подтвержу здесь, когда run реально остановится.")
    : (isEnglish(language)
        ? "There is no active run here right now."
        : "Сейчас тут нет активного run.");
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
