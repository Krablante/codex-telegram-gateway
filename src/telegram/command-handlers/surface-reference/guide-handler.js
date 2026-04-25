import { buildReplyMessageParams } from "../../command-parsing.js";
import { getGuidebookAsset } from "../../guidebook.js";
import {
  safeSendDocumentToTopic,
  safeSendMessage,
} from "../../topic-delivery.js";
import { finalizeHandledCommand } from "../surface-command-common.js";
import { maybeFinalizeReferenceParkedDelivery, resolveReferenceSessionAndLanguage } from "./common.js";
import {
  buildGuideDeliveryFailureMessage,
  buildGuideGenerationFailureMessage,
  buildGuideGeneralOnlyMessage,
} from "./messages.js";

export async function handleGuideReferenceCommand({
  api,
  command,
  config,
  generalUiLanguage,
  lifecycleManager = null,
  markCommandHandled,
  message,
  serviceState,
  sessionService,
  topicId = null,
}) {
  const { handledSession, language } = await resolveReferenceSessionAndLanguage({
    generalUiLanguage,
    message,
    sessionService,
    topicId,
  });
  const inGeneralTopic =
    !topicId
    && String(message.chat?.id ?? "") === String(config.telegramForumChatId ?? "");

  if (!inGeneralTopic) {
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildGuideGeneralOnlyMessage(language)),
      handledSession,
      lifecycleManager,
    );
    const parkedResult = await maybeFinalizeReferenceParkedDelivery({
      commandName: command.name,
      delivery,
      handledSession,
      markCommandHandled,
      reason: "guide-general-only",
      serviceState,
      sessionService,
    });
    if (parkedResult) {
      return parkedResult;
    }

    return finalizeHandledCommand({
      commandName: command.name,
      handledSession,
      markCommandHandled,
      reason: "guide-general-only",
      serviceState,
      sessionService,
    });
  }

  try {
    const guidebook = await getGuidebookAsset(language, {
      stateRoot: config.stateRoot,
    });
    const delivery = await safeSendDocumentToTopic(
      api,
      message,
      guidebook,
      handledSession,
      lifecycleManager,
    );
    const parkedResult = await maybeFinalizeReferenceParkedDelivery({
      commandName: command.name,
      delivery,
      handledSession,
      markCommandHandled,
      serviceState,
      sessionService,
    });
    if (parkedResult?.reason === "topic-unavailable") {
      return parkedResult;
    }
    if (!delivery?.delivered) {
      const failureDelivery = await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildGuideDeliveryFailureMessage(language, delivery),
        ),
        handledSession,
        lifecycleManager,
      );
      const failureParkedResult = await maybeFinalizeReferenceParkedDelivery({
        commandName: command.name,
        delivery: failureDelivery,
        handledSession,
        markCommandHandled,
        serviceState,
        sessionService,
      });
      if (failureParkedResult) {
        return failureParkedResult;
      }
    }
  } catch (error) {
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildGuideGenerationFailureMessage(language, error),
      ),
      handledSession,
      lifecycleManager,
    );
    const parkedResult = await maybeFinalizeReferenceParkedDelivery({
      commandName: command.name,
      delivery,
      handledSession,
      markCommandHandled,
      serviceState,
      sessionService,
    });
    if (parkedResult) {
      return parkedResult;
    }
  }

  return finalizeHandledCommand({
    commandName: command.name,
    handledSession,
    markCommandHandled,
    serviceState,
    sessionService,
  });
}
