import {
  getSessionUiLanguage,
  DEFAULT_UI_LANGUAGE,
} from "../../i18n/ui-language.js";
import {
  canAutoModeAcceptPromptFromMessage,
  isAutoModeHumanInputLocked,
} from "../../session-manager/auto-mode.js";
import { composePromptWithSuffixes } from "../../session-manager/prompt-suffix.js";
import { buildReplyMessageParams } from "../command-parsing.js";
import { hasIncomingAttachments } from "../incoming-attachments.js";
import { safeSendMessage } from "../topic-delivery.js";
import { getTopicIdFromMessage } from "../../session-manager/session-key.js";
import {
  buildAttachmentNeedsCaptionMessage,
  buildBusyMessage,
  buildCapacityMessage,
  buildNoSessionTopicMessage,
  buildPromptFromMessages,
  buildSteerAcceptedMessage,
} from "./prompt-flow-common.js";

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

  const lockedSession = await sessionService.ensureRunnableSessionForMessage(message);
  if (
    config.omniEnabled !== false &&
    isAutoModeHumanInputLocked(lockedSession) &&
    !canAutoModeAcceptPromptFromMessage(lockedSession, message)
  ) {
    return { handled: true, reason: "auto-topic-human-input-blocked" };
  }

  const rawPrompt = buildPromptFromMessages(promptMessages, { bufferMode });
  const shouldBuffer =
    !message?.is_internal_omni_handoff &&
    promptFragmentAssembler?.shouldBufferMessage(message, rawPrompt);
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
      const attachmentSession =
        typeof sessionService.ensureSessionForMessage === "function"
          ? await sessionService.ensureSessionForMessage(message)
          : null;
      if (attachmentSession) {
        const pendingAttachments = [];
        for (const promptMessage of promptMessages) {
          if (!hasIncomingAttachments(promptMessage)) {
            continue;
          }

          pendingAttachments.push(
            ...(await sessionService.ingestIncomingAttachments(
              api,
              attachmentSession,
              promptMessage,
            )),
          );
        }

        if (
          pendingAttachments.length > 0 &&
          typeof sessionService.bufferPendingPromptAttachments === "function"
        ) {
          await sessionService.bufferPendingPromptAttachments(
            attachmentSession,
            pendingAttachments,
          );
        }
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

  let session = lockedSession;
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
      ? await sessionService.getPendingPromptAttachments(session)
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
  const started = await workerPool.startPromptRun({
    session,
    prompt: effectivePrompt,
    rawPrompt,
    message,
    attachments,
  });

  if (!started.ok) {
    if (
      started.reason === "busy" &&
      typeof workerPool.steerActiveRun === "function"
    ) {
      const steered = await workerPool.steerActiveRun({
        session,
        rawPrompt,
        message,
        attachments,
      });
      if (steered.ok) {
        if (
          attachments.length > 0 &&
          typeof sessionService.clearPendingPromptAttachments === "function"
        ) {
          session = await sessionService.clearPendingPromptAttachments(session);
        }
        const delivery = await safeSendMessage(
          api,
          buildReplyMessageParams(
            message,
            buildSteerAcceptedMessage(getSessionUiLanguage(session)),
          ),
          session,
          lifecycleManager,
        );
        if (delivery.parked) {
          return { handled: true, reason: "topic-unavailable" };
        }
        return { handled: true, reason: steered.reason || "steered" };
      }
    }

    const replyText =
      started.reason === "busy"
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

  if (
    attachments.length > 0 &&
    typeof sessionService.clearPendingPromptAttachments === "function"
  ) {
    await sessionService.clearPendingPromptAttachments(session);
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
