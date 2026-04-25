import { formatPercent, formatResetTime, isEnglish } from "./common.js";

export function buildCodexLimitsStatusLines(
  summary,
  language = "rus",
) {
  if (summary?.unlimited) {
    return [
      `${isEnglish(language) ? "limits" : "лимиты"}: ${
        isEnglish(language) ? "unlimited" : "безлимит"
      }`,
    ];
  }

  if (!summary?.available) {
    return [
      `${isEnglish(language) ? "limits" : "лимиты"}: ${
        isEnglish(language) ? "unavailable" : "недоступны"
      }`,
    ];
  }

  return summary.windows.map((window) =>
    `${
      isEnglish(language) ? `limits ${window.label}` : `лимиты ${window.label}`
    }: ${formatPercent(window.remainingPercent)} ${
      isEnglish(language) ? "left" : "осталось"
    } -> ${formatResetTime(window.resetsAtIso)}`);
}

export function buildCodexLimitsMenuLines(
  summary,
  language = "rus",
) {
  if (summary?.unlimited) {
    return [
      `${isEnglish(language) ? "limits" : "лимиты"}: ${
        isEnglish(language) ? "unlimited" : "безлимит"
      }`,
    ];
  }

  if (!summary?.available) {
    return [
      `${isEnglish(language) ? "limits" : "лимиты"}: ${
        isEnglish(language) ? "unavailable" : "недоступны"
      }`,
    ];
  }

  return summary.windows.map((window) =>
    `${
      isEnglish(language) ? `limits ${window.label}` : `лимиты ${window.label}`
    }: ${formatPercent(window.remainingPercent)} ${
      isEnglish(language) ? "left" : "осталось"
    }`);
}

export function formatCodexLimitsMessage(
  summary,
  language = "rus",
) {
  const english = isEnglish(language);
  if (summary?.unlimited) {
    return [
      english ? "Codex limits" : "Лимиты Codex",
      "",
      `${english ? "mode" : "режим"}: ${english ? "unlimited" : "безлимит"}`,
      ...(summary.planType
        ? [`${english ? "plan" : "план"}: ${summary.planType}`]
        : []),
      ...(summary.limitName
        ? [`${english ? "limit" : "лимит"}: ${summary.limitName}`]
        : []),
      ...(summary.source
        ? [`source: ${summary.source}`]
        : []),
      ...(summary.capturedAt
        ? [
            `${english ? "captured" : "снято"}: ${formatResetTime(summary.capturedAt)}`,
          ]
        : []),
    ].join("\n");
  }

  if (!summary?.available) {
    return [
      english ? "Codex limits" : "Лимиты Codex",
      "",
      english
        ? "No readable Codex limits snapshot is available right now."
        : "Сейчас нет читаемого snapshot с лимитами Codex.",
      ...(summary?.source
        ? [
            "",
            `source: ${summary.source}`,
          ]
        : []),
    ].join("\n");
  }

  const lines = [
    english ? "Codex limits" : "Лимиты Codex",
    "",
    ...(summary.planType
      ? [`${english ? "plan" : "план"}: ${summary.planType}`]
      : []),
    ...(summary.limitName
      ? [`${english ? "limit" : "лимит"}: ${summary.limitName}`]
      : []),
    ...(summary.source
      ? [`source: ${summary.source}`]
      : []),
    ...(summary.capturedAt
      ? [
          `${english ? "captured" : "снято"}: ${formatResetTime(summary.capturedAt)}`,
        ]
      : []),
    "",
  ];

  for (const window of summary.windows) {
    lines.push(
      `${window.label}: ${formatPercent(window.remainingPercent)} ${
        english ? "left" : "осталось"
      }`,
    );
    lines.push(
      `${
        english ? `${window.label} reset` : `${window.label} сброс`
      }: ${formatResetTime(window.resetsAtIso)}`,
    );
  }

  return lines.join("\n");
}
