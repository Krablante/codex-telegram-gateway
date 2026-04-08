import {
  DEFAULT_UI_LANGUAGE,
  formatUiLanguageLabel,
  getSessionUiLanguage,
  normalizeUiLanguage,
} from "../../i18n/ui-language.js";
import {
  isTopicPromptSuffixEnabled,
  normalizePromptSuffixText,
} from "../../session-manager/prompt-suffix.js";

function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}

function getLanguageLabel(language) {
  return formatUiLanguageLabel(language);
}

function formatWaitWindow(seconds, language = DEFAULT_UI_LANGUAGE) {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    return isEnglish(language) ? "unknown" : "неизвестно";
  }

  if (seconds % 60 === 0) {
    return `${seconds / 60}m`;
  }

  return `${seconds}s`;
}

function getWaitScopeLabel(scope, language = DEFAULT_UI_LANGUAGE) {
  const english = isEnglish(language);
  if (scope === "global") {
    return "global";
  }

  if (scope === "topic") {
    return english ? "local one-shot" : "локальный одноразовый";
  }

  return english ? "effective" : "эффективный";
}

function selectWaitStateByScope(waitState, scope = "effective") {
  if (!waitState) {
    return null;
  }

  if (scope === "global") {
    return waitState.global || null;
  }

  if (scope === "topic") {
    return waitState.local || null;
  }

  return waitState;
}

export function buildWaitUsageMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Collection windows",
      "",
      "Usage:",
      "/wait 60",
      "wait 600",
      "/wait 1m",
      "/wait global 60",
      "/wait global 1m",
      "/wait",
      "/wait off",
      "/wait global off",
      "",
      "Plain /wait <time> arms a local one-shot window for the next prompt in this topic.",
      "The local window resets automatically after that prompt is sent.",
      "/wait global <time> enables the persistent global window across topics in this chat.",
      "If both exist, the local one-shot window wins in this topic.",
      "Each new message inside the active prompt resets the timer.",
      "Send a separate `All`, `Все`, or `Всё` message to flush immediately.",
    ].join("\n");
  }

  return [
    "Collection windows",
    "",
    "Использование:",
    "/wait 60",
    "wait 600",
    "/wait 1m",
    "/wait global 60",
    "/wait global 1m",
    "/wait",
    "/wait off",
    "/wait global off",
    "",
    "Обычный /wait <время> включает local one-shot window для следующего prompt в этом топике.",
    "Local one-shot window само сбрасывается после отправки этого prompt.",
    "/wait global <время> включает persistent global window для всех тем этого чата.",
    "Если активны оба режима, в этом топике приоритет у local one-shot window.",
    "Каждое новое сообщение внутри активного prompt сбрасывает таймер.",
    "Отправь отдельным сообщением `Все`, `Всё` или `All`, чтобы запустить сразу.",
  ].join("\n");
}

export function buildWaitStateMessage(
  waitState,
  heading = "Collection windows",
  language = DEFAULT_UI_LANGUAGE,
  scope = "effective",
) {
  const english = isEnglish(language);
  const selectedState = selectWaitStateByScope(waitState, scope);
  if (!selectedState?.active) {
    return [
      heading,
      "",
      "status: off",
      "",
      scope === "global"
        ? (english
          ? "Enable it with: /wait global 60 or /wait global 1m"
          : "Включить: /wait global 60 или /wait global 1m")
        : scope === "topic"
          ? (english
            ? "Enable it with: /wait 60, wait 600, or /wait 1m"
            : "Включить: /wait 60, wait 600 или /wait 1m")
          : (english
            ? "Enable local with /wait 60 or global with /wait global 60"
            : "Включить локальный через /wait 60 или global через /wait global 60"),
    ].join("\n");
  }

  const seconds = Number.isInteger(selectedState.flushDelayMs)
    ? Math.round(selectedState.flushDelayMs / 1000)
    : null;
  const lines = [
    heading,
    "",
    "status: on",
    `scope: ${getWaitScopeLabel(selectedState.scope, language)}`,
    `timeout: ${formatWaitWindow(seconds, language)}`,
    `buffered parts: ${selectedState.messageCount ?? 0}`,
  ];

  if (scope === "effective") {
    lines.push(
      "",
      english
        ? `local one-shot: ${waitState?.local?.active ? "on" : "off"}`
        : `local one-shot: ${waitState?.local?.active ? "on" : "off"}`,
      english
        ? `global persistent: ${waitState?.global?.active ? "on" : "off"}`
        : `global persistent: ${waitState?.global?.active ? "on" : "off"}`,
    );
  }

  lines.push(
    "",
    selectedState.scope === "global"
      ? (english
        ? "This window stays enabled until /wait global off or a new /wait global <time>."
        : "Это окно остается включенным до /wait global off или нового /wait global <время>.")
      : (english
        ? "This window is local to this topic and resets after the next prompt is sent."
        : "Это окно локально для этого топика и само сбрасывается после отправки следующего prompt."),
    english
      ? "Each new message inside the active prompt resets the timer."
      : "Каждое новое сообщение внутри активного prompt сбрасывает таймер.",
    english
      ? "Send a separate `All`, `Все`, or `Всё` message to flush immediately."
      : "Отправь отдельным сообщением `Все`, `Всё` или `All`, чтобы запустить сразу.",
    selectedState.scope === "global"
      ? (english ? "Disable it: /wait global off" : "Отключить: /wait global off")
      : (english ? "Disable it: /wait off" : "Отключить: /wait off"),
  );

  return lines.join("\n");
}

export function buildWaitDisabledMessage(
  canceled,
  scope = "topic",
  language = DEFAULT_UI_LANGUAGE,
) {
  return [
    isEnglish(language)
      ? scope === "global"
        ? "Global wait is off."
        : "Local wait is off."
      : scope === "global"
        ? "Global wait is off."
        : "Local wait is off.",
    "",
    `discarded parts: ${canceled?.messageCount ?? 0}`,
  ].join("\n");
}

export function buildWaitUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "The collection window is unavailable in this runtime."
    : "Collection window недоступно в этом runtime.";
}

export function buildLanguageStateMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  const selected = getLanguageLabel(session?.ui_language ?? language);
  if (isEnglish(language)) {
    return [
      "Interface language",
      "",
      `current: ${selected}`,
      "",
      "Usage:",
      "/language",
      "/language rus",
      "/language eng",
    ].join("\n");
  }

  return [
    "Язык интерфейса",
    "",
    `current: ${selected}`,
    "",
    "Использование:",
    "/language",
    "/language rus",
    "/language eng",
  ].join("\n");
}

export function buildLanguageUpdatedMessage(session) {
  const language = getSessionUiLanguage(session);
  return [
    isEnglish(language) ? "Interface language updated." : "Язык интерфейса обновлён.",
    "",
    `current: ${getLanguageLabel(language)}`,
  ].join("\n");
}

export function buildLanguageUsageMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Language command is invalid.",
      "",
      "Use /language, /language rus, or /language eng.",
    ].join("\n");
  }

  return [
    "Команда language некорректна.",
    "",
    "Используй /language, /language rus или /language eng.",
  ].join("\n");
}

export function buildPromptSuffixMessage(
  promptSuffixState,
  heading,
  scope = "topic",
  language = DEFAULT_UI_LANGUAGE,
) {
  const suffixText = normalizePromptSuffixText(
    promptSuffixState?.prompt_suffix_text,
  );
  const setCommand =
    scope === "global" ? "/suffix global <text>" : "/suffix <text>";

  return [
    heading,
    "",
    `scope: ${scope}`,
    `status: ${promptSuffixState?.prompt_suffix_enabled && suffixText ? "on" : "off"}`,
    `text: ${suffixText ? "set" : "empty"}`,
    "",
    suffixText ||
      (isEnglish(language)
        ? `Set it with ${setCommand}.`
        : `Задай его через ${setCommand}.`),
  ].join("\n");
}

export function buildPromptSuffixTooLongMessage(
  maxChars,
  language = DEFAULT_UI_LANGUAGE,
) {
  return [
    isEnglish(language) ? "Prompt suffix is too long." : "Prompt suffix слишком длинный.",
    "",
    `max_chars: ${maxChars}`,
  ].join("\n");
}

export function buildPromptSuffixEmptyMessage(
  scope = "topic",
  language = DEFAULT_UI_LANGUAGE,
) {
  const setCommand =
    scope === "global" ? "/suffix global <text>" : "/suffix <text>";

  return [
    isEnglish(language)
      ? "Prompt suffix text is empty."
      : "Текст Prompt suffix пустой.",
    "",
    isEnglish(language)
      ? `Set it first with ${setCommand}.`
      : `Сначала задай его через ${setCommand}.`,
  ].join("\n");
}

export function buildPromptSuffixHelpMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Suffix help",
      "",
      "Local suffix in the current topic:",
      "/suffix <text>",
      "/suffix",
      "/suffix on | off | clear",
      "",
      "Global suffix for the whole gateway:",
      "/suffix global <text>",
      "/suffix global",
      "/suffix global on | off | clear",
      "",
      "Topic kill switch:",
      "/suffix topic",
      "/suffix topic off",
      "/suffix topic on",
      "",
      "Priority:",
      "1. /suffix topic off => no suffixes in this topic",
      "2. local suffix on => local overrides global",
      "3. otherwise global suffix if it is enabled",
    ].join("\n");
  }

  return [
    "Prompt suffix help",
    "",
    "Local prompt suffix в текущем топике:",
    "/suffix <text>",
    "/suffix",
    "/suffix on | off | clear",
    "",
    "Global prompt suffix для всего gateway:",
    "/suffix global <text>",
    "/suffix global",
    "/suffix global on | off | clear",
    "",
    "Топик-рубильник:",
    "/suffix topic",
    "/suffix topic off",
    "/suffix topic on",
    "",
    "Приоритет:",
    "1. /suffix topic off => prompt suffixes не применяются в этом топике",
    "2. local suffix on => local перекрывает global",
    "3. иначе применяется global prompt suffix, если он включён",
  ].join("\n");
}

export function buildTopicPromptSuffixStateMessage(
  session,
  heading,
  language = getSessionUiLanguage(session),
) {
  return [
    heading,
    "",
    "scope: topic-routing",
    `status: ${isTopicPromptSuffixEnabled(session) ? "on" : "off"}`,
    "",
    isEnglish(language)
      ? "When off, this topic ignores both local and global prompt suffixes."
      : "Когда выключено, этот топик игнорирует и local, и global prompt suffix.",
    isEnglish(language)
      ? "Use /suffix topic on or /suffix topic off."
      : "Используй /suffix topic on или /suffix topic off.",
  ].join("\n");
}

export function buildTopicPromptSuffixUsageMessage(
  language = DEFAULT_UI_LANGUAGE,
) {
  return [
    isEnglish(language)
      ? "Topic prompt suffix routing command is invalid."
      : "Команда Topic prompt suffix routing некорректна.",
    "",
    isEnglish(language)
      ? "Use /suffix topic on, /suffix topic off, or /suffix topic."
      : "Используй /suffix topic on, /suffix topic off или /suffix topic.",
  ].join("\n");
}

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
  return [
    isEnglish(language)
      ? "Workspace diff is currently empty."
      : "Workspace diff сейчас пустой.",
    "",
    `session_key: ${session.session_key}`,
    `generated_at: ${generatedAt}`,
    `cwd: ${session.workspace_binding.cwd}`,
  ].join("\n");
}

export function buildDiffUnavailableMessage(
  session,
  generatedAt,
  language = getSessionUiLanguage(session),
) {
  return [
    isEnglish(language)
      ? "Workspace diff is unavailable for this binding."
      : "Workspace diff недоступен для этой привязки.",
    "",
    isEnglish(language)
      ? "Current cwd is not a git repository."
      : "Текущий cwd не является git-репозиторием.",
    "",
    `session_key: ${session.session_key}`,
    `generated_at: ${generatedAt}`,
    `cwd: ${session.workspace_binding.cwd}`,
  ].join("\n");
}

export function buildDocumentTooLargeMessage(
  session,
  filePath,
  sizeBytes,
  language = getSessionUiLanguage(session),
) {
  return [
    isEnglish(language)
      ? "Artifact is too large for Telegram file delivery."
      : "Артефакт слишком большой для доставки через Telegram.",
    "",
    `session_key: ${session.session_key}`,
    `size_bytes: ${sizeBytes}`,
    `local_path: ${filePath}`,
  ].join("\n");
}

export function buildPurgeBusyMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "You cannot purge the session while a run is still active.",
        "",
        "Stop it with /interrupt first, then repeat /purge.",
      ].join("\n")
    : [
        "Нельзя чистить сессию, пока run ещё идёт.",
        "",
        "Сначала останови его через /interrupt, потом повтори /purge.",
      ].join("\n");
}

export function buildPurgeAckMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "Session state purged.",
        "",
        `session_key: ${session.session_key}`,
        `topic_id: ${session.topic_id}`,
        "Stored exchange log, active brief, and diff artifacts were removed.",
        "Send plain text here to start a fresh session in the same topic.",
      ].join("\n")
    : [
        "Состояние сессии очищено.",
        "",
        `session_key: ${session.session_key}`,
        `topic_id: ${session.topic_id}`,
        "Сохранённые exchange log, active brief и diff-артефакты удалены.",
        "Отправь сюда обычный текст, чтобы начать свежую сессию в этом же топике.",
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
        "Send a new message and I will start it again in the same topic.",
      ].join("\n")
    : [
        "Эта сессия сейчас очищена.",
        "",
        "Просто отправь новое сообщение, и я начну её заново в этой же теме.",
      ].join("\n");
}

export function buildCompactMessage(
  session,
  compacted,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "Session compacted.",
        "",
        `session_key: ${session.session_key}`,
        `reason: ${compacted.reason}`,
        `exchange_log_entries: ${compacted.exchangeLogEntries}`,
        "active_brief: refreshed",
      ].join("\n")
    : [
        "Сессия пересобрана.",
        "",
        `session_key: ${session.session_key}`,
        `reason: ${compacted.reason}`,
        `exchange_log_entries: ${compacted.exchangeLogEntries}`,
        "active_brief: refreshed",
      ].join("\n");
}

export function buildCompactStartedMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "Compaction started.",
        "",
        `session_key: ${session.session_key}`,
        "I will post the refreshed brief status here when it finishes.",
      ].join("\n")
    : [
        "Пересборка brief запущена.",
        "",
        `session_key: ${session.session_key}`,
        "Когда закончу, пришлю итог сюда.",
      ].join("\n");
}

export function buildCompactAlreadyRunningMessage(
  session,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "Compaction is already running for this session.",
        "",
        `session_key: ${session.session_key}`,
      ].join("\n")
    : [
        "Для этой сессии compact уже выполняется.",
        "",
        `session_key: ${session.session_key}`,
      ].join("\n");
}

export function buildCompactFailureMessage(
  session,
  error,
  language = getSessionUiLanguage(session),
) {
  return isEnglish(language)
    ? [
        "Compaction failed.",
        "",
        `session_key: ${session.session_key}`,
        `error: ${error.message}`,
      ].join("\n")
    : [
        "Не смог выполнить compact.",
        "",
        `session_key: ${session.session_key}`,
        `error: ${error.message}`,
      ].join("\n");
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
