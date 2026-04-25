import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import { DEFAULT_UI_LANGUAGE, isEnglish } from "./common.js";

export function buildNewTopicAckMessage(
  session,
  forumTopic,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        `Created topic "${forumTopic.name}".`,
        "Use it like a normal chat.",
      ].join("\n")
    : [
        `Создал тему «${forumTopic.name}».`,
        "Пиши туда как в обычный чат.",
      ].join("\n");
}

export function buildNewTopicHostUnavailableMessage(
  {
    hostId = "unknown",
    hostLabel = hostId,
  } = {},
  language = DEFAULT_UI_LANGUAGE,
) {
  return isEnglish(language)
    ? [
        `Cannot create a new topic on host ${hostLabel}.`,
        "",
        `Host ${hostLabel} is unavailable right now.`,
      ].join("\n")
    : [
        `Не могу создать новый топик на хосте ${hostLabel}.`,
        "",
        `Хост ${hostLabel} сейчас недоступен.`,
      ].join("\n");
}

export function buildNewTopicBootstrapMessage(
  session,
  forumTopic,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "Topic is ready.",
        "",
        `This is the work topic "${forumTopic.name}".`,
        "Just write here like in a normal chat.",
        "If you need session details, use /status.",
      ].join("\n")
    : [
        "Тема готова.",
        "",
        `Это рабочая тема «${forumTopic.name}».`,
        "Просто пиши сюда как в обычный чат.",
        "Если понадобятся детали по сессии, используй /status.",
      ].join("\n");
}

export function buildDiffCleanMessage(
  session,
  generatedAt,
  language = getSessionUiLanguage(session),
) {
  void generatedAt;
  return isEnglish(language)
    ? "Workspace diff is currently empty."
    : "Workspace diff сейчас пустой.";
}

export function buildDiffUnavailableMessage(
  session,
  generatedAt,
  language = getSessionUiLanguage(session),
) {
  void generatedAt;
  return [
    isEnglish(language)
      ? "Workspace diff is unavailable for this binding."
      : "Workspace diff недоступен для этой привязки.",
    "",
    isEnglish(language)
      ? "The current binding is not a git repository."
      : "Текущая привязка не является git-репозиторием.",
  ].join("\n");
}

export function buildDocumentTooLargeMessage(
  session,
  filePath,
  sizeBytes,
  language = getSessionUiLanguage(session),
) {
  void session;
  void filePath;
  return [
    isEnglish(language)
      ? "Artifact is too large for Telegram file delivery."
      : "Артефакт слишком большой для доставки через Telegram.",
    "",
    `size_bytes: ${sizeBytes}`,
  ].join("\n");
}

export function buildPurgeBusyMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "You cannot purge the session while topic work is still active.",
        "",
        "Wait for /compact to finish or stop the run with /interrupt first, then repeat /purge.",
      ].join("\n")
    : [
        "Нельзя чистить сессию, пока в теме ещё идёт работа.",
        "",
        "Сначала дождись завершения /compact или останови run через /interrupt, потом повтори /purge.",
      ].join("\n");
}

export function buildPurgeAckMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  void session;
  return isEnglish(language)
    ? [
        "Session state purged.",
        "",
        "Stored exchange log, active brief, and diff artifacts were removed.",
        "The next plain prompt in this same topic will start a fresh session.",
      ].join("\n")
    : [
        "Состояние сессии очищено.",
        "",
        "Сохранённые exchange log, active brief и diff-артефакты удалены.",
        "Следующий обычный prompt в этом же топике запустит свежую сессию.",
      ].join("\n");
}

export function buildPurgedSessionMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "This session is currently purged.",
        "",
        "Send a plain prompt in this topic to start a fresh session.",
      ].join("\n")
    : [
        "Эта сессия сейчас очищена.",
        "",
        "Отправь обычный prompt в этом топике, чтобы начать свежую сессию.",
      ].join("\n");
}

export function buildCompactMessage(
  session,
  compacted,
  language = getSessionUiLanguage(session),
) {
  void session;
  return isEnglish(language)
    ? [
        "Session compacted.",
        "",
        `reason: ${compacted.reason}`,
        `exchange_log_entries: ${compacted.exchangeLogEntries}`,
        "active_brief: refreshed",
      ].join("\n")
    : [
        "Сессия пересобрана.",
        "",
        `reason: ${compacted.reason}`,
        `exchange_log_entries: ${compacted.exchangeLogEntries}`,
        "active_brief: refreshed",
      ].join("\n");
}

export function buildCompactStartedMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  void session;
  return isEnglish(language)
    ? [
        "Compaction started.",
        "",
        "I will post the refreshed brief status here when it finishes.",
      ].join("\n")
    : [
        "Пересборка brief запущена.",
        "",
        "Когда закончу, пришлю итог сюда.",
      ].join("\n");
}

export function buildCompactAlreadyRunningMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  void session;
  return isEnglish(language)
    ? "Compaction is already running for this session."
    : "Для этой сессии compact уже выполняется.";
}

export function buildCompactFailureMessage(
  session,
  error,
  language = getSessionUiLanguage(session),
) {
  void session;
  void error;
  return isEnglish(language)
    ? "Compaction failed. Check the service logs for details."
    : "Не смог выполнить compact. Подробности смотри в логах сервиса.";
}

export function buildBindingResolutionErrorMessage(
  requestedPath,
  error,
  language = DEFAULT_UI_LANGUAGE,
) {
  return [
    isEnglish(language)
      ? "Failed to resolve workspace binding for /new."
      : "Не смог разрешить workspace binding для /new.",
    "",
    `requested_path: ${requestedPath || "none"}`,
    `error: ${error.message}`,
  ].join("\n");
}
