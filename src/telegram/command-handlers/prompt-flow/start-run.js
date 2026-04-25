import {
  DEFAULT_UI_LANGUAGE,
  getSessionUiLanguage,
} from "../../../i18n/ui-language.js";
import { summarizeQueuedPrompt } from "../../../session-manager/prompt-queue.js";
import { renderUserPrompt } from "../../../session-manager/prompt-suffix.js";
import { getTopicIdFromMessage } from "../../../session-manager/session-key.js";
import { buildReplyMessageParams } from "../../command-parsing.js";
import { hasIncomingAttachments } from "../../incoming-attachments.js";
import { safeSendMessage } from "../../topic-delivery.js";
import { buildPurgedSessionMessage } from "../topic-commands.js";
import {
  buildAttachmentNeedsCaptionMessage,
  buildBusyMessage,
  buildCapacityMessage,
  buildExecutionHostUnavailableMessage,
  buildMissingTopicBindingMessage,
  buildNoSessionTopicMessage,
  buildQueueQueuedMessage,
} from "./messages.js";
import { buildPromptFromMessages } from "./prompt-builders.js";
import {
  bufferPendingPromptAttachments,
  clearPendingPromptAttachments,
  collectIncomingAttachments,
  loadPendingPromptAttachments,
} from "./attachments.js";
import { maybeHandleBusyPromptStart } from "./start-steer.js";

const SHUTDOWN_QUEUE_REASONS = new Set(["shutdown", "shutting-down"]);

function shouldQueuePromptForShutdown(started, workerPool) {
  if (SHUTDOWN_QUEUE_REASONS.has(started?.reason)) {
    return true;
  }

  return Boolean(workerPool?.shuttingDown && started && !started.ok);
}

async function startTopicPromptRun({
  api,
  bufferMode = "auto",
  config,
  lifecycleManager = null,
  messages,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  const promptMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const message = promptMessages.at(-1) ?? null;
  if (!message) {
    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "missing-message" };
  }

  const promptStartGuardResult =
    await promptStartGuard?.handleCompetingTopicMessage(message);
  if (promptStartGuardResult?.handled) {
    return { handled: true, reason: promptStartGuardResult.reason };
  }

  const topicId = getTopicIdFromMessage(message);
  if (!topicId) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildNoSessionTopicMessage()),
      null,
      lifecycleManager,
    );
    return { handled: true, reason: "general-topic" };
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
    return { handled: true, reason: "missing-topic-binding" };
  }
  if (await sessionService.isCompacting?.(previewSession)) {
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildBusyMessage(previewSession, getSessionUiLanguage(previewSession)),
      ),
      previewSession,
      lifecycleManager,
    );
    if (delivery.parked) {
      return { handled: true, reason: "topic-unavailable" };
    }

    return { handled: true, reason: "compact-in-progress" };
  }

  const rawPrompt = buildPromptFromMessages(promptMessages, { bufferMode });
  const shouldBuffer = promptFragmentAssembler?.shouldBufferMessage(message, rawPrompt);
  if (shouldBuffer) {
    promptFragmentAssembler.enqueue({
      message,
      flush: buildBufferedPromptFlush({
        api,
        config,
        lifecycleManager,
        promptStartGuard,
        serviceState,
        sessionService,
        workerPool,
      }),
    });
    return { handled: true, reason: "prompt-buffered" };
  }

  if (!rawPrompt) {
    if (promptMessages.some((entry) => hasIncomingAttachments(entry))) {
      const attachmentSession = previewSession ?? null;
      if (attachmentSession) {
        const pendingAttachments = await collectIncomingAttachments({
          api,
          session: attachmentSession,
          sessionService,
          messages: promptMessages,
        });
        await bufferPendingPromptAttachments({
          session: attachmentSession,
          sessionService,
          attachments: pendingAttachments,
        });
      }
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildAttachmentNeedsCaptionMessage(
            attachmentSession
              ? getSessionUiLanguage(attachmentSession)
              : DEFAULT_UI_LANGUAGE,
          ),
        ),
        attachmentSession,
        lifecycleManager,
      );
      return { handled: true, reason: "attachment-without-caption" };
    }

    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "empty-prompt" };
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
    return { handled: true, reason: "purged-session" };
  }

  const effectivePrompt = renderUserPrompt(rawPrompt);
  const pendingAttachments = await loadPendingPromptAttachments({
    session,
    sessionService,
  });
  const incomingAttachments = await collectIncomingAttachments({
    api,
    session,
    sessionService,
    messages: promptMessages,
  });
  const attachments = [...pendingAttachments, ...incomingAttachments];

  const started = await workerPool.startPromptRun({
    session,
    prompt: effectivePrompt,
    rawPrompt,
    message,
    attachments,
  });

  if (!started.ok) {
    if (
      shouldQueuePromptForShutdown(started, workerPool)
      && typeof sessionService.enqueuePromptQueue === "function"
    ) {
      let queued = null;
      try {
        queued = await sessionService.enqueuePromptQueue(session, {
          rawPrompt,
          prompt: effectivePrompt,
          attachments,
          replyToMessageId: Number.isInteger(message.message_id)
            ? message.message_id
            : null,
        });
      } catch {
        // Fall through to the normal shutdown/capacity reply if queue storage is unavailable.
      }

      if (queued) {
        if (attachments.length > 0) {
          await clearPendingPromptAttachments({ session, sessionService });
        }
        const delivery = await safeSendMessage(
          api,
          buildReplyMessageParams(
            message,
            buildQueueQueuedMessage({
              position: queued.position,
              preview: summarizeQueuedPrompt(rawPrompt),
              waitingForCapacity: true,
              language: getSessionUiLanguage(session),
            }),
          ),
          session,
          lifecycleManager,
        );
        return {
          handled: true,
          reason: delivery.parked ? "topic-unavailable" : "prompt-queued",
        };
      }
    }

    if (started.reason === "busy") {
      const busyResult = await maybeHandleBusyPromptStart({
        api,
        effectivePrompt,
        lifecycleManager,
        message,
        rawPrompt,
        session,
        sessionService,
        workerPool,
        attachments,
      });
      if (busyResult) {
        return busyResult;
      }
    }

    await bufferPendingPromptAttachments({
      session,
      sessionService,
      attachments: incomingAttachments,
    });

    const replyText =
      started.reason === "host-unavailable"
        ? buildExecutionHostUnavailableMessage(session, {
            hostId: started.hostId,
            hostLabel: started.hostLabel,
          })
        : started.reason === "busy"
        ? buildBusyMessage(session, getSessionUiLanguage(session))
        : buildCapacityMessage(
            config.maxParallelSessions,
            getSessionUiLanguage(session),
          );
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, replyText),
      session,
      lifecycleManager,
    );
    if (delivery.parked) {
      return { handled: true, reason: "topic-unavailable" };
    }
    return { handled: true, reason: started.reason };
  }

  if (attachments.length > 0) {
    await clearPendingPromptAttachments({ session, sessionService });
  }

  return { handled: true, reason: "prompt-started" };
}

export async function handleTopicPrompt(args) {
  return startTopicPromptRun({
    ...args,
    messages: [args.message],
  });
}

export function buildBufferedPromptFlush({
  api,
  config,
  lifecycleManager,
  promptStartGuard = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  return async (bufferedMessages, flushState = {}) => {
    if (!Array.isArray(bufferedMessages) || bufferedMessages.length === 0) {
      return;
    }

    await startTopicPromptRun({
      api,
      bufferMode: flushState.mode ?? "auto",
      config,
      lifecycleManager,
      messages: bufferedMessages,
      promptStartGuard,
      promptFragmentAssembler: null,
      serviceState,
      sessionService,
      workerPool,
    });
  };
}
