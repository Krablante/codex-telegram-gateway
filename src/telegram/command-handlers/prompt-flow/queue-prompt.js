import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import { renderUserPrompt } from "../../../session-manager/prompt-suffix.js";
import { summarizeQueuedPrompt } from "../../../session-manager/prompt-queue.js";
import { getTopicIdFromMessage } from "../../../session-manager/session-key.js";
import { buildReplyMessageParams } from "../../command-parsing.js";
import { hasIncomingAttachments } from "../../incoming-attachments.js";
import { safeSendMessage } from "../../topic-delivery.js";
import { buildPurgedSessionMessage } from "../topic-commands.js";
import {
  buildExecutionHostUnavailableMessage,
  buildMissingTopicBindingMessage,
  buildNoSessionTopicMessage,
  buildQueueAttachmentNeedsPromptMessage,
  buildQueueQueuedMessage,
  buildQueueUsageMessage,
} from "./messages.js";
import { buildQueuedPromptFromMessages } from "./prompt-builders.js";
import {
  bufferPendingPromptAttachments,
  clearPendingPromptAttachments,
  collectIncomingAttachments,
  loadPendingPromptAttachments,
} from "./attachments.js";

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
  void config;
  void queuePromptAssembler;
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

export async function queueTopicPrompt({
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
  void config;
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

  const previewSession =
    typeof sessionService.ensureSessionForMessage === "function"
      ? await sessionService.ensureSessionForMessage(message)
      : await sessionService.ensureRunnableSessionForMessage(message);
  if (
    previewSession?.created_via === "topic/implicit-attach"
    && !previewSession.execution_host_id
  ) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildMissingTopicBindingMessage(getSessionUiLanguage(previewSession)),
      ),
      previewSession,
      lifecycleManager,
    );
    return {
      handled: true,
      reason: "missing-topic-binding",
      handledSession: previewSession,
    };
  }

  const rawPrompt = buildQueuedPromptFromMessages(promptMessages, botUsername);
  const shouldBuffer = queuePromptAssembler?.shouldBufferMessage(message, rawPrompt);
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
      handledSession: previewSession,
    };
  }

  if (!rawPrompt) {
    if (promptMessages.some((entry) => hasIncomingAttachments(entry))) {
      if (previewSession) {
        const pendingAttachments = await collectIncomingAttachments({
          api,
          session: previewSession,
          sessionService,
          messages: promptMessages,
        });
        await bufferPendingPromptAttachments({
          session: previewSession,
          sessionService,
          attachments: pendingAttachments,
          scope: "queue",
        });
      }
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildQueueAttachmentNeedsPromptMessage(getSessionUiLanguage(previewSession)),
        ),
        previewSession,
        lifecycleManager,
      );
      return {
        handled: true,
        reason: "queue-attachment-without-prompt",
        handledSession: previewSession,
      };
    }

    await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildQueueUsageMessage(getSessionUiLanguage(previewSession)),
      ),
      previewSession,
      lifecycleManager,
    );
    return {
      handled: true,
      reason: "queue-usage",
      handledSession: previewSession,
    };
  }

  let session = previewSession;
  if (
    (!session || session.lifecycle_state !== "active")
    && typeof sessionService.ensureRunnableSessionForMessage === "function"
  ) {
    session = await sessionService.ensureRunnableSessionForMessage(message);
  }
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

  const effectivePrompt = renderUserPrompt(rawPrompt);
  const attachments = await loadPendingPromptAttachments({
    session,
    sessionService,
    scope: "queue",
  });
  attachments.push(
    ...(await collectIncomingAttachments({
      api,
      session,
      sessionService,
      messages: promptMessages,
    })),
  );

  const queued = await sessionService.enqueuePromptQueue(session, {
    rawPrompt,
    prompt: effectivePrompt,
    attachments,
    replyToMessageId: Number.isInteger(message.message_id) ? message.message_id : null,
  });

  if (attachments.length > 0) {
    session = await clearPendingPromptAttachments({
      session,
      sessionService,
      scope: "queue",
    });
  }

  if (
    queued.position === 1
    && typeof sessionService.drainPromptQueue === "function"
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
    if (drainResult?.result?.reason === "host-unavailable") {
      const delivery = await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildExecutionHostUnavailableMessage(
            session,
            {
              hostId: drainResult?.result?.hostId ?? session.execution_host_id,
              hostLabel: drainResult?.result?.hostLabel ?? session.execution_host_label,
            },
            getSessionUiLanguage(session),
          ),
        ),
        session,
        lifecycleManager,
      );
      return {
        handled: true,
        reason: "host-unavailable",
        handledSession: delivery.session || session,
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
          queued.position === 1
          && !(typeof workerPool.getActiveRun === "function"
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
