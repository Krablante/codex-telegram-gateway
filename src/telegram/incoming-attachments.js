import fs from "node:fs/promises";
import path from "node:path";

import { getSessionUiLanguage } from "../i18n/ui-language.js";
import {
  ensureFileMode,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from "../state/file-utils.js";
import { sanitizeFileName } from "./file-name-sanitizer.js";

const TELEGRAM_DOWNLOAD_SOFT_LIMIT_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
]);

function buildAttachmentTooLargeMessage({
  language,
  fileName,
  sizeBytes,
  limitBytes = TELEGRAM_DOWNLOAD_SOFT_LIMIT_BYTES,
}) {
  if (language === "eng") {
    return [
      "Attachment is too large for direct bot download.",
      "",
      `file: ${fileName}`,
      `size_bytes: ${sizeBytes}`,
      `limit_bytes: ${limitBytes}`,
      "",
      "Send a smaller file, split it, or send a link/path instead.",
    ].join("\n");
  }

  return [
    "Вложение слишком большое для прямой загрузки ботом.",
    "",
    `file: ${fileName}`,
    `size_bytes: ${sizeBytes}`,
    `limit_bytes: ${limitBytes}`,
    "",
    "Пришли файл поменьше, разбей его на части или дай ссылку/путь вместо прямой загрузки.",
  ].join("\n");
}

export class IncomingAttachmentTooLargeError extends Error {
  constructor({
    session,
    fileName,
    sizeBytes,
    limitBytes = TELEGRAM_DOWNLOAD_SOFT_LIMIT_BYTES,
  }) {
    const language = getSessionUiLanguage(session);
    const replyText = buildAttachmentTooLargeMessage({
      language,
      fileName,
      sizeBytes,
      limitBytes,
    });
    super(replyText);
    this.name = "IncomingAttachmentTooLargeError";
    this.replyText = replyText;
    this.session = session || null;
    this.fileName = fileName;
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
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
  const random = Math.random().toString(16).slice(2, 10);
  return `${timestamp}-${random}-${spec.kind}-${sanitizeFileName(stem)}${extension}`;
}

function buildAttachmentRelativePath(fileName) {
  return path.posix.join("incoming", fileName);
}

function isTelegramDownloadTooLargeError(error) {
  return (
    error?.name === "TelegramFileDownloadTooLargeError"
    && Number.isFinite(error.sizeBytes)
    && Number.isFinite(error.limitBytes)
  );
}

export function extractPromptText(message, { trim = true } = {}) {
  const text = String(message?.text ?? message?.caption ?? "");
  return trim ? text.trim() : text;
}

function extractIncomingAttachmentSpecs(message) {
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
      throw new IncomingAttachmentTooLargeError({
        session,
        fileName: spec.originalFileName,
        sizeBytes: spec.sizeBytes,
      });
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
    await ensurePrivateDirectory(path.dirname(absolutePath));
    try {
      await api.downloadFile(file.file_path, absolutePath, {
        maxBytes: TELEGRAM_DOWNLOAD_SOFT_LIMIT_BYTES,
      });
    } catch (error) {
      if (isTelegramDownloadTooLargeError(error)) {
        throw new IncomingAttachmentTooLargeError({
          session,
          fileName: spec.originalFileName,
          sizeBytes: error.sizeBytes,
          limitBytes: error.limitBytes,
        });
      }
      throw error;
    }
    await ensureFileMode(absolutePath, PRIVATE_FILE_MODE);
    const stats = await fs.stat(absolutePath);
    if (stats.size > TELEGRAM_DOWNLOAD_SOFT_LIMIT_BYTES) {
      await fs.rm(absolutePath, { force: true });
      throw new IncomingAttachmentTooLargeError({
        session,
        fileName: spec.originalFileName,
        sizeBytes: stats.size,
      });
    }

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
