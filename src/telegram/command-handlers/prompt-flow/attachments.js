import { hasIncomingAttachments } from "../../incoming-attachments.js";

export async function collectIncomingAttachments({
  api,
  session,
  sessionService,
  messages,
}) {
  const attachments = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!hasIncomingAttachments(message)) {
      continue;
    }

    attachments.push(
      ...(await sessionService.ingestIncomingAttachments(api, session, message)),
    );
  }
  return attachments;
}

export async function loadPendingPromptAttachments({
  session,
  sessionService,
  scope = null,
}) {
  if (typeof sessionService.getPendingPromptAttachments !== "function") {
    return [];
  }

  return scope
    ? sessionService.getPendingPromptAttachments(session, { scope })
    : sessionService.getPendingPromptAttachments(session);
}

export async function bufferPendingPromptAttachments({
  session,
  sessionService,
  attachments,
  scope = null,
}) {
  if (
    !Array.isArray(attachments)
    || attachments.length === 0
    || typeof sessionService.bufferPendingPromptAttachments !== "function"
  ) {
    return;
  }

  if (scope) {
    await sessionService.bufferPendingPromptAttachments(session, attachments, { scope });
    return;
  }

  await sessionService.bufferPendingPromptAttachments(session, attachments);
}

export async function clearPendingPromptAttachments({
  session,
  sessionService,
  scope = null,
}) {
  if (typeof sessionService.clearPendingPromptAttachments !== "function") {
    return session;
  }

  return scope
    ? sessionService.clearPendingPromptAttachments(session, { scope })
    : sessionService.clearPendingPromptAttachments(session);
}
