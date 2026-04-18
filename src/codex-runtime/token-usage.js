function normalizeUsageCount(value) {
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return Math.trunc(value);
}

export { normalizeUsageCount };

export function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const inputTokens = normalizeUsageCount(usage.input_tokens);
  const cachedInputTokens = normalizeUsageCount(
    usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens,
  );
  const outputTokens = normalizeUsageCount(usage.output_tokens);
  const reasoningTokens = normalizeUsageCount(
    usage.reasoning_output_tokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      usage.reasoning_tokens,
  );
  const totalTokens = normalizeUsageCount(
    usage.total_tokens ??
      (inputTokens === null && outputTokens === null
        ? null
        : (inputTokens ?? 0) + (outputTokens ?? 0)),
  );

  if (
    inputTokens === null &&
    cachedInputTokens === null &&
    outputTokens === null &&
    reasoningTokens === null &&
    totalTokens === null
  ) {
    return null;
  }

  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: totalTokens,
  };
}
