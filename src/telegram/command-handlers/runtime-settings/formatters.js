import { DEFAULT_UI_LANGUAGE } from "../../../i18n/ui-language.js";
import {
  formatReasoningEffort,
} from "../../../session-manager/codex-runtime-settings.js";
import { isEnglish } from "./common.js";

function formatCodexSettingValue(kind, value, language = DEFAULT_UI_LANGUAGE) {
  if (!value) {
    return isEnglish(language) ? "default" : "по умолчанию";
  }

  if (kind === "reasoning") {
    return formatReasoningEffort(value) ?? value;
  }

  return value;
}

function formatCodexSettingSource(source, language = DEFAULT_UI_LANGUAGE) {
  const english = isEnglish(language);
  switch (source) {
    case "topic":
      return english ? "topic" : "topic";
    case "global":
      return english ? "global" : "global";
    case "default":
      return english ? "default" : "default";
    default:
      return english ? "unset" : "unset";
  }
}

export function buildCodexSettingUsageMessage(
  commandName,
  language = DEFAULT_UI_LANGUAGE,
) {
  if (isEnglish(language)) {
    return [
      `Usage: /${commandName}`,
      `/${commandName} list`,
      `/${commandName} <value>`,
      `/${commandName} clear`,
      `/${commandName} global`,
      `/${commandName} global list`,
      `/${commandName} global <value>`,
      `/${commandName} global clear`,
    ].join("\n");
  }

  return [
    `Использование: /${commandName}`,
    `/${commandName} list`,
    `/${commandName} <value>`,
    `/${commandName} clear`,
    `/${commandName} global`,
    `/${commandName} global list`,
    `/${commandName} global <value>`,
    `/${commandName} global clear`,
  ].join("\n");
}

export function buildCodexSettingStateMessage({
  title,
  commandName,
  kind,
  language = DEFAULT_UI_LANGUAGE,
  topicValue = null,
  globalValue = null,
  effectiveValue = null,
  effectiveSource = "unset",
  showTopicValue = true,
}) {
  const english = isEnglish(language);
  return [
    title,
    "",
    ...(showTopicValue
      ? [
          `${english ? "topic override" : "topic override"}: ${formatCodexSettingValue(kind, topicValue, language)}`,
        ]
      : []),
    `${english ? "global default" : "global default"}: ${formatCodexSettingValue(kind, globalValue, language)}`,
    `${english ? "effective" : "effective"}: ${formatCodexSettingValue(kind, effectiveValue, language)} (${formatCodexSettingSource(effectiveSource, language)})`,
    "",
    buildCodexSettingUsageMessage(commandName, language),
  ].join("\n");
}

export function buildCodexSettingListMessage({
  title,
  commandName,
  entries,
  language = DEFAULT_UI_LANGUAGE,
}) {
  const english = isEnglish(language);
  return [
    title,
    "",
    ...(entries.length > 0
      ? entries
      : [english ? "No values discovered." : "Не удалось определить значения."]),
    "",
    buildCodexSettingUsageMessage(commandName, language),
  ].join("\n");
}

export function formatCodexModelListEntry(model) {
  const details = [];
  if (model.displayName && model.displayName !== model.slug) {
    details.push(model.displayName);
  }
  if (model.defaultReasoningLevel) {
    details.push(`default ${model.defaultReasoningLevel}`);
  }

  return details.length > 0
    ? `- ${model.slug} — ${details.join(" · ")}`
    : `- ${model.slug}`;
}

export function formatCodexReasoningListEntry(entry) {
  const base = `- ${entry.label} (${entry.value})`;
  return entry.description ? `${base} — ${entry.description}` : base;
}

export function buildInvalidCodexSettingMessage({
  title,
  commandName,
  kind,
  invalidValue,
  entries,
  language = DEFAULT_UI_LANGUAGE,
}) {
  const english = isEnglish(language);
  return [
    english
      ? `${title}: unknown ${kind} "${invalidValue}".`
      : `${title}: неизвестное значение "${invalidValue}".`,
    "",
    ...(entries.length > 0
      ? entries
      : [english ? "No values discovered." : "Не удалось определить значения."]),
    "",
    buildCodexSettingUsageMessage(commandName, language),
  ].join("\n");
}
