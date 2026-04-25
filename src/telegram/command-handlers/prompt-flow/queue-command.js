import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import { getTopicIdFromMessage } from "../../../session-manager/session-key.js";
import { buildReplyMessageParams } from "../../command-parsing.js";
import { safeSendMessage } from "../../topic-delivery.js";
import {
  buildNoSessionTopicMessage,
  buildQueueDeleteMissingMessage,
  buildQueueDeletedMessage,
  buildQueueStatusMessage,
} from "./messages.js";
import { queueTopicPrompt } from "./queue-prompt.js";

export async function handleQueueCommand({
  api,
  botUsername,
  config,
  lifecycleManager = null,
  message,
  parsedCommand,
  promptStartGuard = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  if (!getTopicIdFromMessage(message)) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildNoSessionTopicMessage()),
      null,
      lifecycleManager,
    );
    return { handled: true, reason: "general-topic", handledSession: null };
  }

  const session = await sessionService.ensureSessionForMessage(message);
  const language = getSessionUiLanguage(session);

  if (parsedCommand.action === "status") {
    const entries = await sessionService.listPromptQueue(session);
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildQueueStatusMessage(entries, language)),
      session,
      lifecycleManager,
    );
    return {
      handled: true,
      reason: delivery.parked ? "topic-unavailable" : "queue-status",
      handledSession: delivery.session || session,
    };
  }

  if (parsedCommand.action === "delete") {
    const deleted = await sessionService.deletePromptQueueEntry(
      session,
      parsedCommand.position,
    );
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        deleted.entry
          ? buildQueueDeletedMessage(
              deleted.entry,
              parsedCommand.position,
              deleted.size,
              language,
            )
          : buildQueueDeleteMissingMessage(parsedCommand.position, language),
      ),
      session,
      lifecycleManager,
    );
    return {
      handled: true,
      reason: delivery.parked ? "topic-unavailable" : "queue-deleted",
      handledSession: delivery.session || session,
    };
  }

  return queueTopicPrompt({
    api,
    botUsername,
    config,
    lifecycleManager,
    messages: [message],
    promptStartGuard,
    queuePromptAssembler,
    serviceState,
    sessionService,
    workerPool,
  });
}
