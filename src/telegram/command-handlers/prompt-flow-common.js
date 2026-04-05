import {
  DEFAULT_UI_LANGUAGE,
  getSessionUiLanguage,
  normalizeUiLanguage,
} from "../../i18n/ui-language.js";
import { summarizeQueuedPrompt } from "../../session-manager/prompt-queue.js";
import { extractBotCommand } from "../command-parsing.js";
import { extractPromptText } from "../incoming-attachments.js";
import { GLOBAL_CONTROL_PANEL_COMMAND } from "../global-control-panel.js";

function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}

export function buildNoSessionTopicMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Use a dedicated work topic for this.",
      "",
      "General is not used as a working session.",
      "Create a new topic with /new.",
    ].join("\n");
  }

  return [
    "Для этого нужна отдельная рабочая тема.",
    "",
    "General не используется как рабочая сессия.",
    "Создай новую тему через /new.",
  ].join("\n");
}

export function buildAttachmentNeedsCaptionMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Attachment received.",
      "",
      "Add a caption in the same message, or send the task text in the next message in this topic and I will pair it with this attachment.",
    ].join("\n");
  }

  return [
    "Вложение получил.",
    "",
    "Добавь подпись в этом же сообщении, либо следующим сообщением в этом же топике пришли текст задачи, и я привяжу его к этому вложению.",
  ].join("\n");
}

export function buildQueueAttachmentNeedsPromptMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Queue attachment received.",
      "",
      "Add a caption in the same message, or send the task text in the next message with /q and I will queue it with this attachment.",
    ].join("\n");
  }

  return [
    "Вложение для очереди получил.",
    "",
    "Добавь подпись в этом же сообщении, либо следующим сообщением пришли текст через /q, и я поставлю его в очередь вместе с этим вложением.",
  ].join("\n");
}

export function buildQueueUsageMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Usage:",
      "/q <text>",
      "/q status",
      "/q delete <position>",
    ].join("\n");
  }

  return [
    "Использование:",
    "/q <text>",
    "/q status",
    "/q delete <позиция>",
  ].join("\n");
}

export function buildQueueAutoUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return "Spike queue is unavailable while /auto owns this topic.";
  }

  return "Очередь Spike недоступна, пока этим топиком управляет /auto.";
}

export function buildOmniUnavailableMessage(
  language = DEFAULT_UI_LANGUAGE,
  commandName = "omni",
) {
  if (isEnglish(language)) {
    return [
      `/${commandName} is unavailable right now.`,
      "",
      "Omni is disabled in this deployment, so Spike is running alone.",
      "Use plain prompts here like in a normal single-bot topic.",
    ].join("\n");
  }

  return [
    `/${commandName} сейчас недоступен.`,
    "",
    "Omni сейчас отключён, поэтому Spike работает один.",
    "Просто пиши сюда обычные prompt'ы как в обычную single-bot тему.",
  ].join("\n");
}

export const AUTO_MODE_ALLOWED_HUMAN_COMMANDS = new Set([
  "help",
  "status",
  "limits",
  "interrupt",
  "language",
  "diff",
  GLOBAL_CONTROL_PANEL_COMMAND,
  "model",
  "reasoning",
  "omni_model",
  "omni_reasoning",
]);

function buildQueueEmptyMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language) ? "Spike queue is empty." : "Очередь Spike пуста.";
}

function formatQueuePreview(preview) {
  const text = String(preview || "").trim();
  if (!text) {
    return "";
  }

  return `\`${text.replace(/`/gu, "ˋ")}\``;
}

export function buildQueueQueuedMessage({
  position,
  preview,
  waitingForCapacity = false,
  language = DEFAULT_UI_LANGUAGE,
}) {
  const english = isEnglish(language);
  const lines = [
    english
      ? `Queued at position ${position}.`
      : `Поставил в очередь под номером ${position}.`,
  ];

  if (waitingForCapacity) {
    lines.push(
      "",
      english
        ? "I will start it as soon as the current run fully clears."
        : "Запущу сразу после завершения текущего run.",
    );
  }

  if (preview) {
    lines.push(
      "",
      `${english ? "Summary" : "Коротко"}: ${formatQueuePreview(preview)}`,
    );
  }

  return lines.join("\n");
}

export function buildQueueDeletedMessage(
  entry,
  position,
  remainingCount,
  language = DEFAULT_UI_LANGUAGE,
) {
  const preview = formatQueuePreview(
    summarizeQueuedPrompt(entry?.raw_prompt || entry?.prompt),
  );
  const english = isEnglish(language);
  const lines = [
    english
      ? `Removed queue item #${position}.`
      : `Удалил элемент очереди #${position}.`,
  ];

  if (preview) {
    lines.push("", `${english ? "Preview" : "Коротко"}: ${preview}`);
  }

  lines.push(
    "",
    english
      ? `Remaining: ${remainingCount}`
      : `Осталось: ${remainingCount}`,
  );

  return lines.join("\n");
}

export function buildQueueDeleteMissingMessage(position, language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? `There is no queue item ${position}.`
    : `В очереди нет элемента ${position}.`;
}

export function buildQueueStatusMessage(entries = [], language = DEFAULT_UI_LANGUAGE) {
  if (!entries.length) {
    return buildQueueEmptyMessage(language);
  }

  const heading = isEnglish(language)
    ? `Spike queue: ${entries.length}`
    : `Очередь Spike: ${entries.length}`;
  return [
    heading,
    "",
    ...entries.map((entry, index) => {
      const preview = formatQueuePreview(
        summarizeQueuedPrompt(entry?.raw_prompt || entry?.prompt),
      );
      return `${index + 1}. ${preview || "`...`"}`;
    }),
  ].join("\n");
}

export function buildBusyMessage(session, language = getSessionUiLanguage(session)) {
  return isEnglish(language)
    ? [
        "I am still working in this topic.",
        "",
        "You can wait for the reply or press /interrupt.",
      ].join("\n")
    : [
        "Я ещё работаю в этой теме.",
        "",
        "Можешь дождаться ответа или нажать /interrupt.",
      ].join("\n");
}

export function buildSteerAcceptedMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Got it. I will steer this into the current run."
    : "Принял. Докину это в текущий run.";
}

export function buildCapacityMessage(
  maxParallelSessions,
  language = DEFAULT_UI_LANGUAGE,
) {
  return isEnglish(language)
    ? `The worker pool is at capacity (${maxParallelSessions}).`
    : `Пул воркеров упёрся в лимит (${maxParallelSessions}).`;
}

export function buildPromptFromMessages(messages, { bufferMode = "auto" } = {}) {
  void bufferMode;
  return messages
    .map((entry) => extractPromptText(entry, { trim: true }))
    .filter((entry) => entry.length > 0)
    .join("\n\n")
    .trim();
}

export function buildQueuedPromptFromMessages(messages, botUsername) {
  const promptMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (promptMessages.length === 0) {
    return "";
  }

  const firstMessage = promptMessages[0];
  const parsedCommand = extractBotCommand(firstMessage, botUsername);
  if (parsedCommand?.name !== "q") {
    return buildPromptFromMessages(promptMessages);
  }

  const parts = [];
  const commandText = String(parsedCommand.args || "").trim();
  if (commandText) {
    parts.push(commandText);
  }

  for (const entry of promptMessages.slice(1)) {
    const text = extractPromptText(entry, { trim: true });
    if (text) {
      parts.push(text);
    }
  }

  return parts.join("\n\n").trim();
}
