import {
  DEFAULT_UI_LANGUAGE,
  getSessionUiLanguage,
  normalizeUiLanguage,
} from "../../i18n/ui-language.js";
import { formatExecutionHostName } from "../../hosts/topic-host.js";

function isEnglish(language = DEFAULT_UI_LANGUAGE) {
  return normalizeUiLanguage(language) === "eng";
}

function formatFailureReason(reason, language = DEFAULT_UI_LANGUAGE) {
  const normalized = String(reason ?? "").trim();
  return normalized || (isEnglish(language) ? "none" : "none");
}

function formatHostState(hostStatus, language = DEFAULT_UI_LANGUAGE) {
  if (hostStatus?.ok) {
    return "ready";
  }

  if (hostStatus?.failureReason === "host-disabled") {
    return isEnglish(language) ? "disabled" : "disabled";
  }

  if (hostStatus?.failureReason === "host-unregistered") {
    return isEnglish(language) ? "unregistered" : "unregistered";
  }

  if (hostStatus?.failureReason === "host-not-ready") {
    return isEnglish(language) ? "not-ready" : "not-ready";
  }

  return isEnglish(language) ? "unavailable" : "недоступен";
}

function formatLastReadyAt(hostStatus, language = DEFAULT_UI_LANGUAGE) {
  return String(hostStatus?.lastReadyAt ?? "").trim()
    || (isEnglish(language) ? "unknown" : "неизвестно");
}

function formatHostLabel(hostStatus) {
  return formatExecutionHostName(
    hostStatus?.hostLabel ?? hostStatus?.host?.label,
    hostStatus?.hostId ?? hostStatus?.host?.host_id,
  );
}

export function buildHostStatusLines(
  hostStatus,
  language = DEFAULT_UI_LANGUAGE,
  { session = null } = {},
) {
  const hostLabel = formatHostLabel(hostStatus);
  const lines = [
    `host: ${hostLabel}`,
    `host_id: ${hostStatus?.hostId ?? hostStatus?.host?.host_id ?? "unknown"}`,
    `status: ${formatHostState(hostStatus, language)}`,
  ];

  if (hostStatus?.host?.role) {
    lines.push(`role: ${hostStatus.host.role}`);
  }

  lines.push(`last_ready_at: ${formatLastReadyAt(hostStatus, language)}`);

  if (!hostStatus?.ok) {
    lines.push(
      `failure_reason: ${formatFailureReason(hostStatus?.failureReason, language)}`,
    );
  }

  if (session?.execution_host_id) {
    lines.push(
      `topic_binding: ${session.execution_host_id}`,
      `binding_immutable: yes`,
    );
    if (session.execution_host_bound_at) {
      lines.push(`bound_at: ${session.execution_host_bound_at}`);
    }
  }

  return lines;
}

export function buildHostsOverviewMessage(
  hostStatuses,
  language = DEFAULT_UI_LANGUAGE,
  {
    heading = isEnglish(language) ? "Hosts" : "Хосты",
    includeCreationHint = false,
  } = {},
) {
  const entries = Array.isArray(hostStatuses) ? hostStatuses : [];
  const readyCount = entries.filter((entry) => entry?.ok).length;
  const lines = [
    heading,
    "",
    `ready: ${readyCount} / ${entries.length}`,
    "",
    ...entries.map((entry) => {
      const hostLabel = formatHostLabel(entry);
      const state = formatHostState(entry, language);
      const failure = entry?.ok
        ? ""
        : ` (${formatFailureReason(entry?.failureReason, language)})`;
      return `- ${hostLabel}: ${state}${failure}`;
    }),
  ];

  if (includeCreationHint) {
    lines.push(
      "",
      isEnglish(language)
        ? "Use the buttons below to choose a ready host for the next topic."
        : "Выбери кнопкой готовый хост для следующего топика.",
    );
  }

  return lines.join("\n");
}

export function buildHostStatusMessage(
  hostStatus,
  language = DEFAULT_UI_LANGUAGE,
  { session = null } = {},
) {
  const hostLabel = formatHostLabel(hostStatus);
  return [
    isEnglish(language) ? `Host ${hostLabel}` : `Хост ${hostLabel}`,
    "",
    ...buildHostStatusLines(hostStatus, language, { session }),
  ].join("\n");
}

export function buildHostSelectionStartedMessage(
  hostStatus,
  language = DEFAULT_UI_LANGUAGE,
) {
  const hostLabel = formatHostLabel(hostStatus);
  return isEnglish(language)
    ? `Send the next text message with the new topic title for host ${hostLabel}.`
    : `Отправь следующее текстовое сообщение названием нового топика для хоста ${hostLabel}.`;
}

export function resolveHostMessageLanguage(
  session = null,
  fallbackLanguage = DEFAULT_UI_LANGUAGE,
) {
  return session ? getSessionUiLanguage(session) : fallbackLanguage;
}
