const TELEGRAM_TEXT_LIMIT = 3800;
const SUPPORTED_URL_PATTERN = /^(https?:\/\/|tg:\/\/)/iu;
const FENCE_PATTERN = /```([^\n`]*)\n?([\s\S]*?)```/gu;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/gu;
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\n]+)\)/gu;
const HEADING_PATTERN = /^#{1,6}\s+(.+)$/u;
const UNORDERED_LIST_PATTERN = /^([ \t]*)([-*+])\s+(.+)$/u;
const ORDERED_LIST_PATTERN = /^([ \t]*)(\d+)([.)])\s+(.+)$/u;
const TELEGRAM_INDENT = "\u00A0\u00A0\u00A0\u00A0";
const PLACEHOLDER_PREFIX = "\u0000TG";
const PLACEHOLDER_SUFFIX = "\u0000";
const UNORDERED_LIST_MARKERS = ["•", "◦", "▪"];

function isSupportedLinkTarget(target) {
  return SUPPORTED_URL_PATTERN.test(String(target || "").trim());
}

function formatMarkdownLink(label, target) {
  const normalizedLabel = String(label || "").trim();
  const normalizedTarget = String(target || "").trim();

  if (!normalizedTarget) {
    return normalizedLabel;
  }

  if (isSupportedLinkTarget(normalizedTarget)) {
    if (!normalizedLabel || normalizedLabel === normalizedTarget) {
      return normalizedTarget;
    }

    return `${normalizedLabel}: ${normalizedTarget}`;
  }

  return normalizedLabel || normalizedTarget;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}

function escapeHtmlAttribute(text) {
  return escapeHtml(text).replace(/"/gu, "&quot;");
}

function trimTrailingWhitespace(text) {
  return String(text || "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/[ \t]+$/gu, "")
    .trim();
}

function normalizeMarkdownTextSegment(text) {
  return trimTrailingWhitespace(
    String(text || "").replace(MARKDOWN_LINK_PATTERN, (_match, label, target) => {
      const normalizedLabel = String(label || "").trim();
      const normalizedTarget = String(target || "").trim();
      if (!normalizedTarget) {
        return normalizedLabel;
      }

      if (isSupportedLinkTarget(normalizedTarget)) {
        if (!normalizedLabel || normalizedLabel === normalizedTarget) {
          return normalizedTarget;
        }
        return `[${normalizedLabel}](${normalizedTarget})`;
      }

      return normalizedLabel || normalizedTarget;
    }),
  );
}

function normalizePlainTextSegment(text) {
  return trimTrailingWhitespace(
    String(text || "")
      .replace(MARKDOWN_LINK_PATTERN, (_match, label, target) =>
        formatMarkdownLink(label, target),
      )
      .replace(INLINE_CODE_PATTERN, "$1")
      .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
      .replace(/__([^_\n]+)__/gu, "$1")
      .replace(/~~([^~\n]+)~~/gu, "$1")
      .replace(/\|\|([^|\n]+)\|\|/gu, "$1")
      .replace(/^#{1,6}\s+/gmu, "")
      .replace(/[ \t]+\n/gu, "\n"),
  );
}

function normalizeTelegramRichSource(text) {
  const source = String(text || "");
  const chunks = [];
  let lastIndex = 0;

  for (const match of source.matchAll(FENCE_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      chunks.push(normalizeMarkdownTextSegment(source.slice(lastIndex, matchIndex)));
    }
    chunks.push(trimTrailingWhitespace(match[0]));
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < source.length) {
    chunks.push(normalizeMarkdownTextSegment(source.slice(lastIndex)));
  }

  return chunks.join("").replace(/\n{3,}/gu, "\n\n").trim();
}

function stashInlineHtml(stashed, html) {
  const index = stashed.push(html) - 1;
  return `${PLACEHOLDER_PREFIX}${index}${PLACEHOLDER_SUFFIX}`;
}

function restoreInlineHtml(text, stashed) {
  return String(text || "").replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, "gu"),
    (_match, index) => stashed[Number(index)] || "",
  );
}

function renderDelimited(text, pattern, openTag, closeTag) {
  return text.replace(pattern, (_match, inner) => {
    const normalizedInner = String(inner || "").trim();
    return normalizedInner ? `${openTag}${normalizedInner}${closeTag}` : _match;
  });
}

function renderInlineMarkdown(text) {
  const stashed = [];
  let rendered = String(text || "");

  rendered = rendered.replace(MARKDOWN_LINK_PATTERN, (_match, label, target) => {
    const normalizedLabel = String(label || "").trim();
    const normalizedTarget = String(target || "").trim();
    if (!normalizedTarget) {
      return stashInlineHtml(stashed, escapeHtml(normalizedLabel));
    }

    if (!isSupportedLinkTarget(normalizedTarget)) {
      return stashInlineHtml(stashed, escapeHtml(normalizedLabel || normalizedTarget));
    }

    const linkLabel = escapeHtml(normalizedLabel || normalizedTarget);
    const href = escapeHtmlAttribute(normalizedTarget);
    return stashInlineHtml(stashed, `<a href="${href}">${linkLabel}</a>`);
  });

  rendered = rendered.replace(INLINE_CODE_PATTERN, (_match, code) =>
    stashInlineHtml(stashed, `<code>${escapeHtml(code)}</code>`),
  );

  rendered = escapeHtml(rendered);
  rendered = renderDelimited(rendered, /\*\*([^\n]+?)\*\*/gu, "<b>", "</b>");
  rendered = renderDelimited(rendered, /__([^\n]+?)__/gu, "<u>", "</u>");
  rendered = rendered.replace(/~~([^\n]+?)~~/gu, "$1");
  rendered = rendered.replace(/\|\|([^\n]+?)\|\|/gu, "$1");
  rendered = rendered.replace(/(^|[^\w\\])\*([^\s*][^*\n]*?)\*(?!\w)/gu, (_m, prefix, inner) =>
    `${prefix}<i>${inner}</i>`,
  );
  rendered = rendered.replace(/(^|[^\w\\])_([^\s_][^_\n]*?)_(?!\w)/gu, (_m, prefix, inner) =>
    `${prefix}<i>${inner}</i>`,
  );
  return restoreInlineHtml(rendered, stashed);
}

function countIndentColumns(whitespace) {
  return String(whitespace || "")
    .split("")
    .reduce((total, char) => total + (char === "\t" ? 2 : 1), 0);
}

function renderListLine(line) {
  const unorderedMatch = String(line || "").match(UNORDERED_LIST_PATTERN);
  if (unorderedMatch) {
    const [, whitespace, , content] = unorderedMatch;
    const depth = Math.max(0, Math.floor(countIndentColumns(whitespace) / 2));
    const indent = TELEGRAM_INDENT.repeat(depth);
    const marker = UNORDERED_LIST_MARKERS[
      Math.min(depth, UNORDERED_LIST_MARKERS.length - 1)
    ];
    return `${indent}${marker} ${renderInlineMarkdown(content)}`;
  }

  const orderedMatch = String(line || "").match(ORDERED_LIST_PATTERN);
  if (orderedMatch) {
    const [, whitespace, number, delimiter, content] = orderedMatch;
    const depth = Math.max(0, Math.floor(countIndentColumns(whitespace) / 2));
    const indent = TELEGRAM_INDENT.repeat(depth);
    return `${indent}${escapeHtml(`${number}${delimiter}`)} ${renderInlineMarkdown(content)}`;
  }

  return null;
}

function renderParagraphBlock(block) {
  return String(block || "")
    .split("\n")
    .map((line) => {
      const headingMatch = line.match(HEADING_PATTERN);
      if (headingMatch) {
        return `<b>${renderInlineMarkdown(headingMatch[1].trim())}</b>`;
      }

      const listLine = renderListLine(line);
      if (listLine) {
        return listLine;
      }

      return renderInlineMarkdown(line);
    })
    .join("\n");
}

function isFenceBlock(block) {
  return /^```/u.test(String(block || "").trim());
}

function parseFenceBlock(block) {
  const match = String(block || "").match(/^```([^\n`]*)\n?([\s\S]*?)```$/u);
  if (!match) {
    return null;
  }

  return {
    language: String(match[1] || "").trim(),
    code: match[2] || "",
  };
}

function getBlockquoteMarker(line) {
  const trimmed = String(line || "").trimStart();
  if (trimmed.startsWith(">>")) {
    return ">>";
  }
  if (trimmed.startsWith(">")) {
    return ">";
  }
  return null;
}

function parseBlockquoteBlock(block) {
  const lines = String(block || "").split("\n");
  let marker = null;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const lineMarker = getBlockquoteMarker(line);
    if (!lineMarker) {
      return null;
    }
    if (!marker) {
      marker = lineMarker;
      continue;
    }
    if (marker !== lineMarker) {
      return null;
    }
  }

  if (!marker) {
    return null;
  }

  const content = lines
    .map((line) => {
      if (!line.trim()) {
        return "";
      }

      return marker === ">>"
        ? line.replace(/^\s*>>\s?/u, "")
        : line.replace(/^\s*>\s?/u, "");
    })
    .join("\n")
    .trim();

  return {
    expandable: marker === ">>",
    marker,
    content,
  };
}

function isBlockquoteBlock(block) {
  return Boolean(parseBlockquoteBlock(block));
}

function renderFenceBlock(block) {
  const parsed = parseFenceBlock(block);
  if (!parsed) {
    return `<pre>${escapeHtml(String(block || ""))}</pre>`;
  }

  const escapedCode = escapeHtml(parsed.code.replace(/\n+$/u, ""));
  if (parsed.language) {
    return `<pre><code class="language-${escapeHtmlAttribute(parsed.language)}">${escapedCode}</code></pre>`;
  }

  return `<pre>${escapedCode}</pre>`;
}

function renderBlockquoteBlock(block) {
  const parsed = parseBlockquoteBlock(block);
  if (!parsed) {
    return renderParagraphBlock(block);
  }

  const rendered = renderParagraphBlock(parsed.content);
  return parsed.expandable
    ? `<blockquote expandable>${rendered}</blockquote>`
    : `<blockquote>${rendered}</blockquote>`;
}

function renderMarkdownBlock(block) {
  if (isFenceBlock(block)) {
    return renderFenceBlock(block);
  }

  if (isBlockquoteBlock(block)) {
    return renderBlockquoteBlock(block);
  }

  return renderParagraphBlock(block);
}

function splitNonFenceBlocks(segment) {
  return String(segment || "")
    .split(/\n{2,}/u)
    .map((block) => trimTrailingWhitespace(block))
    .filter(Boolean);
}

function splitMarkdownBlocks(text) {
  const normalized = trimTrailingWhitespace(text);
  if (!normalized) {
    return [];
  }

  const blocks = [];
  let lastIndex = 0;

  for (const match of normalized.matchAll(FENCE_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      blocks.push(...splitNonFenceBlocks(normalized.slice(lastIndex, matchIndex)));
    }
    blocks.push(trimTrailingWhitespace(match[0]));
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < normalized.length) {
    blocks.push(...splitNonFenceBlocks(normalized.slice(lastIndex)));
  }

  return blocks;
}

function splitFenceCodeLines(language, code, limit) {
  const lines = String(code || "").split("\n");
  const chunks = [];
  let current = [];

  const buildFence = (candidateLines) => {
    const body = candidateLines.join("\n");
    return language ? `\`\`\`${language}\n${body}\n\`\`\`` : `\`\`\`\n${body}\n\`\`\``;
  };

  const pushCurrent = () => {
    if (current.length > 0) {
      chunks.push(buildFence(current));
      current = [];
    }
  };

  for (const line of lines) {
    const candidate = buildFence([...current, line]);
    if (renderMarkdownBlock(candidate).length <= limit || current.length === 0) {
      current.push(line);
      if (renderMarkdownBlock(buildFence(current)).length <= limit) {
        continue;
      }
    }

    if (current.length > 0) {
      current.pop();
      pushCurrent();
    }

    let remainder = line;
    while (remainder.length > 0) {
      let sliceLength = remainder.length;
      while (sliceLength > 1) {
        const slice = remainder.slice(0, sliceLength);
        if (renderMarkdownBlock(buildFence([slice])).length <= limit) {
          chunks.push(buildFence([slice]));
          remainder = remainder.slice(sliceLength);
          break;
        }
        sliceLength -= 1;
      }

      if (sliceLength === 1) {
        chunks.push(buildFence([remainder.slice(0, 1)]));
        remainder = remainder.slice(1);
      }
    }
  }

  pushCurrent();
  return chunks.filter(Boolean);
}

function splitBlockquoteLines(block, limit) {
  const parsed = parseBlockquoteBlock(block);
  const marker = parsed?.marker || ">";
  const lines = String(block || "")
    .split("\n")
    .filter((line) => line.trim());
  const chunks = [];
  let current = [];

  const buildBlock = (candidateLines) => candidateLines.join("\n");

  for (const line of lines) {
    const candidate = buildBlock([...current, line]);
    if (renderMarkdownBlock(candidate).length <= limit || current.length === 0) {
      current.push(line);
      if (renderMarkdownBlock(buildBlock(current)).length <= limit) {
        continue;
      }
    }

    if (current.length > 0) {
      current.pop();
      chunks.push(buildBlock(current));
      current = [];
    }

    let remainder = line;
    while (remainder.length > 0) {
      let sliceLength = remainder.length;
      while (sliceLength > 1) {
        const slice = remainder.slice(0, sliceLength);
        const candidateLine = slice.startsWith(marker) ? slice : `${marker} ${slice}`;
        if (renderMarkdownBlock(candidateLine).length <= limit) {
          chunks.push(candidateLine);
          remainder = remainder.slice(sliceLength).trimStart();
          break;
        }
        sliceLength -= 1;
      }

      if (sliceLength === 1) {
        chunks.push(`${marker} ${remainder.slice(0, 1)}`);
        remainder = remainder.slice(1).trimStart();
      }
    }
  }

  if (current.length > 0) {
    chunks.push(buildBlock(current));
  }

  return chunks.filter(Boolean);
}

function splitParagraphByWords(block, limit) {
  const lines = String(block || "").split("\n");
  const chunks = [];

  const splitLongUnit = (unit) => {
    const unitChunks = [];
    let remainder = unit;

    while (remainder.length > 0) {
      let sliceLength = remainder.length;
      while (sliceLength > 1) {
        const slice = remainder.slice(0, sliceLength);
        if (renderMarkdownBlock(slice).length <= limit) {
          unitChunks.push(slice);
          remainder = remainder.slice(sliceLength);
          break;
        }
        sliceLength -= 1;
      }

      if (sliceLength === 1) {
        unitChunks.push(remainder.slice(0, 1));
        remainder = remainder.slice(1);
      }
    }

    return unitChunks;
  };

  const splitLine = (line) => {
    if (!line.trim()) {
      return [line];
    }

    const words = line.split(/\s+/u);
    const lineChunks = [];
    let current = "";

    const pushCurrent = () => {
      if (current) {
        lineChunks.push(current);
        current = "";
      }
    };

    for (const word of words) {
      if (!current) {
        if (renderMarkdownBlock(word).length <= limit) {
          current = word;
        } else {
          lineChunks.push(...splitLongUnit(word));
        }
        continue;
      }

      const candidate = `${current} ${word}`;
      if (renderMarkdownBlock(candidate).length <= limit) {
        current = candidate;
        continue;
      }

      pushCurrent();
      if (renderMarkdownBlock(word).length <= limit) {
        current = word;
      } else {
        lineChunks.push(...splitLongUnit(word));
      }
    }

    pushCurrent();
    return lineChunks;
  };

  for (const line of lines) {
    chunks.push(...splitLine(line));
  }

  return chunks.filter(Boolean);
}

function splitOversizeBlock(block, limit = TELEGRAM_TEXT_LIMIT) {
  if (renderMarkdownBlock(block).length <= limit) {
    return [block];
  }

  if (isFenceBlock(block)) {
    const parsed = parseFenceBlock(block);
    return splitFenceCodeLines(parsed?.language || "", parsed?.code || "", limit);
  }

  if (isBlockquoteBlock(block)) {
    return splitBlockquoteLines(block, limit);
  }

  return splitParagraphByWords(block, limit);
}

function renderBlocksToChunks(blocks, limit = TELEGRAM_TEXT_LIMIT) {
  const chunks = [];
  let current = "";

  const pushCurrent = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const block of blocks) {
    const rendered = renderMarkdownBlock(block);
    if (!rendered) {
      continue;
    }

    const candidate = current ? `${current}\n\n${rendered}` : rendered;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    pushCurrent();
    current = rendered;
  }

  pushCurrent();
  return chunks;
}

export function normalizeTelegramReply(text) {
  const source = String(text || "");
  const chunks = [];
  let lastIndex = 0;

  for (const match of source.matchAll(FENCE_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      chunks.push(normalizePlainTextSegment(source.slice(lastIndex, matchIndex)));
    }
    chunks.push(trimTrailingWhitespace(match[0]));
    lastIndex = matchIndex + match[0].length;
  }

  if (lastIndex < source.length) {
    chunks.push(normalizePlainTextSegment(source.slice(lastIndex)));
  }

  return chunks.join("").replace(/\n{3,}/gu, "\n\n").trim();
}

export function renderTelegramHtml(text) {
  const blocks = splitMarkdownBlocks(normalizeTelegramRichSource(text));
  return renderBlocksToChunks(blocks, Number.MAX_SAFE_INTEGER).join("\n\n").trim();
}

export function splitTelegramReply(text, limit = TELEGRAM_TEXT_LIMIT) {
  const blocks = splitMarkdownBlocks(normalizeTelegramRichSource(text));
  const expandedBlocks = blocks.flatMap((block) => splitOversizeBlock(block, limit));
  return renderBlocksToChunks(expandedBlocks, limit);
}
