import { buildReplyMessageParams } from "../telegram/command-parsing.js";
import { normalizeUiLanguage } from "../i18n/ui-language.js";

export function buildTopicParams(session, text, { replyToMessageId = null } = {}) {
  const params = {
    chat_id: Number(session.chat_id),
    message_thread_id: Number(session.topic_id),
    text,
  };

  if (replyToMessageId) {
    params.reply_to_message_id = Number(replyToMessageId);
  }

  return params;
}

export function isMissingReplyTargetError(error) {
  return String(error?.message || "")
    .toLowerCase()
    .includes("message to be replied not found");
}

export function parseAutoCommandArgs(rawArgs) {
  const normalized = String(rawArgs || "").trim().toLowerCase();
  if (!normalized) {
    return { action: "start" };
  }
  if (["off", "stop", "disable"].includes(normalized)) {
    return { action: "off" };
  }
  if (["status", "show"].includes(normalized)) {
    return { action: "status" };
  }

  return { action: "invalid", raw: normalized };
}

export function summarizeAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return null;
  }

  return [
    "Operator attachments:",
    ...attachments.map((attachment) => {
      const kind = attachment?.is_image ? "image" : "file";
      return `- ${kind}: ${attachment.file_path}`;
    }),
  ].join("\n");
}

export function combinePromptParts(parts) {
  return parts
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function isManualFlushShortcut(text) {
  const normalized = String(text || "").trim().toLowerCase();
  return normalized === "all" || normalized === "все";
}

export const SPIKE_RUNTIME_SETTING_COMMANDS = new Set([
  "model",
  "reasoning",
  "omni_model",
  "omni_reasoning",
]);

export function isExplicitCommandForCurrentBot(message, botUsername) {
  const text = String(message?.text ?? message?.caption ?? "");
  if (!text || !botUsername) {
    return false;
  }

  const entities = Array.isArray(message.entities)
    ? message.entities
    : Array.isArray(message.caption_entities)
      ? message.caption_entities
      : [];
  const commandEntity = entities.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  if (!commandEntity) {
    return false;
  }

  const rawCommand = text.slice(0, commandEntity.length).toLowerCase();
  return rawCommand.includes(`@${botUsername.toLowerCase()}`);
}

export function buildRuntimeSettingsProxyMessage(language = "rus") {
  if (normalizeUiLanguage(language) === "eng") {
    return [
      "These runtime-setting commands are applied by Spike.",
      "",
      "Send them in this topic without `@omnibot`.",
      "Example: `/omni_model gpt-5.4-mini`",
    ].join("\n");
  }

  return [
    "Эти runtime-команды применяет Spike.",
    "",
    "Отправляй их в этот топик без `@omnibot`.",
    "Пример: `/omni_model gpt-5.4-mini`",
  ].join("\n");
}

export function buildOmniQueryUnavailableMessage(language = "rus") {
  if (normalizeUiLanguage(language) === "eng") {
    return "Direct Omni questions work after /auto has been started in this topic.";
  }

  return "Прямые вопросы к Omni работают, если в этом топике уже был запущен /auto.";
}

export function buildOmniQueryBusyMessage(language = "rus") {
  if (normalizeUiLanguage(language) === "eng") {
    return "Omni is already answering another direct question in this topic.";
  }

  return "Omni уже отвечает на другой прямой вопрос в этом топике.";
}

export function buildOmniQueryFailureMessage(reason, language = "rus") {
  if (normalizeUiLanguage(language) === "eng") {
    return [
      "Omni query failed.",
      "",
      String(reason || "Unknown error"),
    ].join("\n");
  }

  return [
    "Запрос к Omni не удался.",
    "",
    String(reason || "Неизвестная ошибка"),
  ].join("\n");
}

export function buildOmniQueryAcceptedMessage(language = "rus") {
  if (normalizeUiLanguage(language) === "eng") {
    return "Question accepted. Preparing the Omni answer now.";
  }

  return "Вопрос принят. Готовлю ответ Omni.";
}

export function resolveSessionRepoRoot(session, fallbackRepoRoot) {
  const cwd = String(session?.workspace_binding?.cwd || "").trim();
  if (cwd) {
    return cwd;
  }

  const repoRoot = String(session?.workspace_binding?.repo_root || "").trim();
  if (repoRoot) {
    return repoRoot;
  }

  return fallbackRepoRoot;
}

export function hasOmniQueryContext(session) {
  const autoMode = session?.auto_mode || {};
  return Boolean(
    autoMode.literal_goal_text
      || autoMode.normalized_goal_interpretation
      || autoMode.initial_worker_prompt
      || autoMode.last_result_summary,
  );
}

const DIRECT_OMNI_QUESTION_PREFIXES = new Set([
  "what",
  "why",
  "how",
  "when",
  "where",
  "who",
  "which",
  "can",
  "could",
  "should",
  "would",
  "will",
  "is",
  "are",
  "do",
  "does",
  "did",
  "что",
  "чего",
  "почему",
  "зачем",
  "как",
  "какой",
  "какая",
  "какие",
  "когда",
  "где",
  "кто",
  "сколько",
  "правильно",
  "верно",
  "верно-ли",
]);

export function looksLikeDirectOmniQuestion(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return false;
  }

  if (normalized.includes("?")) {
    return true;
  }

  const firstWord = normalized
    .toLowerCase()
    .match(/^[\p{L}\p{N}-]+/u)?.[0] || "";
  return DIRECT_OMNI_QUESTION_PREFIXES.has(firstWord);
}

export function buildNoSessionReply(message, text) {
  return buildReplyMessageParams(message, text);
}
