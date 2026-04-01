export const PROMPT_SUFFIX_MAX_CHARS = 4000;

export function normalizePromptSuffixText(text) {
  if (typeof text !== "string") {
    return null;
  }

  const trimmed = text.trim();
  return trimmed || null;
}

export function getEnabledPromptSuffixText(value) {
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

export function composePromptWithSuffixes(prompt, ...sources) {
  const basePrompt = String(prompt || "").trim();
  if (!basePrompt) {
    return basePrompt;
  }

  const topicSession = sources.at(0);
  if (topicSession && !isTopicPromptSuffixEnabled(topicSession)) {
    return basePrompt;
  }

  const suffixText = sources
    .map(getEnabledPromptSuffixText)
    .filter(Boolean)
    .at(0);
  if (!suffixText) {
    return basePrompt;
  }

  return `${basePrompt}\n\n${suffixText}`;
}
