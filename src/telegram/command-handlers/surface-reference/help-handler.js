import { buildReplyMessageParams } from "../../command-parsing.js";
import { getHelpCardAssets } from "../../help-card.js";
import {
  safeSendDocumentToTopic,
  safeSendMessage,
} from "../../topic-delivery.js";
import { buildPromptSuffixHelpMessage } from "../topic-commands.js";
import { finalizeHandledCommand } from "../surface-command-common.js";
import { maybeFinalizeReferenceParkedDelivery, resolveReferenceSessionAndLanguage } from "./common.js";
import {
  buildHelpCardPartialFailureMessage,
  buildHelpTextMessage,
} from "./messages.js";

export async function handleHelpReferenceCommand({
  api,
  command,
  generalUiLanguage,
  lifecycleManager = null,
  markCommandHandled,
  message,
  serviceState,
  sessionService,
  suffixCommand = null,
  topicId = null,
}) {
  const isSuffixHelpCommand =
    command.name === "suffix" && suffixCommand?.scope === "help";
  const { handledSession, language } = await resolveReferenceSessionAndLanguage({
    generalUiLanguage,
    message,
    sessionService,
    topicId,
  });

  if (isSuffixHelpCommand) {
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildPromptSuffixHelpMessage(language)),
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
    return finalizeHandledCommand({
      commandName: command.name,
      handledSession,
      markCommandHandled,
      serviceState,
      sessionService,
      reason: "suffix-help",
    });
  }

  const helpCards = getHelpCardAssets(language);
  let deliveredPages = 0;
  try {
    for (const helpCard of helpCards) {
      const delivery = await safeSendDocumentToTopic(
        api,
        message,
        {
          filePath: helpCard.filePath,
          fileName: helpCard.fileName,
          contentType: "image/png",
        },
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
        throw new Error(delivery?.reason || "help-card-delivery-failed");
      }
      deliveredPages += 1;
    }
  } catch {
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        deliveredPages > 0
          ? buildHelpCardPartialFailureMessage(language)
          : buildHelpTextMessage(language),
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
