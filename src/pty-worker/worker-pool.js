import fs from "node:fs/promises";
import path from "node:path";

import { getSessionUiLanguage, normalizeUiLanguage } from "../i18n/ui-language.js";
import { markPromptAccepted, setActiveRunCount } from "../runtime/service-state.js";
import { runCodexTask } from "./codex-runner.js";
import { buildCompactResumePrompt, summarizeCompactState } from "./compact-resume.js";
import { TelegramProgressMessage } from "../transport/progress-message.js";
import { normalizeTelegramReply } from "../transport/telegram-reply-normalizer.js";
import { extractTelegramFileDirectives } from "../transport/telegram-file-directive.js";
import { deliverDocumentToTopic } from "../transport/topic-document-delivery.js";
import { buildTopicContextPrompt } from "../session-manager/topic-context.js";

const MAX_THREAD_RESUME_RETRIES = 1;
const TYPING_ACTION_INTERVAL_MS = 4000;
const PROGRESS_PENDING_MARKER = "...";
const FINAL_REPLY_MAX_ATTEMPTS = 3;

function excerpt(text, limit = 280) {
  if (!text) {
    return "";
  }
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact.length <= limit) {
    return compact;
  }

  return `${compact.slice(0, limit)}...`;
}

function outputTail(text, maxLines = 8, maxChars = 800) {
  const lines = text.trim().split("\n").slice(-maxLines).join("\n");
  if (lines.length <= maxChars) {
    return lines;
  }

  return lines.slice(-maxChars);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalChildProcessGroup(child, signal) {
  if (!child) {
    return false;
  }

  if (Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {}
  }

  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

function getRetryDelayMs(error) {
  const match = String(error?.message || "").match(/retry after\s+(\d+)/iu);
  if (!match) {
    return null;
  }

  const retryAfterSecs = Number.parseInt(match[1], 10);
  if (!Number.isFinite(retryAfterSecs) || retryAfterSecs < 0) {
    return null;
  }

  return (retryAfterSecs + 1) * 1000;
}

function isTransientTransportError(error) {
  if (getRetryDelayMs(error) !== null) {
    return true;
  }

  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("socket hang up") ||
    message.includes("timeout")
  );
}

function buildProgressSpinner() {
  return PROGRESS_PENDING_MARKER;
}

function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}

function buildProgressStep(state, language = "rus") {
  if (["interrupting", "interrupted"].includes(state.status)) {
    return {
      heading: isEnglish(language) ? "Stopping the run" : "Останавливаю run",
      detail: null,
    };
  }

  if (state.status === "rebuilding") {
    return {
      heading: isEnglish(language) ? "Rebuilding context" : "Восстанавливаю контекст",
      detail: null,
    };
  }

  if (
    typeof state.latestProgressMessage === "string" &&
    state.latestProgressMessage.trim()
  ) {
    return {
      heading: null,
      detail: excerpt(state.latestProgressMessage, 500),
    };
  }

  if (
    state.latestSummaryKind &&
    !["thread", "turn", "command"].includes(state.latestSummaryKind) &&
    typeof state.latestSummary === "string" &&
    state.latestSummary.trim()
  ) {
    return {
      heading: null,
      detail: excerpt(state.latestSummary, 500),
    };
  }

  return null;
}

function buildProgressText(state, language = "rus") {
  const spinner = buildProgressSpinner();
  const step = buildProgressStep(state, language);
  if (!step) {
    return spinner;
  }

  const parts = [];
  if (step.heading) {
    parts.push(step.heading);
  }
  if (step.detail) {
    parts.push(step.detail);
  }
  parts.push(spinner);
  return parts.join("\n\n");
}

function buildInterruptedText(language = "rus") {
  return isEnglish(language) ? "Stopped." : "Остановлено.";
}

function buildFailureText(error, language = "rus") {
  return [
    isEnglish(language) ? "Could not finish the run." : "Не смог закончить run.",
    "",
    `${isEnglish(language) ? "Error" : "Ошибка"}: ${error.message}`,
  ].join("\n");
}

function buildRunFailureText(result, language = "rus") {
  const warning = Array.isArray(result?.warnings)
    ? result.warnings.find((line) => String(line || "").trim())
    : null;
  const errorMessage = warning
    || (Number.isFinite(result?.exitCode)
      ? `Codex app-server exited with code ${result.exitCode}`
      : null)
    || (result?.signal
      ? `Codex app-server was terminated by signal ${result.signal}`
      : null)
    || "Codex app-server ended without a final reply";

  return buildFailureText(new Error(errorMessage), language);
}

function formatAttachmentForPrompt(attachment) {
  const detailParts = [];
  if (attachment.mime_type) {
    detailParts.push(attachment.mime_type);
  }
  if (Number.isInteger(attachment.size_bytes)) {
    detailParts.push(`${attachment.size_bytes} bytes`);
  }

  const typeLabel = attachment.is_image ? "image" : "file";
  const details = detailParts.length > 0 ? ` [${detailParts.join(", ")}]` : "";
  return `- ${typeLabel}: ${attachment.file_path}${details}`;
}

function buildPromptWithAttachments(prompt, attachments = [], language = "rus") {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return prompt;
  }

  const lines = [
    isEnglish(language)
      ? "Telegram attachments are included with this message. Use them as part of the context."
      : "К сообщению приложены вложения из Telegram. Используй их как часть контекста.",
    ...attachments.map(formatAttachmentForPrompt),
  ];

  const normalizedPrompt = String(prompt || "").trim();
  if (normalizedPrompt) {
    lines.push(
      "",
      isEnglish(language) ? "User request:" : "Запрос пользователя:",
      normalizedPrompt,
    );
  }

  return lines.join("\n");
}

function buildPromptWithTopicContext(prompt, session, sessionStore) {
  const topicContextPath =
    typeof sessionStore?.getTopicContextPath === "function"
      ? sessionStore.getTopicContextPath(session.chat_id, session.topic_id)
      : null;

  return [
    buildTopicContextPrompt(session, { topicContextPath }),
    "",
    prompt,
  ].join("\n");
}

function buildSteerInput(prompt, attachments = [], language = "rus") {
  const steerPrompt = buildPromptWithAttachments(prompt, attachments, language);
  const input = [];
  if (String(steerPrompt || "").trim()) {
    input.push({
      type: "text",
      text: steerPrompt,
    });
  }

  for (const attachment of attachments) {
    if (!attachment?.is_image || !attachment.file_path) {
      continue;
    }

    input.push({
      type: "localImage",
      path: attachment.file_path,
    });
  }

  return input;
}

function appendPromptPart(basePrompt, nextPrompt) {
  const base = String(basePrompt || "").trim();
  const next = String(nextPrompt || "").trim();
  if (!base) {
    return next;
  }
  if (!next) {
    return base;
  }

  return `${base}\n\n${next}`;
}

function normalizeUsageCount(value) {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.trunc(value);
}

function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const inputTokens = normalizeUsageCount(usage.input_tokens);
  const cachedInputTokens = normalizeUsageCount(
    usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens,
  );
  const outputTokens = normalizeUsageCount(usage.output_tokens);
  const reasoningTokens = normalizeUsageCount(
    usage.output_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
  );

  if (
    inputTokens === null &&
    cachedInputTokens === null &&
    outputTokens === null &&
    reasoningTokens === null
  ) {
    return null;
  }

  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens:
      inputTokens === null && outputTokens === null
        ? null
        : (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

function splitTelegramText(text, limit = 3800) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized.split(/\n{2,}/u);
  const chunks = [];
  let current = "";

  const pushChunk = (chunk) => {
    if (chunk) {
      chunks.push(chunk);
    }
  };

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    pushChunk(current);
    current = "";

    if (paragraph.length <= limit) {
      current = paragraph;
      continue;
    }

    let remaining = paragraph;
    while (remaining.length > limit) {
      pushChunk(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
    }
    current = remaining;
  }

  pushChunk(current);
  return chunks;
}

function buildExchangeLogEntry({ prompt, state, finishedAt }) {
  return {
    created_at: finishedAt,
    status: state.status,
    user_prompt: prompt,
    assistant_reply:
      typeof state.finalAgentMessage === "string" && state.finalAgentMessage.trim()
        ? state.finalAgentMessage
        : null,
  };
}

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

function buildFinalCompletedReplyText({
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
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${path.sep}`);
}

function buildReplyParams(session, text, replyToMessageId = null) {
  const params = {
    chat_id: Number(session.chat_id),
    text,
    message_thread_id: Number(session.topic_id),
  };

  if (replyToMessageId) {
    params.reply_to_message_id = replyToMessageId;
  }

  return params;
}

function stringifyMessageId(messageId) {
  return Number.isInteger(messageId) ? String(messageId) : null;
}

export class CodexWorkerPool {
  constructor({
    api,
    config,
    sessionStore,
    serviceState,
    sessionCompactor = null,
    sessionLifecycleManager = null,
    runTask = runCodexTask,
  }) {
    this.api = api;
    this.config = config;
    this.sessionStore = sessionStore;
    this.serviceState = serviceState;
    this.sessionCompactor = sessionCompactor;
    this.sessionLifecycleManager = sessionLifecycleManager;
    this.runTask = runTask;
    this.activeRuns = new Map();
    this.pendingLiveSteers = new Map();
    this.startingRuns = new Set();
    this.startingRunPromises = new Map();
  }

  getActiveRun(sessionKey) {
    return this.activeRuns.get(sessionKey) || null;
  }

  getActiveOrStartingRunCount() {
    return this.activeRuns.size + this.startingRuns.size;
  }

  hasActiveOrStartingRuns() {
    return this.getActiveOrStartingRunCount() > 0;
  }

  canStart(sessionKey) {
    if (this.activeRuns.has(sessionKey) || this.startingRuns.has(sessionKey)) {
      return { ok: false, reason: "busy" };
    }

    if (this.getActiveOrStartingRunCount() >= this.config.maxParallelSessions) {
      return { ok: false, reason: "capacity" };
    }

    return { ok: true };
  }

  async flushPendingLiveSteer(sessionKey, run) {
    const pending = this.pendingLiveSteers.get(sessionKey);
    if (!pending || typeof run?.controller?.steer !== "function") {
      return false;
    }

    const result = await run.controller.steer({
      input: pending.input,
    });
    if (result?.ok === false) {
      return false;
    }

    this.pendingLiveSteers.delete(sessionKey);
    run.exchangePrompt = appendPromptPart(run.exchangePrompt, pending.exchangePrompt);
    if (Number.isInteger(pending.replyToMessageId)) {
      run.state.replyToMessageId = pending.replyToMessageId;
    }

    return true;
  }

  steerActiveRun({
    session,
    rawPrompt = "",
    message = null,
    attachments = [],
  }) {
    const sessionKey = session?.session_key;
    if (!sessionKey) {
      return { ok: false, reason: "missing-session-key" };
    }

    const run = this.activeRuns.get(sessionKey);
    if (!run && !this.startingRuns.has(sessionKey)) {
      return { ok: false, reason: "idle" };
    }

    const normalizedPrompt = String(rawPrompt || "").trim();
    const normalizedAttachments = Array.isArray(attachments)
      ? attachments.filter(Boolean)
      : [];
    if (!normalizedPrompt && normalizedAttachments.length === 0) {
      return { ok: false, reason: "empty" };
    }

    const exchangePrompt = buildPromptWithAttachments(
      normalizedPrompt,
      normalizedAttachments,
      getSessionUiLanguage(session),
    );
    const input = buildSteerInput(
      normalizedPrompt,
      normalizedAttachments,
      getSessionUiLanguage(session),
    );
    if (input.length === 0) {
      return { ok: false, reason: "empty" };
    }

    if (run?.state?.finalizing) {
      return { ok: false, reason: "finalizing" };
    }

    if (run?.controller && typeof run.controller.steer === "function") {
      return run.controller.steer({ input })
        .then((result) => {
          if (result?.ok) {
            run.exchangePrompt = appendPromptPart(run.exchangePrompt, exchangePrompt);
            if (Number.isInteger(message?.message_id)) {
              run.state.replyToMessageId = message.message_id;
            }
          }

          return result;
        })
        .catch((error) => ({
          ok: false,
          reason: "steer-failed",
          error,
        }));
    }

    const pending = this.pendingLiveSteers.get(sessionKey) || {
      input: [],
      exchangePrompt: "",
      replyToMessageId: null,
    };
    if (!this.startingRuns.has(sessionKey)) {
      return { ok: false, reason: "finalizing" };
    }
    pending.input.push(...input);
    pending.exchangePrompt = appendPromptPart(pending.exchangePrompt, exchangePrompt);
    if (Number.isInteger(message?.message_id)) {
      pending.replyToMessageId = message.message_id;
    }
    this.pendingLiveSteers.set(sessionKey, pending);

    return {
      ok: true,
      reason: "steer-buffered",
      inputCount: pending.input.length,
    };
  }

  startProgressLoop(run) {
    const timer = setInterval(() => {
      void this.sendTypingAction(run);
    }, TYPING_ACTION_INTERVAL_MS);
    timer.unref?.();
    return timer;
  }

  stopProgressLoop(run) {
    if (!run?.progressTimer) {
      return;
    }

    clearInterval(run.progressTimer);
    run.progressTimer = null;
  }

  async finalizeProgress(run) {
    try {
      await run.state.progress.finalize(
        buildProgressText(run.state, getSessionUiLanguage(run.session)),
      );
    } catch {
      // Final reply delivery should not depend on one last progress edit.
    }
  }

  async sendTypingAction(run) {
    if (typeof this.api.sendChatAction !== "function") {
      return;
    }

    if (!["starting", "running", "rebuilding"].includes(run.state.status)) {
      return;
    }

    if (run.state.typingActionInFlight) {
      return;
    }

    const now = Date.now();
    if (now - run.state.lastTypingActionAt < TYPING_ACTION_INTERVAL_MS) {
      return;
    }

    run.state.typingActionInFlight = true;
    try {
      await this.api.sendChatAction({
        chat_id: Number(run.session.chat_id),
        message_thread_id: Number(run.session.topic_id),
        action: "typing",
      });
      run.state.lastTypingActionAt = Date.now();
    } catch (error) {
      if (this.sessionLifecycleManager) {
        await this.sessionLifecycleManager.handleTransportError(run.session, error);
      }
    } finally {
      run.state.typingActionInFlight = false;
    }
  }

  async startPromptRun({
    session,
    prompt,
    rawPrompt = prompt,
    message,
    attachments = [],
    includeTopicContext = true,
  }) {
    const sessionKey = session.session_key;
    const allowed = this.canStart(sessionKey);
    if (!allowed.ok) {
      return allowed;
    }

    this.startingRuns.add(sessionKey);
    let resolveStartingRun;
    const startingRunPromise = new Promise((resolve) => {
      resolveStartingRun = resolve;
    });
    this.startingRunPromises.set(sessionKey, startingRunPromise);
    let startingRunSettled = false;
    const settleStartingRun = () => {
      if (startingRunSettled) {
        return;
      }

      startingRunSettled = true;
      if (this.startingRunPromises.get(sessionKey) === startingRunPromise) {
        this.startingRunPromises.delete(sessionKey);
      }
      resolveStartingRun();
    };
    let startReserved = true;
    const releaseStartReservation = () => {
      if (!startReserved) {
        return;
      }

      this.startingRuns.delete(sessionKey);
      startReserved = false;
    };
    markPromptAccepted(this.serviceState);

    const state = {
      sessionKey,
      status: "starting",
      threadId: session.codex_thread_id ?? null,
      activeTurnId: null,
      rolloutPath: session.codex_rollout_path ?? null,
      contextSnapshot: session.last_context_snapshot ?? null,
      latestSummary: null,
      latestSummaryKind: null,
      latestProgressMessage: null,
      latestCommandOutput: null,
      finalAgentMessage: null,
      replyDocuments: [],
      replyDocumentWarnings: [],
      warnings: [],
      interruptRequested: false,
      finalizing: false,
      resumeMode: session.codex_thread_id ? "thread-resume" : null,
      lastTokenUsage: session.last_token_usage ?? null,
      latestCommand: null,
      progress: null,
      replyToMessageId: message.message_id ?? null,
      lastTypingActionAt: 0,
      typingActionInFlight: false,
    };

    try {
      const progress = new TelegramProgressMessage({
        api: this.api,
        chatId: Number(session.chat_id),
        messageThreadId: Number(session.topic_id),
        onDeliveryError: async (error) => {
          if (this.sessionLifecycleManager) {
            return this.sessionLifecycleManager.handleTransportError(session, error);
          }

          return null;
        },
      });
      state.progress = progress;
      try {
        await progress.sendInitial(
          buildProgressText(state, getSessionUiLanguage(session)),
        );
      } catch (error) {
        if (error?.deliveryHandled || !isTransientTransportError(error)) {
          throw error;
        }

        // Progress bubble is optional for transient Telegram hiccups like 429.
      }
      const exchangePrompt = buildPromptWithAttachments(
        rawPrompt,
        attachments,
        getSessionUiLanguage(session),
      );

      const run = {
        sessionKey,
        session,
        child: null,
        controller: null,
        lifecyclePromise: null,
        exchangePrompt,
        includeTopicContext,
        state,
        startedAt: new Date().toISOString(),
        progressMessageId: progress.messageId,
        progressTimer: null,
      };
      run.progressTimer = this.startProgressLoop(run);
      void this.sendTypingAction(run);
      this.activeRuns.set(sessionKey, run);
      releaseStartReservation();
      settleStartingRun();
      setActiveRunCount(this.serviceState, this.activeRuns.size);
      await this.sessionStore.patch(session, {
        last_user_prompt: exchangePrompt,
        last_run_status: "running",
        last_run_started_at: run.startedAt,
        last_progress_message_id: stringifyMessageId(progress.messageId),
      });

      let resultPersisted = false;
      run.lifecyclePromise = this.executeRunLifecycle(run, {
        prompt,
        attachments,
        includeTopicContext,
      })
        .then(async (result) => {
          state.finalizing = true;
          state.threadId = result.threadId || state.threadId;
          state.warnings.push(...result.warnings);
          const completedWithReply =
            result.exitCode === 0 &&
            typeof state.finalAgentMessage === "string" &&
            state.finalAgentMessage.trim();
          state.status = completedWithReply
            ? "completed"
            : state.interruptRequested
              ? "interrupted"
              : result.exitCode === 0
                ? "completed"
                : "failed";
          const finishedAt = new Date().toISOString();
          let documentDelivery = {
            successes: [],
            failures: [],
            parked: false,
            session: run.session,
          };

          if (state.status === "completed") {
            documentDelivery = await this.deliverRunDocuments(
              run.session,
              state.replyDocuments,
            );
            run.session = documentDelivery.session || run.session;
            state.finalAgentMessage = buildFinalCompletedReplyText({
              baseText: state.finalAgentMessage,
              successes: documentDelivery.successes,
              failures: documentDelivery.failures,
              warnings: state.replyDocumentWarnings,
              language: getSessionUiLanguage(run.session),
            });
          }

          const finalReplyText =
            state.status === "completed"
              ? state.finalAgentMessage ||
                (isEnglish(getSessionUiLanguage(run.session)) ? "Done." : "Готово.")
              : state.status === "interrupted"
                ? buildInterruptedText(getSessionUiLanguage(run.session))
                : buildRunFailureText(result, getSessionUiLanguage(run.session));
          state.finalAgentMessage = finalReplyText;

          run.session = await this.sessionStore.patch(run.session, {
            codex_thread_id: state.threadId,
            last_user_prompt: run.exchangePrompt,
            last_agent_reply: finalReplyText,
            last_run_status: state.status,
            last_run_started_at: run.startedAt,
            last_run_finished_at: finishedAt,
            last_token_usage: state.lastTokenUsage,
            last_progress_message_id: stringifyMessageId(progress.messageId),
          });
          const exchangeLogResult = await this.sessionStore.appendExchangeLogEntry(
            run.session,
            buildExchangeLogEntry({
              prompt: run.exchangePrompt,
              state,
              finishedAt,
            }),
          );
          run.session = exchangeLogResult.session;
          resultPersisted = true;
          this.stopProgressLoop(run);
          await this.finalizeProgress(run);
          if (!documentDelivery.parked) {
            await this.deliverRunReply(run.session, finalReplyText, {
              replyToMessageId: state.replyToMessageId,
            });
          }
          await progress.dismiss();
        })
        .catch(async (error) => {
          state.finalizing = true;
          this.stopProgressLoop(run);
          if (resultPersisted) {
            await progress.dismiss().catch(() => false);
            throw error;
          }

          state.status = "failed";
          const finishedAt = new Date().toISOString();
          run.session = await this.sessionStore.patch(session, {
            last_user_prompt: run.exchangePrompt,
            last_run_status: "failed",
            last_run_started_at: run.startedAt,
            last_run_finished_at: finishedAt,
            last_token_usage: state.lastTokenUsage,
          });
          const exchangeLogResult = await this.sessionStore.appendExchangeLogEntry(
            run.session,
            buildExchangeLogEntry({
              prompt: run.exchangePrompt,
              state,
              finishedAt,
            }),
          );
          run.session = exchangeLogResult.session;
          await this.finalizeProgress(run);
          await this.deliverRunReply(
            run.session,
            buildFailureText(error, getSessionUiLanguage(run.session)),
            {
              replyToMessageId: state.replyToMessageId,
            },
          );
          await progress.dismiss();
        })
        .finally(async () => {
          this.stopProgressLoop(run);
          this.activeRuns.delete(sessionKey);
          this.pendingLiveSteers.delete(sessionKey);
          setActiveRunCount(this.serviceState, this.activeRuns.size);
        })
        .catch((error) => {
          console.error(`run lifecycle failed for ${sessionKey}: ${error.message}`);
        });

      return {
        ok: true,
        progressMessageId: progress.messageId,
        threadId: state.threadId,
        sessionKey,
        topicId: message.message_thread_id,
      };
    } catch (error) {
        releaseStartReservation();
        settleStartingRun();
        throw error;
    }
  }

  interrupt(sessionKey) {
    const run = this.activeRuns.get(sessionKey);
    if (!run) {
      return false;
    }

    if (
      run.state.interruptRequested ||
      ["completed", "failed", "interrupting", "interrupted"].includes(
        run.state.status,
      )
    ) {
      return false;
    }

    run.state.interruptRequested = true;
    run.state.status = "interrupting";
    run.state.latestSummary = "interrupt-requested";
    run.state.latestSummaryKind = "interrupt";
    run.state.progress.queueUpdate(
      buildProgressText(run.state, getSessionUiLanguage(run.session)),
    );

    const nativeInterruptRequested =
      typeof run.controller?.interrupt === "function" &&
      run.state.threadId &&
      run.state.activeTurnId;
    if (nativeInterruptRequested) {
      void run.controller.interrupt({
        threadId: run.state.threadId,
        turnId: run.state.activeTurnId,
      });
    }

    if (run.child) {
      setTimeout(() => {
        if (this.activeRuns.get(sessionKey) === run && run.child) {
          signalChildProcessGroup(run.child, "SIGINT");
          setTimeout(() => {
            if (this.activeRuns.get(sessionKey) === run && run.child) {
              signalChildProcessGroup(run.child, "SIGKILL");
            }
          }, 5000).unref();
        }
      }, nativeInterruptRequested ? 5000 : 0).unref();
    }
    return true;
  }

  async shutdown() {
    for (const [sessionKey] of this.activeRuns.entries()) {
      this.interrupt(sessionKey);
    }

    const startingPromises = [...this.startingRunPromises.values()];
    if (startingPromises.length > 0) {
      await Promise.allSettled(startingPromises);
    }

    for (const [sessionKey] of this.activeRuns.entries()) {
      this.interrupt(sessionKey);
    }

    for (const run of this.activeRuns.values()) {
      while (
        this.activeRuns.get(run.sessionKey) === run &&
        !run.lifecyclePromise
      ) {
        await sleep(25);
      }
    }

    const lifecyclePromises = [...this.activeRuns.values()]
      .map((run) => run.lifecyclePromise)
      .filter(Boolean);

    if (lifecyclePromises.length > 0) {
      await Promise.allSettled(lifecyclePromises);
    }
  }

  async executeRunLifecycle(run, {
    prompt,
    attachments = [],
    includeTopicContext = true,
  }) {
    return this.executeRunAttempts(run, {
      prompt: buildPromptWithAttachments(
        prompt,
        attachments,
        getSessionUiLanguage(run.session),
      ),
      sessionThreadId: run.session.codex_thread_id ?? null,
      attachments,
      includeTopicContext,
    });
  }

  async executeRunAttempts(run, {
    prompt,
    attachments = [],
    sessionThreadId,
    includeTopicContext = true,
  }) {
    let nextPrompt = prompt;
    const imagePaths = attachments
      .filter((attachment) => attachment?.is_image && attachment?.file_path)
      .map((attachment) => attachment.file_path);
    let nextSessionThreadId = sessionThreadId;
    let resumeRetryCount = 0;

    while (true) {
      if (run.state.interruptRequested && !run.child) {
        return {
          exitCode: null,
          signal: "SIGINT",
          threadId: run.state.threadId,
          warnings: [],
          resumeReplacement: null,
        };
      }

      const result = await this.runAttempt(run, {
        prompt: includeTopicContext
          ? buildPromptWithTopicContext(
              nextPrompt,
              run.session,
              this.sessionStore,
            )
          : nextPrompt,
        imagePaths,
        sessionThreadId: nextSessionThreadId,
      });

      if (!result.resumeReplacement || run.state.interruptRequested) {
        return result;
      }

      if (
        nextSessionThreadId &&
        resumeRetryCount < MAX_THREAD_RESUME_RETRIES
      ) {
        resumeRetryCount += 1;
        run.state.latestSummary = `resume-retry:${resumeRetryCount}`;
        run.state.latestSummaryKind = "event";
        run.state.progress.queueUpdate(
          buildProgressText(run.state, getSessionUiLanguage(run.session)),
        );
        continue;
      }

      nextPrompt = await this.prepareResumeFallback(run, {
        prompt,
        resumeReplacement: result.resumeReplacement,
      });
      nextSessionThreadId = null;
    }
  }

  async runAttempt(run, { prompt, imagePaths = [], sessionThreadId }) {
    const { state } = run;
    const task = this.runTask({
      codexBinPath: this.config.codexBinPath,
      cwd: run.session.workspace_binding.cwd,
      prompt,
      imagePaths,
      sessionThreadId,
      onEvent: async (summary, event) => {
        const primaryThreadEvent = summary.isPrimaryThreadEvent !== false;
        let shouldRefreshProgress = false;

        if (summary.threadId && primaryThreadEvent) {
          const threadChanged = summary.threadId !== run.session.codex_thread_id;
          state.threadId = summary.threadId;
          if (threadChanged) {
            state.rolloutPath = null;
            state.contextSnapshot = null;
          }
          run.session = await this.sessionStore.patch(run.session, {
            codex_thread_id: summary.threadId,
            ...(threadChanged
              ? {
                  codex_rollout_path: null,
                  last_context_snapshot: null,
                }
              : {}),
          });
        }

        if (summary.kind === "command") {
          state.latestCommand = summary.command || state.latestCommand;
          if (summary.eventType === "item.completed") {
            state.latestCommandOutput = summary.aggregatedOutput
              ? outputTail(summary.aggregatedOutput)
              : null;
          }
        } else if (summary.kind === "turn" && primaryThreadEvent) {
          if (summary.eventType === "turn.started") {
            state.activeTurnId = summary.turnId || state.activeTurnId;
          } else if (summary.eventType === "turn.completed") {
            state.activeTurnId = null;
          }

          if (summary.usage) {
            state.lastTokenUsage = normalizeTokenUsage(summary.usage);
          }
        } else if (summary.kind === "agent_message") {
          const messagePhase = summary.messagePhase || "final_answer";
          const normalizedAgentMessage = normalizeTelegramReply(summary.text);
          if (messagePhase === "commentary") {
            state.latestSummary = excerpt(normalizedAgentMessage, 500);
            state.latestSummaryKind = "agent_message";
            state.latestProgressMessage = normalizedAgentMessage;
            shouldRefreshProgress = true;
          }
          if (messagePhase === "final_answer" && primaryThreadEvent) {
            const parsedReply = extractTelegramFileDirectives(summary.text, {
              language: getSessionUiLanguage(run.session),
            });
            state.finalAgentMessage = normalizeTelegramReply(parsedReply.text);
            state.replyDocuments = parsedReply.documents;
            state.replyDocumentWarnings = parsedReply.warnings;
          }
        }

        if (!state.finalizing) {
          state.status = state.interruptRequested ? "interrupting" : "running";
        }
        if (shouldRefreshProgress) {
          state.progress.queueUpdate(
            buildProgressText(state, getSessionUiLanguage(run.session)),
          );
        }
      },
      onWarning: (line) => {
        state.warnings.push(line);
      },
    });
    const { child, finished } = task;

    run.child = child;
    run.controller = task;
    void this.flushPendingLiveSteer(run.sessionKey, run).catch((error) => {
      state.warnings.push(`live steer flush failed: ${error.message}`);
    });

    try {
      return await finished;
    } finally {
      if (run.child === child) {
        run.child = null;
      }
      if (run.controller === task) {
        run.controller = null;
      }
    }
  }

  async prepareResumeFallback(run, { prompt, resumeReplacement }) {
    const current =
      (await this.sessionStore.load(run.session.chat_id, run.session.topic_id)) ||
      run.session;
    const compacted = this.sessionCompactor
      ? await this.sessionCompactor.compact(current, {
          reason: `resume-fallback:${resumeReplacement.requestedThreadId}`,
        })
      : null;
    const compactState = compacted
      ? {
          activeBrief: compacted.activeBrief,
          exchangeLog: Array.from(
            { length: compacted.exchangeLogEntries ?? 0 },
            () => null,
          ),
        }
      : await this.sessionStore.loadCompactState(current);
    const compactSummary = summarizeCompactState(compactState);

    run.session = await this.sessionStore.patch(compacted?.session || current, {
      codex_thread_id: null,
      codex_rollout_path: null,
      last_context_snapshot: null,
    });
    run.state.threadId = null;
    run.state.status = "rebuilding";
    run.state.resumeMode = "compact-rebuild";
    run.state.latestSummary =
      `brief-refresh:${compactSummary.exchangeLogEntries}`;
    run.state.latestSummaryKind = "rebuild";
    run.state.latestProgressMessage = null;
    run.state.latestCommandOutput = null;
    run.state.latestCommand = null;
    run.state.finalAgentMessage = null;
    run.state.progress.queueUpdate(
      buildProgressText(run.state, getSessionUiLanguage(run.session)),
    );

    return buildCompactResumePrompt({
      session: current,
      prompt,
      compactState,
    });
  }

  async deliverRunDocuments(session, documents = []) {
    const successes = [];
    const failures = [];
    const allowedRoots = await this.resolveDocumentDeliveryRoots(session);
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

      const resolvedFilePath = await resolveExistingRealPath(filePath);
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
            ? "path is outside allowed delivery roots; copy the file into the worktree, session state, or /tmp first"
            : "путь вне разрешённых зон доставки; сначала скопируй файл в worktree, session state или /tmp",
        });
        continue;
      }

      try {
        const result = await deliverDocumentToTopic({
          api: this.api,
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
        if (this.sessionLifecycleManager) {
          const lifecycleResult = await this.sessionLifecycleManager.handleTransportError(
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

  async resolveDocumentDeliveryRoots(session) {
    const candidates = [
      session.workspace_binding?.worktree_path ?? null,
      session.workspace_binding?.cwd ?? null,
      typeof this.sessionStore?.getSessionDir === "function"
        ? this.sessionStore.getSessionDir(session.chat_id, session.topic_id)
        : null,
      "/tmp",
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

  async deliverRunReply(session, text, { replyToMessageId = null } = {}) {
    const chunks = splitTelegramText(normalizeTelegramReply(text));

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const params = buildReplyParams(
        session,
        chunk,
        index === 0 ? replyToMessageId : null,
      );

      for (let attempt = 1; attempt <= FINAL_REPLY_MAX_ATTEMPTS; attempt += 1) {
        try {
          await this.api.sendMessage(params);
          break;
        } catch (error) {
          if (this.sessionLifecycleManager) {
            const lifecycleResult = await this.sessionLifecycleManager.handleTransportError(
              session,
              error,
            );
            if (lifecycleResult?.handled) {
              return lifecycleResult;
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

    return { delivered: true };
  }
}
