import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getSessionUiLanguage } from "../i18n/ui-language.js";
import { splitTelegramReply } from "../transport/telegram-reply-normalizer.js";
import { deliverDocumentToTopic } from "../transport/topic-document-delivery.js";
import { isAutoModeEnabled } from "../session-manager/auto-mode.js";
import {
  getRetryDelayMs,
  isEnglish,
  isMissingReplyTargetError,
  sleep,
  stringifyMessageId,
} from "./worker-pool-common.js";

const FINAL_REPLY_MAX_ATTEMPTS = 3;

function formatOutgoingDocumentLabel(document) {
  if (typeof document?.fileName === "string" && document.fileName.trim()) {
    return document.fileName.trim();
  }

  if (typeof document?.filePath === "string" && document.filePath.trim()) {
    return path.basename(document.filePath.trim());
  }

  return "file";
}

function buildDocumentSuccessSummary(successes, language = "rus") {
  const labels = successes.map((entry) => entry.label);
  if (labels.length === 1) {
    return isEnglish(language)
      ? `Sent file: ${labels[0]}.`
      : `Отправил файл: ${labels[0]}.`;
  }

  return isEnglish(language)
    ? `Sent files: ${labels.join(", ")}.`
    : `Отправил файлы: ${labels.join(", ")}.`;
}

function buildDocumentFailureLine(failure, language = "rus") {
  return isEnglish(language)
    ? `Could not send file ${failure.label}: ${failure.error}`
    : `Не смог отправить файл ${failure.label}: ${failure.error}`;
}

export function buildFinalCompletedReplyText({
  baseText,
  successes = [],
  failures = [],
  warnings = [],
  language = "rus",
}) {
  const normalizedBaseText = String(baseText || "").trim();
  const notes = [
    ...warnings,
    ...failures.map((failure) => buildDocumentFailureLine(failure, language)),
  ].filter(Boolean);

  if (normalizedBaseText) {
    return notes.length > 0
      ? `${normalizedBaseText}\n\n${notes.join("\n")}`
      : normalizedBaseText;
  }

  if (successes.length > 0) {
    const successSummary = buildDocumentSuccessSummary(successes, language);
    return notes.length > 0
      ? `${successSummary}\n\n${notes.join("\n")}`
      : successSummary;
  }

  return notes.join("\n").trim();
}

async function resolveExistingRealPath(filePath) {
  try {
    return await fs.realpath(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function isPathInsideRoot(targetPath, rootPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return (
    relativePath === ""
    || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function buildReplyParams(session, text, replyToMessageId = null) {
  const params = {
    chat_id: Number(session.chat_id),
    text,
    parse_mode: "HTML",
    message_thread_id: Number(session.topic_id),
  };

  if (replyToMessageId) {
    params.reply_to_message_id = replyToMessageId;
  }

  return params;
}

export async function deliverRunDocuments(pool, session, documents = []) {
  const successes = [];
  const failures = [];
  const allowedRoots = await resolveDocumentDeliveryRoots(pool, session);
  const language = getSessionUiLanguage(session);

  for (const document of documents) {
    const filePath = String(document?.filePath || "").trim();
    const label = formatOutgoingDocumentLabel(document);

    if (!filePath) {
      failures.push({
        label,
        error: isEnglish(language) ? "path is missing" : "не указан path",
      });
      continue;
    }

    if (!path.isAbsolute(filePath)) {
      failures.push({
        label,
        error: isEnglish(language)
          ? `path must be absolute: ${filePath}`
          : `путь должен быть абсолютным: ${filePath}`,
      });
      continue;
    }

    const candidateFilePath = path.resolve(filePath);
    const resolvedFilePath = await resolveExistingRealPath(candidateFilePath);
    if (!resolvedFilePath) {
      failures.push({
        label,
        error: isEnglish(language)
          ? `file not found: ${filePath}`
          : `файл не найден: ${filePath}`,
      });
      continue;
    }

    if (
      !allowedRoots.some((rootPath) =>
        isPathInsideRoot(resolvedFilePath, rootPath),
      )
    ) {
      failures.push({
        label,
        error: isEnglish(language)
          ? "path is outside allowed delivery roots; copy the file into the worktree, session state, or the system temp dir first"
          : "путь вне разрешённых зон доставки; сначала скопируй файл в worktree, session state или системную temp-директорию",
      });
      continue;
    }

    try {
      const result = await deliverDocumentToTopic({
        api: pool.api,
        chatId: Number(session.chat_id),
        messageThreadId: Number(session.topic_id),
        document: {
          filePath: resolvedFilePath,
          fileName:
            typeof document?.fileName === "string" && document.fileName.trim()
              ? document.fileName.trim()
              : null,
          caption:
            typeof document?.caption === "string" && document.caption.trim()
              ? document.caption.trim()
              : null,
        },
      });

      if (!result.delivered) {
        failures.push({
          label,
          error: isEnglish(language)
            ? `size ${result.sizeBytes} bytes exceeds the Telegram limit`
            : `размер ${result.sizeBytes} bytes превышает Telegram лимит`,
        });
        continue;
      }

      successes.push({
        label,
        sizeBytes: result.sizeBytes,
      });
    } catch (error) {
      if (pool.sessionLifecycleManager) {
        const lifecycleResult = await pool.sessionLifecycleManager.handleTransportError(
          session,
          error,
        );
        if (lifecycleResult?.handled) {
          failures.push({
            label,
            error: isEnglish(language)
              ? "topic is unavailable in Telegram"
              : "топик недоступен в Telegram",
          });
          return {
            successes,
            failures,
            parked: true,
            session: lifecycleResult.session || session,
          };
        }
      }

      failures.push({
        label,
        error: error.message,
      });
    }
  }

  return {
    successes,
    failures,
    parked: false,
    session,
  };
}

export async function resolveDocumentDeliveryRoots(pool, session) {
  const candidates = [
    session.workspace_binding?.worktree_path ?? null,
    session.workspace_binding?.cwd ?? null,
    typeof pool.sessionStore?.getSessionDir === "function"
      ? pool.sessionStore.getSessionDir(session.chat_id, session.topic_id)
      : null,
    os.tmpdir(),
  ].filter(Boolean);
  const roots = [];

  for (const candidate of candidates) {
    const resolved = await resolveExistingRealPath(candidate);
    if (resolved && !roots.includes(resolved)) {
      roots.push(resolved);
    }
  }

  return roots;
}

export async function emitSpikeFinalEvent(
  pool,
  run,
  {
    finishedAt,
    deliveryResult = null,
  } = {},
) {
  if (!pool.spikeFinalEventStore || !run?.session) {
    return null;
  }

  const currentSession =
    (await pool.sessionStore?.load?.(run.session.chat_id, run.session.topic_id))
    || run.session;
  if (!isAutoModeEnabled(currentSession)) {
    return null;
  }

  return pool.spikeFinalEventStore.write(currentSession, {
    exchange_log_entries: currentSession.exchange_log_entries ?? 0,
    status: run.state.status,
    finished_at: finishedAt ?? new Date().toISOString(),
    final_reply_text: run.state.finalAgentMessage,
    telegram_message_ids: deliveryResult?.messageIds ?? [],
    reply_to_message_id: stringifyMessageId(run.state.replyToMessageId),
    thread_id: run.state.threadId ?? null,
  });
}

export async function deliverRunReply(
  pool,
  session,
  text,
  { replyToMessageId = null } = {},
) {
  const chunks = splitTelegramReply(text);
  const messageIds = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const params = buildReplyParams(
      session,
      chunk,
      index === 0 ? replyToMessageId : null,
    );
    let allowReplyTargetFallback = Boolean(params.reply_to_message_id);

    for (let attempt = 1; attempt <= FINAL_REPLY_MAX_ATTEMPTS; attempt += 1) {
      try {
        const delivered = await pool.api.sendMessage(params);
        if (Number.isInteger(delivered?.message_id)) {
          messageIds.push(String(delivered.message_id));
        }
        break;
      } catch (error) {
        if (allowReplyTargetFallback && isMissingReplyTargetError(error)) {
          delete params.reply_to_message_id;
          allowReplyTargetFallback = false;
          continue;
        }

        if (pool.sessionLifecycleManager) {
          const lifecycleResult = await pool.sessionLifecycleManager.handleTransportError(
            session,
            error,
          );
          if (lifecycleResult?.handled) {
            return {
              ...lifecycleResult,
              delivered: false,
              messageIds,
            };
          }
        }

        const retryDelayMs = getRetryDelayMs(error);
        if (retryDelayMs === null || attempt === FINAL_REPLY_MAX_ATTEMPTS) {
          throw error;
        }

        await sleep(retryDelayMs);
      }
    }
  }

  return {
    delivered: true,
    messageIds,
  };
}
