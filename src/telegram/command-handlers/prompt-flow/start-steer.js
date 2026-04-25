import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import { buildReplyMessageParams } from "../../command-parsing.js";
import { safeSendMessage } from "../../topic-delivery.js";
import {
  buildSteerAcceptedMessage,
  buildSteerDeferredMessage,
} from "./messages.js";
import { clearPendingPromptAttachments } from "./attachments.js";

const STEER_QUEUE_FALLBACK_REASONS = new Set([
  "idle",
  "finalizing",
  "steer-failed",
  "steer-timeout",
  "steer-unavailable",
  "transport-recovering",
]);

async function maybeQueueDeferredSteerPrompt({
  api,
  effectivePrompt,
  lifecycleManager,
  message,
  rawPrompt,
  session,
  sessionService,
  workerPool,
  attachments = [],
  steerReason = null,
}) {
  if (
    !STEER_QUEUE_FALLBACK_REASONS.has(steerReason)
    || typeof sessionService.enqueuePromptQueue !== "function"
  ) {
    return null;
  }

  const queued = await sessionService.enqueuePromptQueue(session, {
    rawPrompt,
    prompt: effectivePrompt,
    attachments,
    replyToMessageId: Number.isInteger(message?.message_id) ? message.message_id : null,
  });

  if (attachments.length > 0) {
    session = await clearPendingPromptAttachments({ session, sessionService });
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
      return { handled: true, reason: "prompt-started" };
    }
  }

  const delivery = await safeSendMessage(
    api,
    buildReplyMessageParams(
      message,
      buildSteerDeferredMessage({
        position: queued.position,
        preview: rawPrompt,
        language: getSessionUiLanguage(session),
      }),
    ),
    session,
    lifecycleManager,
  );
  if (delivery.parked) {
    return { handled: true, reason: "topic-unavailable" };
  }

  return { handled: true, reason: "steer-deferred" };
}

export async function maybeHandleBusyPromptStart({
  api,
  effectivePrompt,
  lifecycleManager,
  message,
  rawPrompt,
  session,
  sessionService,
  workerPool,
  attachments,
}) {
  if (typeof workerPool.steerActiveRun !== "function") {
    return null;
  }

  const steered = await workerPool.steerActiveRun({
    session,
    rawPrompt,
    message,
    attachments,
  });
  if (steered.ok) {
    if (attachments.length > 0) {
      session = await clearPendingPromptAttachments({ session, sessionService });
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

  return maybeQueueDeferredSteerPrompt({
    api,
    effectivePrompt,
    lifecycleManager,
    message,
    rawPrompt,
    session,
    sessionService,
    workerPool,
    attachments,
    steerReason: steered.reason || null,
  });
}
