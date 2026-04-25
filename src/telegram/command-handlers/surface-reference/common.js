import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import { maybeFinalizeParkedDelivery } from "../surface-command-common.js";

export async function resolveReferenceSessionAndLanguage({
  generalUiLanguage,
  message,
  sessionService,
  topicId = null,
}) {
  const handledSession = topicId
    ? await sessionService.ensureSessionForMessage(message)
    : null;
  const language = handledSession
    ? getSessionUiLanguage(handledSession)
    : generalUiLanguage;

  return { handledSession, language };
}

export async function maybeFinalizeReferenceParkedDelivery({
  commandName,
  delivery,
  handledSession,
  markCommandHandled,
  serviceState,
  sessionService,
}) {
  return maybeFinalizeParkedDelivery({
    commandName,
    delivery,
    handledSession,
    markCommandHandled,
    serviceState,
    sessionService,
  });
}
