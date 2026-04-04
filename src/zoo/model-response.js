function stripCodeFence(text) {
  const trimmed = String(text || "").trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

export function parseJsonObjectResponse(text) {
  const candidate = stripCodeFence(text);
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Model reply does not contain a JSON object");
  }

  const parsed = JSON.parse(candidate.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model reply JSON must be an object");
  }

  return parsed;
}
