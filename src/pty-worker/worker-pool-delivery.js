import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getSessionUiLanguage } from "../i18n/ui-language.js";
import {
  buildRsyncBaseArgs,
  buildRsyncRemotePath,
  normalizeRsyncLocalPath,
  runCommand,
} from "../hosts/host-command-runner.js";
import { translateWorkspacePathForHost } from "../hosts/host-paths.js";
import { splitTelegramReply } from "../transport/telegram-reply-normalizer.js";
import { deliverDocumentToTopic } from "../transport/topic-document-delivery.js";
import { sanitizeFileName } from "../telegram/file-name-sanitizer.js";
import {
  getRetryDelayMs,
  isEnglish,
  isMissingReplyTargetError,
  isTransientTransportError,
  sleep,
  stringifyMessageId,
} from "./worker-pool-common.js";

const FINAL_REPLY_MAX_ATTEMPTS = 3;
const FINAL_REPLY_TRANSIENT_RETRY_DELAYS_MS = [500, 1500];

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
  return isPathInsideRootWithModule(targetPath, rootPath, path);
}

function isPathInsideRootWithModule(targetPath, rootPath, pathModule) {
  const relativePath = pathModule.relative(rootPath, targetPath);
  return (
    relativePath === ""
    || (!relativePath.startsWith("..") && !pathModule.isAbsolute(relativePath))
  );
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

async function resolveRemoteDeliveryHost(pool, session) {
  const hostId = normalizeOptionalText(session?.execution_host_id);
  if (!hostId) {
    return null;
  }

  const currentHostId = normalizeOptionalText(pool?.config?.currentHostId);
  if (currentHostId && hostId === currentHostId) {
    return null;
  }

  if (typeof pool?.hostRegistryService?.getHost !== "function") {
    return null;
  }

  const host = await pool.hostRegistryService.getHost(hostId);
  if (!host?.ssh_target) {
    return null;
  }

  return host;
}

function resolveRemoteDocumentDeliveryRoots(pool, session, host) {
  const currentHostId = normalizeOptionalText(pool?.config?.currentHostId);
  const roots = [
    translateWorkspacePathForHost(
      session.workspace_binding?.worktree_path ?? null,
      {
        workspaceBinding: session.workspace_binding,
        host,
        currentHostId,
      },
    ),
    translateWorkspacePathForHost(
      session.workspace_binding?.cwd ?? null,
      {
        workspaceBinding: session.workspace_binding,
        host,
        currentHostId,
      },
    ),
  ].filter(Boolean);
  if (pool?.config?.allowSystemTempDelivery === true) {
    roots.push("/tmp");
  }
  return roots;
}

function buildOutsideDeliveryRootsMessage(language, { remote = false } = {}) {
  if (isEnglish(language)) {
    return remote
      ? "path is outside allowed delivery roots; copy the file into the bound host worktree first"
      : "path is outside allowed delivery roots; copy the file into the worktree or session state first";
  }

  return remote
    ? "путь вне разрешённых зон доставки; сначала скопируй файл в worktree привязанного хоста"
    : "путь вне разрешённых зон доставки; сначала скопируй файл в worktree или session state";
}

async function stageRemoteDocumentForDelivery(
  pool,
  session,
  filePath,
  document,
  language,
) {
  const host = await resolveRemoteDeliveryHost(pool, session);
  if (!host) {
    return null;
  }

  const remoteAllowedRoots = resolveRemoteDocumentDeliveryRoots(pool, session, host);
  if (
    !remoteAllowedRoots.some((rootPath) =>
      isPathInsideRootWithModule(filePath, path.posix.normalize(rootPath), path.posix),
    )
  ) {
    return {
      failure: buildOutsideDeliveryRootsMessage(language, { remote: true }),
    };
  }

  const localStageDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-remote-document-"),
  );
  const localFilePath = path.join(
    localStageDir,
    typeof document?.fileName === "string" && document.fileName.trim()
      ? sanitizeFileName(document.fileName.trim(), "file")
      : sanitizeFileName(path.posix.basename(filePath), "file"),
  );
  try {
    await runCommand(
      "rsync",
      [
        ...buildRsyncBaseArgs(pool?.config?.hostSshConnectTimeoutSecs || 10),
        buildRsyncRemotePath(host.ssh_target, filePath),
        normalizeRsyncLocalPath(localFilePath),
      ],
      {
        execFileImpl:
          typeof pool?.config?.hostExecFileImpl === "function"
            ? pool.config.hostExecFileImpl
            : undefined,
        timeoutMs: 30_000,
      },
    );
  } catch (error) {
    await fs.rm(localStageDir, { recursive: true, force: true }).catch(() => null);
    const details = String(error?.stderr || error?.message || "").trim();
    return {
      failure: isEnglish(language)
        ? details || `file not found on host ${host.host_id}: ${filePath}`
        : details || `файл не найден на хосте ${host.host_id}: ${filePath}`,
    };
  }

  return {
    resolvedFilePath: await fs.realpath(localFilePath),
    stageDir: localStageDir,
  };
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

function getTransientFinalReplyRetryDelayMs(error, attempt) {
  const retryDelayMs = getRetryDelayMs(error);
  if (retryDelayMs !== null) {
    return retryDelayMs;
  }

  if (!isTransientTransportError(error)) {
    return null;
  }

  return FINAL_REPLY_TRANSIENT_RETRY_DELAYS_MS[attempt - 1] ?? null;
}

export async function deliverRunDocuments(pool, session, documents = []) {
  const successes = [];
  const failures = [];
  const allowedRoots = await resolveDocumentDeliveryRoots(pool, session);
  const remoteDeliveryHost = await resolveRemoteDeliveryHost(pool, session);
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

    const isRemoteDelivery = Boolean(remoteDeliveryHost);
    const pathModule = isRemoteDelivery ? path.posix : path;

    if (!pathModule.isAbsolute(filePath)) {
      failures.push({
        label,
        error: isEnglish(language)
          ? `path must be absolute: ${filePath}`
          : `путь должен быть абсолютным: ${filePath}`,
      });
      continue;
    }

    const candidateFilePath = isRemoteDelivery
      ? path.posix.normalize(filePath)
      : path.resolve(filePath);
    let resolvedFilePath = null;
    let remoteStageDir = null;
    if (isRemoteDelivery) {
      const remoteStage = await stageRemoteDocumentForDelivery(
        pool,
        session,
        candidateFilePath,
        document,
        language,
      );
      if (remoteStage?.failure) {
        failures.push({
          label,
          error: remoteStage.failure,
        });
        continue;
      }
      resolvedFilePath = remoteStage?.resolvedFilePath ?? null;
      remoteStageDir = remoteStage?.stageDir ?? null;
    } else {
      resolvedFilePath = await resolveExistingRealPath(candidateFilePath);
    }

    try {
      const deliveryAllowedRoots = remoteStageDir
        ? [remoteStageDir]
        : allowedRoots;
      if (
        resolvedFilePath &&
        !deliveryAllowedRoots.some((rootPath) =>
          isPathInsideRoot(resolvedFilePath, rootPath),
        )
      ) {
        failures.push({
          label,
          error: buildOutsideDeliveryRootsMessage(language),
        });
        continue;
      }

      if (!resolvedFilePath) {
        failures.push({
          label,
          error: isEnglish(language)
            ? `file not found: ${filePath}`
            : `файл не найден: ${filePath}`,
        });
        continue;
      }

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
    } finally {
      if (remoteStageDir) {
        await fs.rm(remoteStageDir, { recursive: true, force: true }).catch(() => null);
      }
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
  ].filter(Boolean);
  if (pool?.config?.allowSystemTempDelivery === true) {
    candidates.push(os.tmpdir());
  }
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
  { replyToMessageId = null, progress = null } = {},
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

        const retryDelayMs = getTransientFinalReplyRetryDelayMs(error, attempt);
        if (retryDelayMs !== null && attempt < FINAL_REPLY_MAX_ATTEMPTS) {
          await sleep(retryDelayMs);
          continue;
        }

        if (
          messageIds.length === 0 &&
          progress?.messageId !== null &&
          isTransientTransportError(error)
        ) {
          await progress.finalize(text);
          return {
            delivered: true,
            fallback: "progress",
            messageIds: [stringifyMessageId(progress.messageId)].filter(Boolean),
          };
        }

        if (messageIds.length > 0) {
          error.partialTelegramMessageIds = Array.from(messageIds);
        }
        throw error;
      }
    }
  }

  return {
    delivered: true,
    messageIds,
  };
}
