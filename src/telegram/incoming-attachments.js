import fs from "node:fs/promises";
import path from "node:path";

import { getSessionUiLanguage } from "../i18n/ui-language.js";

const TELEGRAM_DOWNLOAD_SOFT_LIMIT_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
]);

function sanitizeFileName(fileName) {
  const baseName = path.basename(String(fileName || "").trim());
  const sanitized = baseName.replace(/[^a-z0-9._-]+/giu, "-");
  return sanitized || "attachment";
}

function inferDocumentIsImage(document) {
  const mimeType = String(document?.mime_type || "").toLowerCase();
  if (mimeType.startsWith("image/")) {
    return true;
  }

  const extension = path.extname(document?.file_name || "").toLowerCase();
  return IMAGE_EXTENSIONS.has(extension);
}

function buildPhotoSpec(message) {
  if (!Array.isArray(message?.photo) || message.photo.length === 0) {
    return null;
  }

  const picked = [...message.photo].sort(
    (left, right) => (left.file_size ?? 0) - (right.file_size ?? 0),
  ).at(-1);
  if (!picked?.file_id) {
    return null;
  }

  return {
    kind: "photo",
    fileId: picked.file_id,
    fileUniqueId: picked.file_unique_id || picked.file_id,
    originalFileName: `photo-${picked.file_unique_id || picked.file_id}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: picked.file_size ?? null,
    isImage: true,
  };
}

function buildDocumentSpec(message) {
  const document = message?.document;
  if (!document?.file_id) {
    return null;
  }

  return {
    kind: "document",
    fileId: document.file_id,
    fileUniqueId: document.file_unique_id || document.file_id,
    originalFileName:
      document.file_name || `document-${document.file_unique_id || document.file_id}`,
    mimeType: document.mime_type || "application/octet-stream",
    sizeBytes: document.file_size ?? null,
    isImage: inferDocumentIsImage(document),
  };
}

function buildStoredFileName(spec, telegramFilePath) {
  const originalName = sanitizeFileName(spec.originalFileName);
  const originalExtension = path.extname(originalName);
  const telegramExtension = path.extname(telegramFilePath || "");
  const extension =
    originalExtension || telegramExtension || (spec.isImage ? ".jpg" : ".bin");
  const stem = originalExtension
    ? originalName.slice(0, -originalExtension.length)
    : originalName;
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/gu, "");
  return `${timestamp}-${spec.kind}-${sanitizeFileName(stem)}${extension}`;
}

function buildAttachmentRelativePath(fileName) {
  return path.join("incoming", fileName);
}

export function extractPromptText(message, { trim = true } = {}) {
  const text = String(message?.text ?? message?.caption ?? "");
  return trim ? text.trim() : text;
}

export function extractIncomingAttachmentSpecs(message) {
  const specs = [];
  const photoSpec = buildPhotoSpec(message);
  if (photoSpec) {
    specs.push(photoSpec);
  }

  const documentSpec = buildDocumentSpec(message);
  if (documentSpec) {
    specs.push(documentSpec);
  }

  return specs;
}

export function hasIncomingAttachments(message) {
  return extractIncomingAttachmentSpecs(message).length > 0;
}

export async function ingestIncomingAttachments({
  api,
  message,
  session,
  sessionStore,
}) {
  const language = getSessionUiLanguage(session);
  const specs = extractIncomingAttachmentSpecs(message);
  if (specs.length === 0) {
    return [];
  }

  const descriptors = [];
  for (const spec of specs) {
    if (
      Number.isInteger(spec.sizeBytes) &&
      spec.sizeBytes > TELEGRAM_DOWNLOAD_SOFT_LIMIT_BYTES
    ) {
      throw new Error(
        language === "eng"
          ? `Attachment ${spec.originalFileName} is too large for bot download (${spec.sizeBytes} bytes).`
          : `Вложение ${spec.originalFileName} слишком большое для bot download (${spec.sizeBytes} bytes).`,
      );
    }

    const file = await api.getFile({ file_id: spec.fileId });
    if (!file?.file_path) {
      throw new Error(
        language === "eng"
          ? `Telegram did not return file_path for ${spec.originalFileName}.`
          : `Telegram не вернул file_path для ${spec.originalFileName}.`,
      );
    }

    const storedFileName = buildStoredFileName(spec, file.file_path);
    const relativePath = buildAttachmentRelativePath(storedFileName);
    const absolutePath = path.join(
      sessionStore.getSessionDir(session.chat_id, session.topic_id),
      relativePath,
    );
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await api.downloadFile(file.file_path, absolutePath);
    const stats = await fs.stat(absolutePath);

    descriptors.push({
      kind: spec.kind,
      file_name: storedFileName,
      relative_path: relativePath,
      file_path: absolutePath,
      mime_type: spec.mimeType,
      size_bytes: stats.size,
      is_image: spec.isImage,
      source_message_id: message.message_id ?? null,
      telegram_file_id: spec.fileId,
      telegram_file_unique_id: spec.fileUniqueId,
    });
  }

  return descriptors;
}
