import fs from "node:fs/promises";
import path from "node:path";

import { cloneJson } from "../state/file-utils.js";
import { ingestIncomingAttachments } from "../telegram/incoming-attachments.js";

const DEFAULT_PENDING_PROMPT_ATTACHMENT_TTL_MS = 15 * 60 * 1000;

function resolvePendingAttachmentFieldNames(scope = "prompt") {
  return scope === "queue"
    ? {
        attachments: "pending_queue_attachments",
        expiresAt: "pending_queue_attachments_expires_at",
      }
    : {
        attachments: "pending_prompt_attachments",
        expiresAt: "pending_prompt_attachments_expires_at",
      };
}

function normalizePendingPromptAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .filter((attachment) => attachment && typeof attachment === "object")
    .map((attachment) => cloneJson(attachment));
}

function readPendingPromptAttachmentsState(sessionLike, scope = "prompt") {
  const fields = resolvePendingAttachmentFieldNames(scope);
  const attachments = normalizePendingPromptAttachments(sessionLike?.[fields.attachments]);
  const expiresAt =
    typeof sessionLike?.[fields.expiresAt] === "string"
    && sessionLike[fields.expiresAt].trim()
      ? sessionLike[fields.expiresAt]
      : null;
  if (!expiresAt || attachments.length === 0) {
    return {
      attachments: [],
      expiresAt: null,
      expired: false,
    };
  }

  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return {
      attachments: [],
      expiresAt: null,
      expired: attachments.length > 0,
    };
  }

  if (expiresAtMs <= Date.now()) {
    return {
      attachments: [],
      expiresAt,
      expired: attachments.length > 0,
    };
  }

  return {
    attachments,
    expiresAt,
    expired: false,
  };
}

function isPathInsideRoot(targetPath, rootPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return (
    relativePath === ""
    || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

async function removeExpiredPendingAttachmentFiles(sessionStore, session, attachments) {
  if (typeof sessionStore?.getSessionDir !== "function") {
    return;
  }

  const sessionDir = sessionStore.getSessionDir(session.chat_id, session.topic_id);
  const incomingDir = path.join(sessionDir, "incoming");
  for (const attachment of attachments) {
    const filePath = typeof attachment?.file_path === "string"
      ? attachment.file_path
      : typeof attachment?.relative_path === "string"
        ? path.join(sessionDir, attachment.relative_path)
        : null;
    if (!filePath) {
      continue;
    }

    const resolvedPath = path.resolve(filePath);
    if (!isPathInsideRoot(resolvedPath, incomingDir)) {
      continue;
    }
    await fs.rm(resolvedPath, { force: true }).catch(() => {});
  }
}

async function loadCurrentSession(sessionStore, session) {
  return (await sessionStore.load(session.chat_id, session.topic_id)) || session;
}

export class SessionAttachmentService {
  constructor({ sessionStore }) {
    this.sessionStore = sessionStore;
  }

  async ingestIncomingAttachments(api, session, message) {
    return ingestIncomingAttachments({
      api,
      message,
      session,
      sessionStore: this.sessionStore,
    });
  }

  async bufferPendingPromptAttachments(
    session,
    attachments,
    {
      scope = "prompt",
      ttlMs = DEFAULT_PENDING_PROMPT_ATTACHMENT_TTL_MS,
    } = {},
  ) {
    const fields = resolvePendingAttachmentFieldNames(scope);
    const normalizedAttachments = normalizePendingPromptAttachments(attachments);
    return this.sessionStore.patchWithCurrent(session, (current) => {
      const pendingState = readPendingPromptAttachmentsState(current, scope);
      const nextAttachments = [
        ...pendingState.attachments,
        ...normalizedAttachments,
      ];
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();

      return {
        [fields.attachments]: nextAttachments,
        [fields.expiresAt]: nextAttachments.length > 0 ? expiresAt : null,
      };
    });
  }

  async getPendingPromptAttachments(session, { scope = "prompt" } = {}) {
    const current = await loadCurrentSession(this.sessionStore, session);
    const pendingState = readPendingPromptAttachmentsState(current, scope);
    if (!pendingState.expired) {
      return pendingState.attachments;
    }

    const fields = resolvePendingAttachmentFieldNames(scope);
    await removeExpiredPendingAttachmentFiles(
      this.sessionStore,
      current,
      normalizePendingPromptAttachments(current?.[fields.attachments]),
    );
    await this.sessionStore.patch(current, {
      [fields.attachments]: [],
      [fields.expiresAt]: null,
    });
    return [];
  }

  async clearPendingPromptAttachments(session, { scope = "prompt" } = {}) {
    const current = await loadCurrentSession(this.sessionStore, session);
    const fields = resolvePendingAttachmentFieldNames(scope);
    return this.sessionStore.patch(current, {
      [fields.attachments]: [],
      [fields.expiresAt]: null,
    });
  }
}
