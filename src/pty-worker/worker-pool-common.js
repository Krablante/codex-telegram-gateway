import os from "node:os";

import { resolveExecutionCwd, translateWorkspacePathForHost } from "../hosts/host-paths.js";
import { resolveEffectiveWorkStyle } from "../session-manager/prompt-suffix.js";
import { buildTopicDeveloperInstructions } from "../session-manager/topic-context.js";
import { normalizeUiLanguage } from "../i18n/ui-language.js";
import { signalChildProcessTree } from "../runtime/process-tree.js";
export { isContextWindowExceededText } from "../codex-runtime/context-window.js";

const PROGRESS_PENDING_MARKER = "...";
const INTERNAL_PROGRESS_ORCHESTRATION =
  /(?:\bsubagent\b|\bsub-agent\b|\bspawn[_ -]?agent\b|\bagent_path\b|\bfork_context\b|\bforked workspace\b|\bexplorer\b|\bworker\s+\d+\b|\brepo-level rules\b|\breadme claims\b|сабагент|субагент|эксплорер|воркер\s+\d+)/iu;
const TRANSIENT_TRANSPORT_ERROR_CODES = new Set([
  "ABORT_ERR",
  "ECONNABORTED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function excerpt(text, limit = 280) {
  if (!text) {
    return "";
  }
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact.length <= limit) {
    return compact;
  }

  return `${compact.slice(0, limit)}...`;
}

export function outputTail(text, maxLines = 8, maxChars = 800) {
  const lines = text.trim().split("\n").slice(-maxLines).join("\n");
  if (lines.length <= maxChars) {
    return lines;
  }

  return lines.slice(-maxChars);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function signalChildProcessGroup(child, signal) {
  return signalChildProcessTree(child, signal);
}

export function getRetryDelayMs(error) {
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


export function isTransientModelCapacityError(error) {
  const messages = [
    error?.message,
    error?.cause?.message,
  ]
    .map((value) => String(value || "").toLowerCase())
    .filter(Boolean);

  return messages.some((message) =>
    message.includes("selected model is at capacity")
    || (message.includes("model") && message.includes("at capacity")),
  );
}

export function isCodexThreadCorruptionError(value) {
  const text = String(value?.message || value || "").toLowerCase();
  return text.includes("no tool call found for function call output");
}

export function isTransientTransportError(error) {
  if (getRetryDelayMs(error) !== null) {
    return true;
  }

  const messages = [
    error?.message,
    error?.cause?.message,
  ]
    .map((value) => String(value || "").toLowerCase())
    .filter(Boolean);
  if (
    messages.some((message) =>
      message.includes("fetch failed") ||
      message.includes("network error") ||
      message.includes("socket hang up") ||
      message.includes("connection reset") ||
      message.includes("timed out") ||
      message.includes("timeout"),
    )
  ) {
    return true;
  }

  const codes = [
    error?.code,
    error?.cause?.code,
  ]
    .map((value) => String(value || "").toUpperCase())
    .filter(Boolean);
  return codes.some((code) => TRANSIENT_TRANSPORT_ERROR_CODES.has(code));
}

export function isMissingReplyTargetError(error) {
  return String(error?.message || "")
    .toLowerCase()
    .includes("message to be replied not found");
}

export function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}

function buildProgressSpinner() {
  return PROGRESS_PENDING_MARKER;
}

function buildNeutralProgressText() {
  return buildProgressSpinner();
}

function isInternalOrchestrationProgressDetail(text) {
  const compact = String(text || "").replace(/\s+/gu, " ").trim();
  if (!compact) {
    return false;
  }

  return INTERNAL_PROGRESS_ORCHESTRATION.test(compact);
}

export function isHiddenProgressDetail(text) {
  const compact = String(text || "").replace(/\s+/gu, " ").trim();
  if (!compact) {
    return false;
  }

  return isInternalOrchestrationProgressDetail(compact);
}

function normalizeProgressDetail(text) {
  const compact = excerpt(text, 500);
  if (!compact) {
    return null;
  }

  if (isHiddenProgressDetail(compact)) {
    return null;
  }

  return compact;
}

function buildLatestProgressStep(state) {
  if (
    typeof state.latestProgressMessage === "string" &&
    state.latestProgressMessage.trim()
  ) {
    const detail = normalizeProgressDetail(state.latestProgressMessage);
    if (detail) {
      return {
        heading: null,
        detail,
      };
    }
  }

  if (
    state.latestSummaryKind === "agent_message" &&
    typeof state.latestSummary === "string" &&
    state.latestSummary.trim()
  ) {
    const detail = normalizeProgressDetail(state.latestSummary);
    if (!detail) {
      return null;
    }
    return {
      heading: null,
      detail,
    };
  }

  return null;
}

function buildProgressStep(state, language = "rus") {
  if (["interrupting", "interrupted"].includes(state.status)) {
    return {
      heading: isEnglish(language) ? "Stopping the run" : "Останавливаю run",
      detail: null,
    };
  }

  const latestProgressStep = buildLatestProgressStep(state);

  if (state.status === "rebuilding") {
    if (
      state.resumeMode === "live-steer-restart" &&
      state.holdProgressUntilNaturalUpdate &&
      latestProgressStep
    ) {
      return latestProgressStep;
    }
    if (
      ["upstream-restart", "live-steer-restart"].includes(state.resumeMode)
      && state.threadId
    ) {
      return {
        heading: isEnglish(language)
          ? "Continuing the same Codex thread"
          : "Продолжаю тот же Codex thread",
        detail: null,
      };
    }
    return {
      heading: isEnglish(language) ? "Rebuilding context" : "Восстанавливаю контекст",
      detail: null,
    };
  }

  return latestProgressStep;
}

export function buildProgressText(state, language = "rus") {
  const spinner = buildProgressSpinner();
  const step = buildProgressStep(state, language);
  if (!step) {
    return buildNeutralProgressText();
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

export function buildInterruptedText(
  language = "rus",
  { requestedByUser = false, interruptReason = null } = {},
) {
  if (requestedByUser || interruptReason === "user") {
    return isEnglish(language) ? "Stopped." : "Остановлено.";
  }

  return isEnglish(language)
    ? "The run was interrupted before a final answer."
    : "Выполнение run было прервано до финального ответа.";
}

export function buildFailureText(error, language = "rus") {
  return [
    isEnglish(language) ? "Could not finish the run." : "Не смог закончить run.",
    "",
    `${isEnglish(language) ? "Error" : "Ошибка"}: ${error.message}`,
  ].join("\n");
}

function isDiagnosticOnlyWarning(line) {
  return String(line || "").trim().startsWith("codex exec stderr:");
}

export function buildRunFailureText(result, language = "rus") {
  const runtimeLabel = result?.backend === "exec-json"
    ? "Codex exec"
    : "Codex app-server";
  const warning = Array.isArray(result?.warnings)
    ? result.warnings.find((line) =>
      String(line || "").trim() && !isDiagnosticOnlyWarning(line),
    )
    : null;
  const errorMessage = warning
    || (result?.abortReason && result?.interrupted !== true
      ? `Codex turn aborted (${result.abortReason})`
      : null)
    || (Number.isFinite(result?.exitCode) && result.exitCode !== 0
      ? `${runtimeLabel} exited with code ${result.exitCode}`
      : null)
    || (result?.signal
      ? `${runtimeLabel} was terminated by signal ${result.signal}`
      : null)
    || `${runtimeLabel} ended without a final reply`;

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

export function buildPromptWithAttachments(prompt, attachments = [], language = "rus") {
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
  if (!normalizedPrompt) {
    return lines.join("\n");
  }

  return [lines.join("\n"), "", normalizedPrompt].join("\n");
}

function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function uniqueValues(values = []) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    const normalized = normalizeOptionalText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function resolvePromptDeliveryRoots(
  session,
  sessionStore,
  executionHost = null,
  currentHostId = null,
  { allowSystemTempDelivery = false } = {},
) {
  const workspaceBinding = session?.workspace_binding ?? null;
  const normalizedCurrentHostId = normalizeOptionalText(currentHostId);
  const normalizedExecutionHostId = normalizeOptionalText(executionHost?.host_id);

  if (executionHost && normalizedExecutionHostId && normalizedExecutionHostId !== normalizedCurrentHostId) {
    const roots = [
      translateWorkspacePathForHost(workspaceBinding?.worktree_path ?? null, {
        workspaceBinding,
        host: executionHost,
        currentHostId: normalizedCurrentHostId,
      }),
      translateWorkspacePathForHost(workspaceBinding?.cwd ?? null, {
        workspaceBinding,
        host: executionHost,
        currentHostId: normalizedCurrentHostId,
      }),
    ];
    if (allowSystemTempDelivery) {
      roots.push("/tmp");
    }
    return uniqueValues(roots);
  }

  const roots = [
    workspaceBinding?.worktree_path ?? null,
    workspaceBinding?.cwd ?? null,
    typeof sessionStore?.getSessionDir === "function"
      ? sessionStore.getSessionDir(session.chat_id, session.topic_id)
      : null,
  ];
  if (allowSystemTempDelivery) {
    roots.push(os.tmpdir());
  }
  return uniqueValues(roots);
}

export function buildThreadDeveloperInstructions(
  session,
  sessionStore,
  {
    executionHost = null,
    allowSystemTempDelivery = false,
    currentHostId = null,
    globalPromptSuffix = null,
  } = {},
) {
  const topicContextPath =
    typeof sessionStore?.getTopicContextPath === "function"
      ? sessionStore.getTopicContextPath(session.chat_id, session.topic_id)
      : null;
  const executionCwd = executionHost
    ? resolveExecutionCwd({
      workspaceBinding: session?.workspace_binding,
      host: executionHost,
      currentHostId,
    })
    : null;
  const normalizedCurrentHostId = normalizeOptionalText(currentHostId);
  const normalizedExecutionHostId = normalizeOptionalText(executionHost?.host_id);
  const remoteExecution =
    Boolean(executionHost)
    && Boolean(normalizedExecutionHostId)
    && normalizedExecutionHostId !== normalizedCurrentHostId;
  const workStyleText = resolveEffectiveWorkStyle(session, globalPromptSuffix);

  return buildTopicDeveloperInstructions(session, {
    topicContextPath: remoteExecution ? null : topicContextPath,
    executionCwd,
    fileDeliveryRoots: resolvePromptDeliveryRoots(
      session,
      sessionStore,
      executionHost,
      currentHostId,
      { allowSystemTempDelivery },
    ),
    topicContextFileOnControlPlane: remoteExecution,
    workStyleText,
  });
}

export function buildSteerInput(prompt, attachments = [], language = "rus") {
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

export function appendPromptPart(basePrompt, nextPrompt) {
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

export function buildExchangeLogEntry({ prompt, state, finishedAt }) {
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

export function stringifyMessageId(messageId) {
  return Number.isInteger(messageId) ? String(messageId) : null;
}

export function resolveReplyToMessageId(message) {
  return Number.isInteger(message?.message_id) ? message.message_id : null;
}
