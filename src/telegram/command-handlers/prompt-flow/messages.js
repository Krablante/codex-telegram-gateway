import {
  DEFAULT_UI_LANGUAGE,
  getSessionUiLanguage,
  normalizeUiLanguage,
} from "../../../i18n/ui-language.js";
import { formatExecutionHostName } from "../../../hosts/topic-host.js";
import { summarizeQueuedPrompt } from "../../../session-manager/prompt-queue.js";

function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}

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

export function buildExecutionHostUnavailableMessage(
  session,
  {
    hostId = null,
    hostLabel = null,
  } = {},
  language = getSessionUiLanguage(session),
) {
  const hostName = formatExecutionHostName(
    hostLabel,
    hostId || session?.execution_host_id,
  );
  return isEnglish(language)
    ? [
        `This topic is bound to host ${hostName}.`,
        "",
        `Host ${hostName} is unavailable right now.`,
        "Wait for it to come back, or create a new topic on another host.",
      ].join("\n")
    : [
        `Эта тема привязана к хосту ${hostName}.`,
        "",
        `Хост ${hostName} сейчас недоступен.`,
        "Дождись его возврата или создай новый топик на другом хосте.",
      ].join("\n");
}

export function buildMissingTopicBindingMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? [
        "This topic has no safe saved host binding.",
        "",
        "I will not start a run here because that could rebind the topic to the wrong host.",
        "Restore the topic state, or create a new topic with /new.",
      ].join("\n")
    : [
        "У этого топика нет безопасно сохранённой привязки к хосту.",
        "",
        "Run здесь не стартую, чтобы не перебиндить тему на неправильный хост.",
        "Восстанови state этого топика или создай новый через /new.",
      ].join("\n");
}

export function buildSteerAcceptedMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Got it. I will steer this into the current run."
    : "Принял. Докину это в текущий run.";
}

export function buildSteerDeferredMessage({
  position = 1,
  preview = "",
  language = DEFAULT_UI_LANGUAGE,
}) {
  const english = isEnglish(language);
  const lines = [
    english
      ? "Live steer is unavailable right now."
      : "Сейчас live steer недоступен.",
    "",
    position === 1
      ? (english
        ? "Queued this as the next prompt."
        : "Поставил это следующим prompt'ом.")
      : (english
        ? `Queued this at position ${position}.`
        : `Поставил это в очередь под номером ${position}.`),
  ];

  if (position === 1) {
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

export function buildCapacityMessage(
  maxParallelSessions,
  language = DEFAULT_UI_LANGUAGE,
) {
  return isEnglish(language)
    ? `The worker pool is at capacity (${maxParallelSessions}).`
    : `Пул воркеров упёрся в лимит (${maxParallelSessions}).`;
}
