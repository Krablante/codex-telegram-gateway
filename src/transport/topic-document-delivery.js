import fs from "node:fs/promises";

const TELEGRAM_FILE_SOFT_LIMIT_BYTES = 45 * 1024 * 1024;
export const TELEGRAM_DOCUMENT_CAPTION_LIMIT_CHARS = 1024;

function normalizeDocumentCaption(value) {
  const caption = typeof value === "string" ? value.trim() : "";
  if (!caption) {
    return undefined;
  }

  if (caption.length <= TELEGRAM_DOCUMENT_CAPTION_LIMIT_CHARS) {
    return caption;
  }

  return caption.slice(0, TELEGRAM_DOCUMENT_CAPTION_LIMIT_CHARS - 1).trimEnd() + "…";
}

export async function deliverDocumentToTopic({
  api,
  chatId,
  messageThreadId,
  replyToMessageId = null,
  document,
}) {
  const stats = await fs.stat(document.filePath);
  if (!stats.isFile()) {
    throw new Error(`Path is not a regular file: ${document.filePath}`);
  }

  if (stats.size > TELEGRAM_FILE_SOFT_LIMIT_BYTES) {
    return {
      delivered: false,
      reason: "too-large",
      sizeBytes: stats.size,
    };
  }

  const params = {
    chat_id: chatId,
    message_thread_id: messageThreadId,
    caption: normalizeDocumentCaption(document.caption),
    document: {
      filePath: document.filePath,
      fileName: document.fileName,
      contentType: document.contentType,
    },
  };
  if (replyToMessageId) {
    params.reply_to_message_id = replyToMessageId;
  }

  await api.sendDocument(params);
  return {
    delivered: true,
    sizeBytes: stats.size,
  };
}
