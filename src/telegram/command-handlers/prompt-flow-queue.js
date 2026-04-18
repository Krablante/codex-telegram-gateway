import { getSessionUiLanguage } from "../../i18n/ui-language.js";
import { composePromptWithSuffixes } from "../../session-manager/prompt-suffix.js";
import { summarizeQueuedPrompt } from "../../session-manager/prompt-queue.js";
import { buildReplyMessageParams } from "../command-parsing.js";
import { hasIncomingAttachments } from "../incoming-attachments.js";
import { safeSendMessage } from "../topic-delivery.js";
import { getTopicIdFromMessage } from "../../session-manager/session-key.js";
import { buildPurgedSessionMessage } from "./topic-commands.js";
import {
  buildNoSessionTopicMessage,
  buildPromptFromMessages,
  buildQueueAttachmentNeedsPromptMessage,
  buildQueueAutoUnavailableMessage,
  buildQueueDeleteMissingMessage,
  buildQueueDeletedMessage,
  buildQueuedPromptFromMessages,
  buildQueueQueuedMessage,
  buildQueueStatusMessage,
  buildQueueUsageMessage,
} from "./prompt-flow-common.js";

function buildBufferedQueueFlush({
  api,
  botUsername,
  config,
  lifecycleManager,
  promptStartGuard = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  return async (bufferedMessages) => {
    if (!Array.isArray(bufferedMessages) || bufferedMessages.length === 0) {
      return;
    }

    await queueTopicPrompt({
      api,
      botUsername,
      config,
      lifecycleManager,
      messages: bufferedMessages,
      promptStartGuard,
      queuePromptAssembler: null,
      serviceState,
      sessionService,
      workerPool,
    });
  };
}

async function queueTopicPrompt({
  api,
  botUsername,
  config,
  lifecycleManager = null,
  messages,
  promptStartGuard = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  const promptMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const message = promptMessages.at(-1) ?? null;
  if (!message) {
    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "missing-message", handledSession: null };
  }

  const promptStartGuardResult =
    await promptStartGuard?.handleCompetingTopicMessage(message);
  if (promptStartGuardResult?.handled) {
    return {
      handled: true,
      reason: promptStartGuardResult.reason,
      handledSession: null,
    };
  }

  const topicId = getTopicIdFromMessage(message);
  if (!topicId) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildNoSessionTopicMessage()),
      null,
      lifecycleManager,
    );
    return { handled: true, reason: "general-topic", handledSession: null };
  }

  let session = await sessionService.ensureRunnableSessionForMessage(message);
  if (session?.lifecycle_state === "purged") {
    await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildPurgedSessionMessage(session, getSessionUiLanguage(session)),
      ),
      session,
      lifecycleManager,
    );
    return {
      handled: true,
      reason: "purged-session",
      handledSession: session,
    };
  }
  if (config.omniEnabled !== false && session.auto_mode?.enabled) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildQueueAutoUnavailableMessage(getSessionUiLanguage(session)),
      ),
      session,
      lifecycleManager,
    );
    return {
      handled: true,
      reason: "queue-auto-disabled",
      handledSession: session,
    };
  }

  const rawPrompt = buildQueuedPromptFromMessages(promptMessages, botUsername);
  const shouldBuffer =
    queuePromptAssembler?.shouldBufferMessage(message, rawPrompt);
  if (shouldBuffer) {
    queuePromptAssembler.enqueue({
      message,
      flush: buildBufferedQueueFlush({
        api,
        botUsername,
        config,
        lifecycleManager,
        promptStartGuard,
        queuePromptAssembler,
        serviceState,
        sessionService,
        workerPool,
      }),
    });
    return {
      handled: true,
      reason: "queue-buffered",
      handledSession: session,
    };
  }

  if (!rawPrompt) {
    if (promptMessages.some((entry) => hasIncomingAttachments(entry))) {
      const pendingAttachments = [];
      for (const promptMessage of promptMessages) {
        if (!hasIncomingAttachments(promptMessage)) {
          continue;
        }

        pendingAttachments.push(
          ...(await sessionService.ingestIncomingAttachments(
            api,
            session,
            promptMessage,
          )),
        );
      }

      if (
        pendingAttachments.length > 0 &&
        typeof sessionService.bufferPendingPromptAttachments === "function"
      ) {
        await sessionService.bufferPendingPromptAttachments(
          session,
          pendingAttachments,
          { scope: "queue" },
        );
      }
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildQueueAttachmentNeedsPromptMessage(getSessionUiLanguage(session)),
        ),
        session,
        lifecycleManager,
      );
      return {
        handled: true,
        reason: "queue-attachment-without-prompt",
        handledSession: session,
      };
    }

    await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildQueueUsageMessage(getSessionUiLanguage(session)),
      ),
      session,
      lifecycleManager,
    );
    return {
      handled: true,
      reason: "queue-usage",
      handledSession: session,
    };
  }

  const globalPromptSuffix =
    typeof sessionService.getGlobalPromptSuffix === "function"
      ? await sessionService.getGlobalPromptSuffix()
      : null;
  const effectivePrompt = composePromptWithSuffixes(
    rawPrompt,
    session,
    globalPromptSuffix,
  );
  const attachments =
    typeof sessionService.getPendingPromptAttachments === "function"
      ? await sessionService.getPendingPromptAttachments(session, {
          scope: "queue",
        })
      : [];
  for (const promptMessage of promptMessages) {
    if (!hasIncomingAttachments(promptMessage)) {
      continue;
    }

    attachments.push(
      ...(await sessionService.ingestIncomingAttachments(
        api,
        session,
        promptMessage,
      )),
    );
  }

  const queued = await sessionService.enqueuePromptQueue(session, {
    rawPrompt,
    prompt: effectivePrompt,
    attachments,
    replyToMessageId: Number.isInteger(message.message_id) ? message.message_id : null,
  });

  if (
    attachments.length > 0 &&
    typeof sessionService.clearPendingPromptAttachments === "function"
  ) {
    session = await sessionService.clearPendingPromptAttachments(session, {
      scope: "queue",
    });
  }

  if (
    queued.position === 1 &&
    typeof sessionService.drainPromptQueue === "function"
  ) {
    const drainResults = await sessionService.drainPromptQueue(workerPool, {
      session,
    });
    const drainResult = drainResults.find(
      (entry) => entry.sessionKey === session.session_key,
    );
    if (drainResult?.result?.reason === "prompt-started") {
      return {
        handled: true,
        reason: "prompt-started",
        handledSession: session,
      };
    }
  }

  const delivery = await safeSendMessage(
    api,
    buildReplyMessageParams(
      message,
      buildQueueQueuedMessage({
        position: queued.position,
        preview: summarizeQueuedPrompt(rawPrompt),
        waitingForCapacity:
          queued.position === 1 &&
          !(typeof workerPool.getActiveRun === "function"
            && workerPool.getActiveRun(session.session_key)),
        language: getSessionUiLanguage(session),
      }),
    ),
    session,
    lifecycleManager,
  );
  if (delivery.parked) {
    return {
      handled: true,
      reason: "topic-unavailable",
      handledSession: delivery.session || session,
    };
  }

  return {
    handled: true,
    reason: "prompt-queued",
    handledSession: session,
  };
}

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
