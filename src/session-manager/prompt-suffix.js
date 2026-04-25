export const PROMPT_SUFFIX_MAX_CHARS = 4000;
export const WORK_STYLE_HEADING = "Work Style:";
const USER_PROMPT_HEADING = "User Prompt:";
const TELEGRAM_ATTACHMENT_PREAMBLES = [
  "Telegram attachments are included with this message. Use them as part of the context.",
  "К сообщению приложены вложения из Telegram. Используй их как часть контекста.",
];

function renderPromptSections(workStyleText, userPromptText) {
  const normalizedUserPrompt = String(userPromptText || "").trim();
  if (!normalizedUserPrompt) {
    return "";
  }

  const normalizedWorkStyle = normalizePromptSuffixText(workStyleText);
  if (!normalizedWorkStyle) {
    return [USER_PROMPT_HEADING, normalizedUserPrompt].join("\n");
  }

  return [
    WORK_STYLE_HEADING,
    normalizedWorkStyle,
    "",
    USER_PROMPT_HEADING,
    normalizedUserPrompt,
  ].join("\n");
}

export function normalizePromptSuffixText(text) {
  if (typeof text !== "string") {
    return null;
  }

  const trimmed = text.trim();
  return trimmed || null;
}

function getEnabledPromptSuffixText(value) {
  const suffixText = normalizePromptSuffixText(
    value?.prompt_suffix_text ?? value?.text ?? null,
  );
  const enabled = Boolean(
    value?.prompt_suffix_enabled ?? value?.enabled ?? false,
  );

  return enabled && suffixText ? suffixText : null;
}

export function isTopicPromptSuffixEnabled(session) {
  return session?.prompt_suffix_topic_enabled !== false;
}

export function resolveEffectiveWorkStyle(...sources) {
  const topicSession = sources.at(0);
  if (topicSession && !isTopicPromptSuffixEnabled(topicSession)) {
    return null;
  }

  return sources
    .map(getEnabledPromptSuffixText)
    .filter(Boolean)
    .at(0) || null;
}

export function composePromptWithSuffixes(prompt, ...sources) {
  const basePrompt = String(prompt || "").trim();
  if (!basePrompt) {
    return basePrompt;
  }

  return renderPromptSections(resolveEffectiveWorkStyle(...sources), basePrompt);
}

export function renderUserPrompt(prompt) {
  const basePrompt = String(prompt || "").trim();
  if (!basePrompt) {
    return basePrompt;
  }

  return renderPromptSections(null, basePrompt);
}

function stripTelegramAttachmentPreamble(renderedPrompt) {
  const normalizedRenderedPrompt = String(renderedPrompt || "").trim();
  if (!normalizedRenderedPrompt) {
    return normalizedRenderedPrompt;
  }

  for (const preamble of TELEGRAM_ATTACHMENT_PREAMBLES) {
    if (!normalizedRenderedPrompt.startsWith(preamble)) {
      continue;
    }

    const lines = normalizedRenderedPrompt.split("\n");
    let index = 1;
    while (index < lines.length && /^- (image|file): /u.test(lines[index])) {
      index += 1;
    }

    if (index === 1) {
      return normalizedRenderedPrompt;
    }

    return lines.slice(index).join("\n").trim() || normalizedRenderedPrompt;
  }

  return normalizedRenderedPrompt;
}

export function extractRenderedUserPrompt(renderedPrompt) {
  const normalizedRenderedPrompt = stripTelegramAttachmentPreamble(renderedPrompt);
  if (!normalizedRenderedPrompt) {
    return null;
  }

  const renderedWithoutWorkStylePrefix = `${USER_PROMPT_HEADING}\n`;
  if (normalizedRenderedPrompt.startsWith(renderedWithoutWorkStylePrefix)) {
    return normalizedRenderedPrompt
      .slice(renderedWithoutWorkStylePrefix.length)
      .trim() || null;
  }

  const workStylePrefix = `${WORK_STYLE_HEADING}\n`;
  const userPromptDelimiter = `\n\n${USER_PROMPT_HEADING}\n`;
  if (!normalizedRenderedPrompt.startsWith(workStylePrefix)) {
    return normalizedRenderedPrompt;
  }

  const delimiterIndex = normalizedRenderedPrompt.lastIndexOf(userPromptDelimiter);
  if (delimiterIndex === -1) {
    return normalizedRenderedPrompt;
  }

  return normalizedRenderedPrompt
    .slice(delimiterIndex + userPromptDelimiter.length)
    .trim() || null;
}

export function replaceRenderedUserPrompt(
  renderedPrompt,
  expectedUserPrompt,
  nextUserPrompt,
) {
  const normalizedRenderedPrompt = String(renderedPrompt || "").trim();
  if (!normalizedRenderedPrompt) {
    return normalizedRenderedPrompt;
  }

  const normalizedExpectedUserPrompt = String(expectedUserPrompt || "").trim();
  const normalizedNextUserPrompt = String(nextUserPrompt || "").trim();
  if (!normalizedExpectedUserPrompt || !normalizedNextUserPrompt) {
    return normalizedRenderedPrompt;
  }

  if (normalizedRenderedPrompt === normalizedExpectedUserPrompt) {
    return normalizedNextUserPrompt;
  }

  const renderedWithoutWorkStyle = renderPromptSections(null, normalizedExpectedUserPrompt);
  if (normalizedRenderedPrompt === renderedWithoutWorkStyle) {
    return renderPromptSections(null, normalizedNextUserPrompt);
  }

  const workStylePrefix = `${WORK_STYLE_HEADING}\n`;
  const renderedUserPromptSuffix =
    `\n\n${USER_PROMPT_HEADING}\n${normalizedExpectedUserPrompt}`;
  if (
    normalizedRenderedPrompt.startsWith(workStylePrefix)
    && normalizedRenderedPrompt.endsWith(renderedUserPromptSuffix)
  ) {
    const workStyleText = normalizedRenderedPrompt.slice(
      workStylePrefix.length,
      normalizedRenderedPrompt.length - renderedUserPromptSuffix.length,
    );
    return renderPromptSections(workStyleText, normalizedNextUserPrompt);
  }

  return normalizedRenderedPrompt;
}
