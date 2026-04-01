function formatMarkdownLink(label, target) {
  const normalizedLabel = String(label || "").trim();
  const normalizedTarget = String(target || "").trim();

  if (!normalizedTarget) {
    return normalizedLabel;
  }

  if (/^https?:\/\//u.test(normalizedTarget)) {
    if (!normalizedLabel || normalizedLabel === normalizedTarget) {
      return normalizedTarget;
    }

    return `${normalizedLabel}: ${normalizedTarget}`;
  }

  if (normalizedLabel) {
    return normalizedLabel;
  }

  return normalizedTarget;
}

function normalizeTextSegment(text) {
  return String(text || "")
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/gu, (_match, label, target) =>
      formatMarkdownLink(label, target),
    )
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
    .replace(/__([^_\n]+)__/gu, "$1")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/[ \t]+\n/gu, "\n");
}

export function normalizeTelegramReply(text) {
  const source = String(text || "");
  const fencePattern = /```[\s\S]*?```/gu;
  const chunks = [];
  let lastIndex = 0;

  for (const match of source.matchAll(fencePattern)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      chunks.push(normalizeTextSegment(source.slice(lastIndex, matchIndex)));
    }
    chunks.push(match[0]);
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < source.length) {
    chunks.push(normalizeTextSegment(source.slice(lastIndex)));
  }

  return chunks.join("").replace(/\n{3,}/gu, "\n\n").trim();
}
