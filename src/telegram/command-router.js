import {
  extractPromptText,
  hasIncomingAttachments,
} from "./incoming-attachments.js";
import {
  DEFAULT_UI_LANGUAGE,
  formatUiLanguageLabel,
  getSessionUiLanguage,
  isWaitFlushWord,
  normalizeUiLanguage,
} from "../i18n/ui-language.js";
import {
  buildReplyMessageParams,
  extractBotCommand,
  getTopicLabel,
  isAuthorizedMessage,
  parseLanguageCommandArgs,
  parseNewTopicCommandArgs,
  parsePromptSuffixCommandArgs,
  parseWaitCommandArgs,
} from "./command-parsing.js";
import {
  composePromptWithSuffixes,
  isTopicPromptSuffixEnabled,
  normalizePromptSuffixText,
  PROMPT_SUFFIX_MAX_CHARS,
} from "../session-manager/prompt-suffix.js";
import {
  buildLegacyContextSnapshot,
  normalizeContextSnapshot,
} from "../session-manager/context-snapshot.js";
import { getTopicIdFromMessage } from "../session-manager/session-key.js";
import { getHelpCardAsset } from "./help-card.js";
import {
  safeSendDocumentToTopic,
  safeSendMessage,
  safeSendPhotoToTopic,
} from "./topic-delivery.js";

export {
  buildReplyMessageParams,
  extractBotCommand,
  getTopicLabel,
  isAuthorizedMessage,
  parseLanguageCommandArgs,
  parseNewTopicCommandArgs,
  parsePromptSuffixCommandArgs,
  parseWaitCommandArgs,
};

export function applyPromptSuffix(prompt, session, globalPromptSuffix = null) {
  return composePromptWithSuffixes(prompt, session, globalPromptSuffix);
}

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

function buildAttachmentNeedsCaptionMessage(language = DEFAULT_UI_LANGUAGE) {
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

function formatBinding(binding) {
  return [
    `binding.repo_root: ${binding.repo_root}`,
    `binding.cwd: ${binding.cwd}`,
    `binding.branch: ${binding.branch ?? "none"}`,
    `binding.worktree_path: ${binding.worktree_path}`,
  ].join("\n");
}

function formatNumber(value, language = DEFAULT_UI_LANGUAGE) {
  return Number.isInteger(value)
    ? String(value)
    : (isEnglish(language) ? "unknown" : "неизвестно");
}

function formatPercent(value, language = DEFAULT_UI_LANGUAGE) {
  return Number.isFinite(value)
    ? `${value.toFixed(1)}%`
    : (isEnglish(language) ? "unknown" : "неизвестно");
}

function buildEffectiveContextSnapshot(
  state,
  session,
  activeRun,
  explicitSnapshot = null,
) {
  return (
    normalizeContextSnapshot(
      explicitSnapshot ??
        activeRun?.state?.contextSnapshot ??
        session.last_context_snapshot,
    ) ??
    buildLegacyContextSnapshot({
      usage: activeRun?.state?.lastTokenUsage ?? session.last_token_usage,
      contextWindow: state.codexContextWindow ?? null,
    })
  );
}

function buildContextStatusLines(contextSnapshot, language = DEFAULT_UI_LANGUAGE) {
  const usage = contextSnapshot?.last_token_usage ?? null;
  const contextWindow = contextSnapshot?.model_context_window ?? null;
  const english = isEnglish(language);

  if (!usage) {
    return [
      english
        ? "context usage: no completed turn yet"
        : "использование контекста: ещё нет завершённого turn",
      `${english ? "context tokens" : "токены контекста"}: ${english ? "unknown" : "неизвестно"} / ${formatNumber(contextWindow, language)}`,
      `${english ? "available tokens" : "доступно токенов"}: ${english ? "unknown" : "неизвестно"}`,
    ];
  }

  const totalTokens = usage.total_tokens;
  const availableTokens =
    contextWindow !== null && totalTokens !== null
      ? Math.max(contextWindow - totalTokens, 0)
      : null;
  const usagePercent =
    contextWindow !== null &&
    contextWindow > 0 &&
    totalTokens !== null
      ? (totalTokens / contextWindow) * 100
      : null;

  const lines = [
    `${english ? "context usage" : "использование контекста"}: ${formatPercent(usagePercent, language)}`,
    `${english ? "context tokens" : "токены контекста"}: ${formatNumber(totalTokens, language)} / ${formatNumber(contextWindow, language)}`,
    `${english ? "available tokens" : "доступно токенов"}: ${formatNumber(availableTokens, language)}`,
    `${english ? "input/cached/output" : "вход/кэш/выход"}: ${formatNumber(usage.input_tokens, language)} / ${formatNumber(usage.cached_input_tokens, language)} / ${formatNumber(usage.output_tokens, language)}`,
  ];

  if (usage.reasoning_tokens !== null) {
    lines.push(
      `${english ? "reasoning tokens" : "reasoning tokens"}: ${formatNumber(usage.reasoning_tokens, language)}`,
    );
  }

  return lines;
}

export function buildStatusMessage(
  state,
  message,
  session,
  activeRun = null,
  contextSnapshot = null,
  language = getSessionUiLanguage(session),
) {
  const english = isEnglish(language);
  const runStatus = activeRun?.state.status ?? session.last_run_status ?? "idle";
  const effectiveContextSnapshot = buildEffectiveContextSnapshot(
    state,
    session,
    activeRun,
    contextSnapshot,
  );
  const contextWindow =
    effectiveContextSnapshot?.model_context_window ??
    (Number.isInteger(state.codexContextWindow) ? state.codexContextWindow : null);

  return [
    english ? "Status" : "Статус",
    "",
    `${english ? "topic" : "тема"}: ${session.topic_name ?? getTopicLabel(message)}`,
    `${english ? "session" : "сессия"}: ${session.lifecycle_state}`,
    `run: ${runStatus}`,
    `${english ? "folder" : "папка"}: ${session.workspace_binding.cwd}`,
    `${english ? "branch" : "ветка"}: ${session.workspace_binding.branch ?? "none"}`,
    "",
    `${english ? "language" : "язык"}: ${getLanguageLabel(language)}`,
    `${english ? "model" : "модель"}: ${state.codexModel ?? (english ? "unknown" : "неизвестно")}`,
    `thinking: ${state.codexReasoningEffort ?? "unknown"}`,
    `${english ? "context window" : "context window"}: ${formatNumber(contextWindow, language)}`,
    `${english ? "auto-compact" : "auto-compact"}: ${formatNumber(state.codexAutoCompactTokenLimit, language)}`,
    "",
    ...buildContextStatusLines(effectiveContextSnapshot, language),
  ].join("\n");
}

export function buildInterruptMessage(
  message,
  session,
  interrupted,
  language = getSessionUiLanguage(session),
) {
  return [
    interrupted
      ? (isEnglish(language) ? "Stopping the run." : "Останавливаю run.")
      : (isEnglish(language) ? "There is no active run here right now." : "Сейчас тут нет активного run."),
    "",
    `session_key: ${session.session_key}`,
    `chat_id: ${message.chat.id}`,
    `topic_id: ${getTopicLabel(message)}`,
  ].join("\n");
}

export function buildUnknownCommandMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "Available commands: /help, /new, /status, /language, /wait, /suffix, /interrupt, /diff, /compact, and /purge."
    : "Сейчас доступны /help, /new, /status, /language, /wait, /suffix, /interrupt, /diff, /compact и /purge.";
}

function buildHelpTextMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "SEVERUS quick help",
      "",
      "/help — this cheat sheet",
      "/new [cwd=...|path=...] [title] — create a new work topic",
      "/status — session, model, and context status",
      "/language — show or change the UI language",
      "/wait 60 | wait 600 — global manual collection window",
      "`All` — flush the collected prompt immediately",
      "/wait off — disable the collection window",
      "/interrupt — stop the run",
      "/diff — diff for the current workspace",
      "/compact — rebuild the brief from the exchange log",
      "/purge — clear local session state",
      "/suffix <text> — topic prompt suffix",
      "/suffix global <text> — global prompt suffix",
      "/suffix topic on|off — routing suffixes for this topic",
      "/suffix help — separate suffix cheat sheet",
    ].join("\n");
  }

  return [
    "SEVERUS quick help",
    "",
    "/help — эта шпаргалка",
    "/new [cwd=...|path=...] [title] — новая рабочая тема",
    "/status — статус сессии, модели и контекста",
    "/language — показать или сменить язык интерфейса",
    "/wait 60 | wait 600 — global окно ручного сбора",
    "`Все` — сразу отправить накопленное",
    "/wait off — отменить окно сбора",
    "/interrupt — остановить run",
    "/diff — diff текущего workspace",
    "/compact — пересобрать brief из exchange log",
    "/purge — очистить local session state",
    "/suffix <text> — topic prompt suffix",
    "/suffix global <text> — global prompt suffix",
    "/suffix topic on|off — routing suffixes for this topic",
    "/suffix help — отдельная шпаргалка по suffix",
  ].join("\n");
}

function buildWaitUsageMessage(language = DEFAULT_UI_LANGUAGE) {
  if (isEnglish(language)) {
    return [
      "Collection window",
      "",
      "Usage:",
      "/wait 60",
      "wait 600",
      "/wait 1m",
      "/wait",
      "/wait off",
      "",
      "This mode is global across all topics in the same chat.",
      "It stays enabled until you change the timeout or send /wait off.",
      "Each new message inside the current prompt resets the timer.",
      "Send a separate `All` message to flush immediately.",
    ].join("\n");
  }

  return [
    "Окно сбора",
    "",
    "Использование:",
    "/wait 60",
    "wait 600",
    "/wait 1m",
    "/wait",
    "/wait off",
    "",
    "Режим глобальный для всех тем этого чата.",
    "Он остается включенным, пока ты не поменяешь таймаут или не дашь /wait off.",
    "Каждое новое сообщение внутри текущего prompt сбрасывает таймер.",
    "Отправь отдельным сообщением `Все`, чтобы запустить сразу.",
  ].join("\n");
}

function buildWaitStateMessage(
  waitState,
  heading = "Окно сбора",
  language = DEFAULT_UI_LANGUAGE,
) {
  const english = isEnglish(language);
  if (!waitState?.active) {
    return [
      heading,
      "",
      "status: off",
      "",
      english
        ? "Enable it with: /wait 60, wait 600, or /wait 1m"
        : "Включить: /wait 60, wait 600 или /wait 1m",
    ].join("\n");
  }

  const seconds = Number.isInteger(waitState.flushDelayMs)
    ? Math.round(waitState.flushDelayMs / 1000)
    : null;

  return [
    heading,
    "",
    `status: on`,
    `timeout: ${formatWaitWindow(seconds, language)}`,
    `buffered parts: ${waitState.messageCount ?? 0}`,
    "",
    english
      ? "This mode is global across all topics in the same chat."
      : "Режим глобальный для всех тем этого чата.",
    english
      ? "It stays enabled until /wait off or a new /wait <time>."
      : "Он остается включенным до /wait off или нового /wait <time>.",
    english
      ? "Each new message inside the current prompt resets the timer."
      : "Каждое новое сообщение внутри текущего prompt сбрасывает таймер.",
    english
      ? "Send a separate `All` message to flush immediately."
      : "Отправь отдельным сообщением `Все`, чтобы запустить сразу.",
    english ? "Disable it: /wait off" : "Отключить: /wait off",
  ].join("\n");
}

function buildWaitDisabledMessage(canceled, language = DEFAULT_UI_LANGUAGE) {
  return [
    isEnglish(language) ? "Wait mode is off." : "Режим wait выключен.",
    "",
    `discarded parts: ${canceled?.messageCount ?? 0}`,
  ].join("\n");
}

function buildWaitUnavailableMessage(language = DEFAULT_UI_LANGUAGE) {
  return isEnglish(language)
    ? "The collection window is unavailable in this runtime."
    : "Окно сбора недоступно в этом runtime.";
}

function buildLanguageStateMessage(session, language = getSessionUiLanguage(session)) {
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

function buildLanguageUpdatedMessage(session) {
  const language = getSessionUiLanguage(session);
  return [
    isEnglish(language) ? "Interface language updated." : "Язык интерфейса обновлён.",
    "",
    `current: ${getLanguageLabel(language)}`,
  ].join("\n");
}

function buildLanguageUsageMessage(language = DEFAULT_UI_LANGUAGE) {
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

function buildPromptSuffixMessage(
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

function buildPromptSuffixTooLongMessage(maxChars, language = DEFAULT_UI_LANGUAGE) {
  return [
    isEnglish(language) ? "Prompt suffix is too long." : "Prompt suffix слишком длинный.",
    "",
    `max_chars: ${maxChars}`,
  ].join("\n");
}

function buildPromptSuffixEmptyMessage(
  scope = "topic",
  language = DEFAULT_UI_LANGUAGE,
) {
  const setCommand =
    scope === "global" ? "/suffix global <text>" : "/suffix <text>";

  return [
    isEnglish(language)
      ? "Prompt suffix text is empty."
      : "Текст prompt suffix пустой.",
    "",
    isEnglish(language)
      ? `Set it first with ${setCommand}.`
      : `Сначала задай его через ${setCommand}.`,
  ].join("\n");
}

function buildPromptSuffixHelpMessage(language = DEFAULT_UI_LANGUAGE) {
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
    "Suffix help",
    "",
    "Локальный suffix в текущем топике:",
    "/suffix <text>",
    "/suffix",
    "/suffix on | off | clear",
    "",
    "Глобальный suffix для всего gateway:",
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
    "1. /suffix topic off => suffixes не применяются в этом топике",
    "2. локальный suffix on => локальный перекрывает глобальный",
    "3. иначе применяется глобальный suffix, если он включён",
  ].join("\n");
}

function buildTopicPromptSuffixStateMessage(
  session,
  heading,
  language = getSessionUiLanguage(session),
) {
  return [
    heading,
    "",
    `scope: topic-routing`,
    `status: ${isTopicPromptSuffixEnabled(session) ? "on" : "off"}`,
    "",
    isEnglish(language)
      ? "When off, this topic ignores both local and global prompt suffixes."
      : "Когда выключено, этот топик игнорирует и локальный, и глобальный prompt suffix.",
    isEnglish(language)
      ? "Use /suffix topic on or /suffix topic off."
      : "Используй /suffix topic on или /suffix topic off.",
  ].join("\n");
}

function buildTopicPromptSuffixUsageMessage(language = DEFAULT_UI_LANGUAGE) {
  return [
    isEnglish(language)
      ? "Topic prompt suffix routing command is invalid."
      : "Команда routing для topic prompt suffix некорректна.",
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
    ? [
        "The bot has hit the parallel run limit.",
        "",
        `max_parallel_sessions: ${maxParallelSessions}`,
        "Wait for one run to finish or stop an active run.",
      ].join("\n")
    : [
        "Сейчас бот упёрся в лимит параллельных run.",
        "",
        `max_parallel_sessions: ${maxParallelSessions}`,
        "Дождись завершения одного из них или останови активный run.",
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
        `active_brief: refreshed`,
      ].join("\n")
    : [
        "Сессия пересобрана.",
        "",
        `session_key: ${session.session_key}`,
        `reason: ${compacted.reason}`,
        `exchange_log_entries: ${compacted.exchangeLogEntries}`,
        `active_brief: refreshed`,
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

function markCommandHandled(serviceState, commandName) {
  serviceState.handledCommands += 1;
  serviceState.lastCommandName = commandName;
  serviceState.lastCommandAt = new Date().toISOString();
}

function launchCompactionInBackground({
  api,
  lifecycleManager,
  message,
  session,
  compactPromise,
}) {
  void (async () => {
    try {
      const compacted = await compactPromise;
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildCompactMessage(
            compacted.session,
            compacted,
            getSessionUiLanguage(compacted.session),
          ),
        ),
        compacted.session,
        lifecycleManager,
      );
    } catch (error) {
      console.error(
        `background compact failed for ${session.session_key}: ${error.message}`,
      );
      try {
        await safeSendMessage(
          api,
          buildReplyMessageParams(
            message,
            buildCompactFailureMessage(
              session,
              error,
              getSessionUiLanguage(session),
            ),
          ),
          session,
          lifecycleManager,
        );
      } catch (deliveryError) {
        console.error(
          `background compact failure reply failed for ${session.session_key}: ${deliveryError.message}`,
        );
      }
    }
  })();
}

async function handleTopicPrompt({
  api,
  config,
  lifecycleManager = null,
  message,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  return startTopicPromptRun({
    api,
    config,
    lifecycleManager,
    messages: [message],
    promptStartGuard,
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool,
  });
}

function buildPromptFromMessages(messages, { bufferMode = "auto" } = {}) {
  void bufferMode;
  return messages
    .map((entry) => extractPromptText(entry, { trim: true }))
    .filter((entry) => entry.length > 0)
    .join("\n\n")
    .trim();
}

function buildBufferedPromptFlush({
  api,
  config,
  lifecycleManager,
  promptStartGuard = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  return async (bufferedMessages, flushState = {}) => {
    if (!Array.isArray(bufferedMessages) || bufferedMessages.length === 0) {
      return;
    }

    await startTopicPromptRun({
      api,
      bufferMode: flushState.mode ?? "auto",
      config,
      lifecycleManager,
      messages: bufferedMessages,
      promptStartGuard,
      promptFragmentAssembler: null,
      serviceState,
      sessionService,
      workerPool,
    });
  };
}

function isManualWaitFlushMessage(message, promptFragmentAssembler) {
  if (!promptFragmentAssembler) {
    return false;
  }

  const waitState = promptFragmentAssembler.getStateForMessage(message);
  if (!waitState.active || waitState.mode !== "manual" || waitState.messageCount <= 0) {
    return false;
  }

  if (hasIncomingAttachments(message)) {
    return false;
  }

  const promptText = extractPromptText(message, { trim: true });
  return isWaitFlushWord(promptText);
}

async function startTopicPromptRun({
  api,
  bufferMode = "auto",
  config,
  lifecycleManager = null,
  messages,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  const promptMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const message = promptMessages.at(-1) ?? null;
  if (!message) {
    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "missing-message" };
  }

  const promptStartGuardResult =
    await promptStartGuard?.handleCompetingTopicMessage(message);
  if (promptStartGuardResult?.handled) {
    return { handled: true, reason: promptStartGuardResult.reason };
  }

  const topicId = getTopicIdFromMessage(message);
  if (!topicId) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildNoSessionTopicMessage()),
      null,
      lifecycleManager,
    );
    return { handled: true, reason: "general-topic" };
  }

  const rawPrompt = buildPromptFromMessages(promptMessages, { bufferMode });
  const prompt = rawPrompt;
  const shouldBuffer = promptFragmentAssembler?.shouldBufferMessage(message, rawPrompt);
  if (shouldBuffer) {
    promptFragmentAssembler.enqueue({
      message,
      flush: buildBufferedPromptFlush({
        api,
        config,
        lifecycleManager,
        promptStartGuard,
        serviceState,
        sessionService,
        workerPool,
      }),
    });
    return { handled: true, reason: "prompt-buffered" };
  }

  if (!prompt) {
    if (promptMessages.some((entry) => hasIncomingAttachments(entry))) {
      const attachmentSession =
        typeof sessionService.ensureSessionForMessage === "function"
          ? await sessionService.ensureSessionForMessage(message)
          : null;
      if (attachmentSession) {
        const pendingAttachments = [];
        for (const promptMessage of promptMessages) {
          if (!hasIncomingAttachments(promptMessage)) {
            continue;
          }

          pendingAttachments.push(
            ...(await sessionService.ingestIncomingAttachments(
              api,
              attachmentSession,
              promptMessage,
            )),
          );
        }

        if (
          pendingAttachments.length > 0 &&
          typeof sessionService.bufferPendingPromptAttachments === "function"
        ) {
          await sessionService.bufferPendingPromptAttachments(
            attachmentSession,
            pendingAttachments,
          );
        }
      }
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildAttachmentNeedsCaptionMessage(
            attachmentSession
              ? getSessionUiLanguage(attachmentSession)
              : DEFAULT_UI_LANGUAGE,
          ),
        ),
        attachmentSession,
        lifecycleManager,
      );
      return { handled: true, reason: "attachment-without-caption" };
    }

    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "empty-prompt" };
  }

  let session = await sessionService.ensureRunnableSessionForMessage(message);
  const globalPromptSuffix =
    typeof sessionService.getGlobalPromptSuffix === "function"
      ? await sessionService.getGlobalPromptSuffix()
      : null;
  const effectivePrompt = applyPromptSuffix(prompt, session, globalPromptSuffix);
  const attachments =
    typeof sessionService.getPendingPromptAttachments === "function"
      ? await sessionService.getPendingPromptAttachments(session)
      : [];
  for (const promptMessage of promptMessages) {
    if (!hasIncomingAttachments(promptMessage)) {
      continue;
    }

    attachments.push(
      ...(await sessionService.ingestIncomingAttachments(
        api,
        session,
        promptMessage,
      )),
    );
  }
  const started = await workerPool.startPromptRun({
    session,
    prompt: effectivePrompt,
    rawPrompt,
    message,
    attachments,
  });

  if (!started.ok) {
    if (
      started.reason === "busy" &&
      typeof workerPool.steerActiveRun === "function"
    ) {
      const steered = await workerPool.steerActiveRun({
        session,
        rawPrompt,
        message,
        attachments,
      });
      if (steered.ok) {
        if (
          attachments.length > 0 &&
          typeof sessionService.clearPendingPromptAttachments === "function"
        ) {
          session = await sessionService.clearPendingPromptAttachments(session);
        }
        const delivery = await safeSendMessage(
          api,
          buildReplyMessageParams(
            message,
            buildSteerAcceptedMessage(getSessionUiLanguage(session)),
          ),
          session,
          lifecycleManager,
        );
        if (delivery.parked) {
          return { handled: true, reason: "topic-unavailable" };
        }
        return { handled: true, reason: steered.reason || "steered" };
      }
    }

    const replyText =
      started.reason === "busy"
        ? buildBusyMessage(session, getSessionUiLanguage(session))
        : buildCapacityMessage(
            config.maxParallelSessions,
            getSessionUiLanguage(session),
          );
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, replyText),
      session,
      lifecycleManager,
    );
    if (delivery.parked) {
      return { handled: true, reason: "topic-unavailable" };
    }
    return { handled: true, reason: started.reason };
  }

  if (
    attachments.length > 0 &&
    typeof sessionService.clearPendingPromptAttachments === "function"
  ) {
    await sessionService.clearPendingPromptAttachments(session);
  }

  return { handled: true, reason: "prompt-started" };
}

export async function handleIncomingMessage({
  api,
  botUsername,
  config,
  lifecycleManager = null,
  message,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  if (!isAuthorizedMessage(message, config)) {
    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "unauthorized" };
  }

  if (isManualWaitFlushMessage(message, promptFragmentAssembler)) {
    await promptFragmentAssembler.flushPendingForMessage(message);
    return { handled: true, reason: "prompt-buffer-flushed" };
  }

  const command = extractBotCommand(message, botUsername);
  if (
    command &&
    command.name !== "wait" &&
    promptFragmentAssembler?.hasPendingForSameTopicMessage(message)
  ) {
    promptFragmentAssembler.cancelPendingForMessage(message, {
      preserveManualWindow: true,
    });
  }
  if (!command) {
    if (!message.text && !message.caption && !hasIncomingAttachments(message)) {
      serviceState.ignoredUpdates += 1;
      return { handled: false, reason: "not-a-text-message" };
    }

    return handleTopicPrompt({
      api,
      config,
      lifecycleManager,
      message,
      promptStartGuard,
      promptFragmentAssembler,
      serviceState,
      sessionService,
      workerPool,
    });
  }

  if (command.name === "new") {
    const newTopicArgs = parseNewTopicCommandArgs(command.args);
    let workspaceBinding;
    let inheritedFromSessionKey = null;

    if (newTopicArgs.bindingPath) {
      try {
        workspaceBinding = await sessionService.resolveBindingPath(
          newTopicArgs.bindingPath,
        );
      } catch (error) {
        await safeSendMessage(
          api,
          buildReplyMessageParams(
            message,
            buildBindingResolutionErrorMessage(newTopicArgs.bindingPath, error),
          ),
          null,
          lifecycleManager,
        );
        markCommandHandled(serviceState, command.name);
        return { handled: true, command: command.name, reason: "binding-error" };
      }
    } else {
      const inherited = await sessionService.resolveInheritedBinding(message);
      workspaceBinding = inherited.binding;
      inheritedFromSessionKey = inherited.inheritedFromSessionKey;
    }

    const { forumTopic, session } = await sessionService.createTopicSession({
      api,
      message,
      title: newTopicArgs.title,
      workspaceBinding,
      inheritedFromSessionKey,
    });

    await safeSendMessage(api, {
      chat_id: message.chat.id,
      message_thread_id: forumTopic.message_thread_id,
      text: buildNewTopicBootstrapMessage(session, forumTopic),
    }, session, lifecycleManager);
    const ack = await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildNewTopicAckMessage(session, forumTopic),
      ),
      session,
      lifecycleManager,
    );
    if (ack.parked) {
      await sessionService.recordHandledSession(
        serviceState,
        ack.session || session,
        command.name,
      );
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "topic-unavailable" };
    }

    await sessionService.recordHandledSession(serviceState, session, command.name);
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name };
  }

  const suffixCommand =
    command.name === "suffix"
      ? parsePromptSuffixCommandArgs(command.args)
      : null;
  const waitCommand =
    command.name === "wait"
      ? parseWaitCommandArgs(command.args)
      : null;
  const languageCommand =
    command.name === "language"
      ? parseLanguageCommandArgs(command.args)
      : null;
  const topicId = getTopicIdFromMessage(message);
  if (command.name === "suffix" && suffixCommand?.scope === "help") {
    const handledSession = topicId
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const language = handledSession
      ? getSessionUiLanguage(handledSession)
      : DEFAULT_UI_LANGUAGE;
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildPromptSuffixHelpMessage(language)),
      handledSession,
      lifecycleManager,
    );
    if (delivery.parked) {
      const parkedSession = delivery.session || handledSession;
      if (parkedSession) {
        await sessionService.recordHandledSession(
          serviceState,
          parkedSession,
          command.name,
        );
      }
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "topic-unavailable" };
    }

    if (handledSession) {
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
    }
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name };
  }

  if (command.name === "help") {
    let handledSession = topicId
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const language = handledSession
      ? getSessionUiLanguage(handledSession)
      : DEFAULT_UI_LANGUAGE;
    const helpCard = getHelpCardAsset(language);

    try {
      const delivery = await safeSendPhotoToTopic(
        api,
        message,
        {
          filePath: helpCard.filePath,
          fileName: helpCard.fileName,
          contentType: "image/png",
        },
        handledSession,
        lifecycleManager,
      );
      if (delivery.parked) {
        handledSession = delivery.session || handledSession;
        if (handledSession) {
          await sessionService.recordHandledSession(
            serviceState,
            handledSession,
            command.name,
          );
        }
        markCommandHandled(serviceState, command.name);
        return { handled: true, command: command.name, reason: "topic-unavailable" };
      }
    } catch {
      const fallbackDelivery = await safeSendMessage(
        api,
        buildReplyMessageParams(message, buildHelpTextMessage(language)),
        handledSession,
        lifecycleManager,
      );
      if (fallbackDelivery.parked) {
        handledSession = fallbackDelivery.session || handledSession;
        if (handledSession) {
          await sessionService.recordHandledSession(
            serviceState,
            handledSession,
            command.name,
          );
        }
        markCommandHandled(serviceState, command.name);
        return { handled: true, command: command.name, reason: "topic-unavailable" };
      }
    }

    if (handledSession) {
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
    }
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name };
  }

  if (command.name === "suffix" && suffixCommand?.scope === "global") {
    let handledSession = topicId
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const language = handledSession
      ? getSessionUiLanguage(handledSession)
      : DEFAULT_UI_LANGUAGE;
    let responseText = null;

    if (suffixCommand.action === "show") {
      responseText = buildPromptSuffixMessage(
        await sessionService.getGlobalPromptSuffix(),
        isEnglish(language) ? "Global prompt suffix" : "Глобальный prompt suffix",
        "global",
        language,
      );
    } else if (suffixCommand.action === "set") {
      const suffixText = normalizePromptSuffixText(suffixCommand.text);
      if (!suffixText) {
        responseText = buildPromptSuffixEmptyMessage("global", language);
      } else if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
        responseText = buildPromptSuffixTooLongMessage(PROMPT_SUFFIX_MAX_CHARS, language);
      } else {
        const updated = await sessionService.updateGlobalPromptSuffix({
          text: suffixText,
          enabled: true,
        });
        responseText = buildPromptSuffixMessage(
          updated,
          isEnglish(language)
            ? "Global prompt suffix updated."
            : "Глобальный prompt suffix обновлён.",
          "global",
          language,
        );
      }
    } else if (suffixCommand.action === "on") {
      const current = await sessionService.getGlobalPromptSuffix();
      if (!normalizePromptSuffixText(current.prompt_suffix_text)) {
        responseText = buildPromptSuffixEmptyMessage("global", language);
      } else {
        const updated = await sessionService.updateGlobalPromptSuffix({
          enabled: true,
        });
        responseText = buildPromptSuffixMessage(
          updated,
          isEnglish(language)
            ? "Global prompt suffix enabled."
            : "Глобальный prompt suffix включён.",
          "global",
          language,
        );
      }
    } else if (suffixCommand.action === "off") {
      const updated = await sessionService.updateGlobalPromptSuffix({
        enabled: false,
      });
      responseText = buildPromptSuffixMessage(
        updated,
        isEnglish(language)
          ? "Global prompt suffix disabled."
          : "Глобальный prompt suffix выключен.",
        "global",
        language,
      );
    } else if (suffixCommand.action === "clear") {
      const updated = await sessionService.clearGlobalPromptSuffix();
      responseText = buildPromptSuffixMessage(
        updated,
        isEnglish(language)
          ? "Global prompt suffix cleared."
          : "Глобальный prompt suffix очищен.",
        "global",
        language,
      );
    }

    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, responseText),
      handledSession,
      lifecycleManager,
    );
    if (delivery.parked) {
      handledSession = delivery.session || handledSession;
      if (handledSession) {
        await sessionService.recordHandledSession(
          serviceState,
          handledSession,
          command.name,
        );
      }
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "topic-unavailable" };
    }

    if (handledSession) {
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
    }
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name };
  }

  if (!topicId) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildNoSessionTopicMessage(DEFAULT_UI_LANGUAGE)),
      null,
      lifecycleManager,
    );
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name, reason: "general-topic" };
  }

  const session = await sessionService.ensureSessionForMessage(message);
  const language = getSessionUiLanguage(session);

  let responseText = null;
  let handledSession = session;
  let backgroundCompactPromise = null;
  if (command.name === "status") {
    const activeRun = workerPool.getActiveRun(session.session_key);
    const contextState =
      typeof sessionService.resolveContextSnapshot === "function"
        ? await sessionService.resolveContextSnapshot(session, {
            threadId: activeRun?.state?.threadId ?? session.codex_thread_id ?? null,
            rolloutPath:
              activeRun?.state?.rolloutPath ?? session.codex_rollout_path ?? null,
          })
        : {
            session,
            snapshot: null,
          };
    handledSession = contextState.session;
    if (activeRun?.state && contextState.snapshot) {
      activeRun.state.contextSnapshot = contextState.snapshot;
      activeRun.state.rolloutPath =
        contextState.snapshot.rollout_path ??
        handledSession.codex_rollout_path ??
        null;
    }
    responseText = buildStatusMessage(
      serviceState,
      message,
      handledSession,
      activeRun,
      contextState.snapshot,
      language,
    );
  } else if (command.name === "interrupt") {
    responseText = buildInterruptMessage(
      message,
      session,
      workerPool.interrupt(session.session_key),
      language,
    );
  } else if (command.name === "language") {
    if (languageCommand.action === "show") {
      responseText = buildLanguageStateMessage(session, language);
    } else if (languageCommand.action === "set") {
      handledSession = await sessionService.updateUiLanguage(session, {
        language: languageCommand.language,
      });
      responseText = buildLanguageUpdatedMessage(handledSession);
    } else {
      responseText = buildLanguageUsageMessage(language);
    }
  } else if (command.name === "wait") {
    if (!promptFragmentAssembler) {
      responseText = buildWaitUnavailableMessage(language);
    } else if (waitCommand.action === "show") {
      responseText = buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        isEnglish(language) ? "Collection window" : "Окно сбора",
        language,
      );
    } else if (waitCommand.action === "off") {
      const canceled = promptFragmentAssembler.cancelPendingForMessage(message);
      responseText = buildWaitDisabledMessage(canceled, language);
    } else if (waitCommand.action === "set") {
      promptFragmentAssembler.openWindow({
        message,
        flushDelayMs: waitCommand.delayMs,
        flush: buildBufferedPromptFlush({
          api,
          config,
          lifecycleManager,
          promptStartGuard,
          serviceState,
          sessionService,
          workerPool,
        }),
      });
      responseText = buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        isEnglish(language) ? "Collection window enabled." : "Окно сбора включено.",
        language,
      );
    } else {
      responseText = buildWaitUsageMessage(language);
    }
  } else if (command.name === "diff") {
    const diffArtifact = await sessionService.createDiffArtifact(session);
    if (diffArtifact.clean) {
      responseText = buildDiffCleanMessage(session, diffArtifact.generatedAt, language);
    } else {
      const sent = await safeSendDocumentToTopic(
        api,
        message,
        {
          filePath: diffArtifact.filePath,
          fileName: diffArtifact.artifact.file_name,
          caption: [
            isEnglish(language) ? "Workspace diff snapshot" : "Снимок workspace diff",
            `session_key: ${session.session_key}`,
          ].join("\n"),
        },
        handledSession,
        lifecycleManager,
      );
      handledSession = diffArtifact.session;
      if (sent.parked) {
        handledSession = sent.session || handledSession;
        await sessionService.recordHandledSession(
          serviceState,
          handledSession,
          command.name,
        );
        markCommandHandled(serviceState, command.name);
        return { handled: true, command: command.name, reason: "topic-unavailable" };
      }
      if (!sent.delivered) {
        responseText = buildDocumentTooLargeMessage(
          session,
          diffArtifact.filePath,
          sent.sizeBytes,
          language,
        );
      }
    }
  } else if (command.name === "compact") {
    if (session.lifecycle_state === "purged") {
      responseText = buildPurgedSessionMessage(session, language);
    } else if (sessionService.isCompacting?.(session)) {
      responseText = buildCompactAlreadyRunningMessage(session, language);
    } else {
      backgroundCompactPromise = sessionService.compactSession(session);
      responseText = buildCompactStartedMessage(session, language);
    }
  } else if (command.name === "suffix") {
    if (suffixCommand.scope === "topic-control") {
      if (suffixCommand.action === "show") {
        responseText = buildTopicPromptSuffixStateMessage(
          session,
          isEnglish(language)
            ? "Topic prompt suffix routing"
            : "Routing topic prompt suffix",
          language,
        );
      } else if (suffixCommand.action === "on") {
        handledSession = await sessionService.updatePromptSuffixTopicState(session, {
          enabled: true,
        });
        responseText = buildTopicPromptSuffixStateMessage(
          handledSession,
          isEnglish(language)
            ? "Topic prompt suffix routing enabled."
            : "Routing topic prompt suffix включён.",
          getSessionUiLanguage(handledSession),
        );
      } else if (suffixCommand.action === "off") {
        handledSession = await sessionService.updatePromptSuffixTopicState(session, {
          enabled: false,
        });
        responseText = buildTopicPromptSuffixStateMessage(
          handledSession,
          isEnglish(language)
            ? "Topic prompt suffix routing disabled."
            : "Routing topic prompt suffix выключен.",
          getSessionUiLanguage(handledSession),
        );
      } else {
        responseText = buildTopicPromptSuffixUsageMessage(language);
      }
    } else if (suffixCommand.action === "show") {
      responseText = buildPromptSuffixMessage(
        session,
        isEnglish(language) ? "Prompt suffix" : "Prompt suffix",
        "topic",
        language,
      );
    } else if (suffixCommand.action === "set") {
      const suffixText = normalizePromptSuffixText(suffixCommand.text);
      if (!suffixText) {
        responseText = buildPromptSuffixEmptyMessage("topic", language);
      } else if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
        responseText = buildPromptSuffixTooLongMessage(PROMPT_SUFFIX_MAX_CHARS, language);
      } else {
        handledSession = await sessionService.updatePromptSuffix(session, {
          text: suffixText,
          enabled: true,
        });
        responseText = buildPromptSuffixMessage(
          handledSession,
          isEnglish(language) ? "Prompt suffix updated." : "Prompt suffix обновлён.",
          "topic",
          getSessionUiLanguage(handledSession),
        );
      }
    } else if (suffixCommand.action === "on") {
      if (!normalizePromptSuffixText(session.prompt_suffix_text)) {
        responseText = buildPromptSuffixEmptyMessage("topic", language);
      } else {
        handledSession = await sessionService.updatePromptSuffix(session, {
          enabled: true,
        });
        responseText = buildPromptSuffixMessage(
          handledSession,
          isEnglish(language) ? "Prompt suffix enabled." : "Prompt suffix включён.",
          "topic",
          getSessionUiLanguage(handledSession),
        );
      }
    } else if (suffixCommand.action === "off") {
      handledSession = await sessionService.updatePromptSuffix(session, {
        enabled: false,
      });
      responseText = buildPromptSuffixMessage(
        handledSession,
        isEnglish(language) ? "Prompt suffix disabled." : "Prompt suffix выключен.",
        "topic",
        getSessionUiLanguage(handledSession),
      );
    } else if (suffixCommand.action === "clear") {
      handledSession = await sessionService.clearPromptSuffix(session);
      responseText = buildPromptSuffixMessage(
        handledSession,
        isEnglish(language) ? "Prompt suffix cleared." : "Prompt suffix очищен.",
        "topic",
        getSessionUiLanguage(handledSession),
      );
    }
  } else if (command.name === "purge") {
    if (workerPool.getActiveRun(session.session_key)) {
      responseText = buildPurgeBusyMessage(session, language);
    } else {
      handledSession = await sessionService.purgeSession(session);
      responseText = buildPurgeAckMessage(
        handledSession,
        getSessionUiLanguage(handledSession),
      );
    }
  } else {
    responseText = buildUnknownCommandMessage(language);
  }

  if (responseText) {
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, responseText),
      handledSession,
      lifecycleManager,
    );
    if (delivery.parked) {
      handledSession = delivery.session || handledSession;
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "topic-unavailable" };
    }
  }
  await sessionService.recordHandledSession(
    serviceState,
    handledSession,
    command.name,
  );
  markCommandHandled(serviceState, command.name);

  if (backgroundCompactPromise) {
    launchCompactionInBackground({
      api,
      lifecycleManager,
      message,
      session,
      compactPromise: backgroundCompactPromise,
    });
  }

  return { handled: true, command: command.name };
}
