export function isContextWindowExceededText(value) {
  const text = String(value?.message || value || "").toLowerCase();
  return [
    "context_length_exceeded",
    "context window",
    "ran out of room",
    "input exceeds",
    "maximum context length",
    "max context length",
    "too many tokens",
    "token limit exceeded",
    "exceeds the token limit",
  ].some((phrase) => text.includes(phrase));
}
