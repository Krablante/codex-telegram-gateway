function flushParagraph(lines, blocks) {
  if (lines.length === 0) {
    return;
  }

  blocks.push({
    type: "paragraph",
    text: normalizeInlineMarkdown(lines.join(" ").trim()),
  });
  lines.length = 0;
}

export function normalizeInlineMarkdown(text) {
  return String(text || "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/\*([^*]+)\*/gu, "$1")
    .trim();
}

export function parseMarkdownBlocks(text) {
  const blocks = [];
  const lines = String(text || "").replace(/\r\n/gu, "\n").split("\n");
  const paragraphLines = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph(paragraphLines, blocks);
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushParagraph(paragraphLines, blocks);
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({
        type: "code",
        text: codeLines.join("\n").trimEnd(),
      });
      continue;
    }

    if (/^##\s+/u.test(trimmed)) {
      flushParagraph(paragraphLines, blocks);
      blocks.push({
        type: "heading-2",
        text: normalizeInlineMarkdown(trimmed.replace(/^##\s+/u, "")),
      });
      index += 1;
      continue;
    }

    if (/^#\s+/u.test(trimmed)) {
      flushParagraph(paragraphLines, blocks);
      blocks.push({
        type: "heading-1",
        text: normalizeInlineMarkdown(trimmed.replace(/^#\s+/u, "")),
      });
      index += 1;
      continue;
    }

    if (/^-\s+/u.test(trimmed)) {
      flushParagraph(paragraphLines, blocks);
      const items = [];
      while (index < lines.length) {
        const bullet = lines[index].trim();
        if (!/^-\s+/u.test(bullet)) {
          break;
        }
        items.push(normalizeInlineMarkdown(bullet.replace(/^-\s+/u, "")));
        index += 1;
      }
      blocks.push({ type: "bullets", items });
      continue;
    }

    if (/^\d+\.\s+/u.test(trimmed)) {
      flushParagraph(paragraphLines, blocks);
      const items = [];
      while (index < lines.length) {
        const numbered = lines[index].trim();
        if (!/^\d+\.\s+/u.test(numbered)) {
          break;
        }
        items.push(normalizeInlineMarkdown(numbered.replace(/^\d+\.\s+/u, "")));
        index += 1;
      }
      blocks.push({ type: "numbered", items });
      continue;
    }

    paragraphLines.push(trimmed);
    index += 1;
  }

  flushParagraph(paragraphLines, blocks);
  return blocks;
}
