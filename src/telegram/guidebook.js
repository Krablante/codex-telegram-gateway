import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import PDFDocument from "pdfkit";

import { normalizeUiLanguage } from "../i18n/ui-language.js";

const GUIDEBOOK_SOURCES = {
  rus: fileURLToPath(new URL("../../docs/guidebook-rus.md", import.meta.url)),
  eng: fileURLToPath(new URL("../../docs/guidebook-eng.md", import.meta.url)),
};

const RUNBOOK_SOURCES = {
  rus: fileURLToPath(new URL("../../docs/runbook-rus.md", import.meta.url)),
  eng: fileURLToPath(new URL("../../docs/runbook.md", import.meta.url)),
};

const GUIDEBOOK_RASTERIZE_SCRIPT = fileURLToPath(
  new URL("../../scripts/rasterize-pdf.py", import.meta.url),
);

const GUIDEBOOK_FILE_NAMES = {
  rus: "codex-telegram-guidebook-rus.pdf",
  eng: "codex-telegram-guidebook-eng.pdf",
};

const RUNBOOK_FILE_NAMES = {
  rus: "codex-telegram-runbook-rus.pdf",
  eng: "codex-telegram-runbook-eng.pdf",
};

const PAGE = {
  size: "A4",
  margins: {
    top: 44,
    bottom: 48,
    left: 46,
    right: 46,
  },
};

const FONT_CANDIDATES = {
  sans: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
  ],
  bold: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  ],
  mono: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
  ],
};

function resolveFontPath(candidates = []) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

const RESOLVED_FONTS = {
  sans: resolveFontPath(FONT_CANDIDATES.sans),
  bold: resolveFontPath(FONT_CANDIDATES.bold),
  mono: resolveFontPath(FONT_CANDIDATES.mono),
};

function registerFonts(doc) {
  if (RESOLVED_FONTS.sans) {
    doc.registerFont("GuideSans", RESOLVED_FONTS.sans);
  }
  if (RESOLVED_FONTS.bold) {
    doc.registerFont("GuideBold", RESOLVED_FONTS.bold);
  }
  if (RESOLVED_FONTS.mono) {
    doc.registerFont("GuideMono", RESOLVED_FONTS.mono);
  }
}

function getFontName(kind) {
  if (kind === "bold") {
    return RESOLVED_FONTS.bold ? "GuideBold" : "Helvetica-Bold";
  }
  if (kind === "mono") {
    return RESOLVED_FONTS.mono ? "GuideMono" : "Courier";
  }
  return RESOLVED_FONTS.sans ? "GuideSans" : "Helvetica";
}

function getNormalizedLanguage(language) {
  return normalizeUiLanguage(language) === "eng" ? "eng" : "rus";
}

function getGuidebookSourcePath(language) {
  return GUIDEBOOK_SOURCES[getNormalizedLanguage(language)] || GUIDEBOOK_SOURCES.rus;
}

function getGuidebookFileName(language) {
  return GUIDEBOOK_FILE_NAMES[getNormalizedLanguage(language)] || GUIDEBOOK_FILE_NAMES.rus;
}

function getRunbookSourcePath(language) {
  return RUNBOOK_SOURCES[getNormalizedLanguage(language)] || RUNBOOK_SOURCES.rus;
}

function getRunbookFileName(language) {
  return RUNBOOK_FILE_NAMES[getNormalizedLanguage(language)] || RUNBOOK_FILE_NAMES.rus;
}

function resolveGuidebookOutputPath(language, stateRoot = null) {
  const outputRoot = stateRoot
    ? path.join(stateRoot, "tmp", "guidebook")
    : path.join(os.tmpdir(), "codex-telegram-gateway-guidebook");
  return path.join(outputRoot, getGuidebookFileName(language));
}

function resolveRunbookOutputPath(language, stateRoot = null) {
  const outputRoot = stateRoot
    ? path.join(stateRoot, "tmp", "runbook")
    : path.join(os.tmpdir(), "codex-telegram-gateway-runbook");
  return path.join(outputRoot, getRunbookFileName(language));
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function bottomLimit(doc) {
  return doc.page.height - doc.page.margins.bottom;
}

function ensureSpace(doc, neededHeight) {
  if (doc.y + neededHeight <= bottomLimit(doc)) {
    return;
  }

  doc.addPage();
}

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

function normalizeInlineMarkdown(text) {
  return String(text || "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/\*([^*]+)\*/gu, "$1")
    .trim();
}

function parseMarkdownBlocks(text) {
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
      blocks.push({
        type: "bullets",
        items,
      });
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
      blocks.push({
        type: "numbered",
        items,
      });
      continue;
    }

    paragraphLines.push(trimmed);
    index += 1;
  }

  flushParagraph(paragraphLines, blocks);
  return blocks;
}

function drawPageHeader(doc, footerLabel, pageNumber) {
  const headerY = 18;
  doc
    .font(getFontName("sans"))
    .fontSize(8.5)
    .fillColor("#94A3B8")
    .text(
      footerLabel,
      doc.page.margins.left,
      headerY,
      {
        width: contentWidth(doc) / 2,
        align: "left",
        lineBreak: false,
      },
    )
    .text(
      `${pageNumber}`,
      doc.page.margins.left,
      headerY,
      {
        width: contentWidth(doc),
        align: "right",
        lineBreak: false,
      },
    );
  doc.x = doc.page.margins.left;
  doc.y = doc.page.margins.top;
}

function drawHeading(doc, text, level = 1) {
  const size = level === 1 ? 20 : 13.5;
  const color = level === 1 ? "#0F172A" : "#111827";
  const gapBefore = level === 1 ? 0 : 8;
  const gapAfter = level === 1 ? 8 : 4;
  doc.font(getFontName("bold")).fontSize(size);
  const height = doc.heightOfString(text, {
    width: contentWidth(doc),
    lineGap: 2,
  });
  ensureSpace(doc, gapBefore + height + gapAfter);
  if (gapBefore > 0) {
    doc.moveDown(gapBefore / 12);
  }
  const startX = doc.page.margins.left;
  const startY = doc.y;
  doc
    .font(getFontName("bold"))
    .fontSize(size)
    .fillColor(color)
    .text(text, startX, startY, {
      width: contentWidth(doc),
      lineGap: 2,
    });
  doc.x = startX;
  doc.moveDown(gapAfter / 12);
}

function estimateHeadingHeight(doc, text, level = 1) {
  const size = level === 1 ? 20 : 13.5;
  const gapBefore = level === 1 ? 0 : 8;
  const gapAfter = level === 1 ? 8 : 4;
  doc.font(getFontName("bold")).fontSize(size);
  const height = doc.heightOfString(text, {
    width: contentWidth(doc),
    lineGap: 2,
  });
  return gapBefore + height + gapAfter;
}

function drawParagraph(doc, text, { lead = false } = {}) {
  const fontSize = lead ? 11.2 : 10.2;
  const lineGap = lead ? 2.2 : 1.7;
  const color = lead ? "#334155" : "#1F2937";
  doc.font(getFontName("sans")).fontSize(fontSize);
  const height = doc.heightOfString(text, {
    width: contentWidth(doc),
    lineGap,
  });
  ensureSpace(doc, height + 8);
  const startX = doc.page.margins.left;
  const startY = doc.y;
  doc
    .font(getFontName("sans"))
    .fontSize(fontSize)
    .fillColor(color)
    .text(text, startX, startY, {
      width: contentWidth(doc),
      lineGap,
    });
  doc.x = startX;
  doc.moveDown(0.35);
}

function estimateParagraphHeight(doc, text, { lead = false } = {}) {
  const fontSize = lead ? 11.2 : 10.2;
  const lineGap = lead ? 2.2 : 1.7;
  doc.font(getFontName("sans")).fontSize(fontSize);
  const height = doc.heightOfString(text, {
    width: contentWidth(doc),
    lineGap,
  });
  return height + 8;
}

function drawList(doc, items, { ordered = false } = {}) {
  const bulletIndent = 18;
  const textWidth = contentWidth(doc) - bulletIndent;
  const startX = doc.page.margins.left;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const marker = ordered ? `${index + 1}.` : "\u2022";
    const itemHeight = Math.max(
      doc.heightOfString(String(marker), { width: bulletIndent }),
      doc.heightOfString(item, { width: textWidth, lineGap: 1.7 }),
    );
    ensureSpace(doc, itemHeight + 2);
    doc.font(getFontName("sans")).fontSize(9.8).fillColor("#1F2937");
    const startY = doc.y;
    doc.text(marker, startX, startY, {
      width: bulletIndent,
      lineGap: 1.7,
    });
    doc.text(item, startX + bulletIndent, startY, {
      width: textWidth,
      lineGap: 1.7,
    });
    doc.y = Math.max(doc.y, startY + itemHeight);
    doc.moveDown(0.08);
  }
  doc.x = startX;
  doc.moveDown(0.2);
}

function estimateListHeight(doc, items, { ordered = false } = {}) {
  const bulletIndent = 18;
  const textWidth = contentWidth(doc) - bulletIndent;
  doc.font(getFontName("sans")).fontSize(9.8);
  let totalHeight = 0;
  for (let index = 0; index < items.length; index += 1) {
    const marker = ordered ? `${index + 1}.` : "\u2022";
    totalHeight += Math.max(
      doc.heightOfString(String(marker), { width: bulletIndent }),
      doc.heightOfString(items[index], { width: textWidth, lineGap: 1.7 }),
    );
    totalHeight += 4;
  }
  return totalHeight + 4;
}

function drawCode(doc, text) {
  const innerPadding = 8;
  const width = contentWidth(doc);
  doc.font(getFontName("mono")).fontSize(8.2);
  const textHeight = doc.heightOfString(text, {
    width: width - innerPadding * 2,
    lineGap: 1.2,
  });
  const boxHeight = textHeight + innerPadding * 2;
  ensureSpace(doc, boxHeight + 5);
  const x = doc.page.margins.left;
  const y = doc.y;
  doc.save();
  doc.roundedRect(x, y, width, boxHeight, 10).fill("#F6EFD9");
  doc.restore();
  doc
    .font(getFontName("mono"))
    .fontSize(8.2)
    .fillColor("#111827")
    .text(text, x + innerPadding, y + innerPadding, {
      width: width - innerPadding * 2,
      lineGap: 1.2,
    });
  doc.x = x;
  doc.y = y + boxHeight;
  doc.moveDown(0.3);
}

function estimateCodeHeight(doc, text) {
  const innerPadding = 8;
  const width = contentWidth(doc);
  doc.font(getFontName("mono")).fontSize(8.2);
  const textHeight = doc.heightOfString(text, {
    width: width - innerPadding * 2,
    lineGap: 1.2,
  });
  return textHeight + innerPadding * 2 + 5;
}

function estimateBlockHeight(doc, block, { leadParagraph = false } = {}) {
  if (!block) {
    return 0;
  }

  if (block.type === "heading-1") {
    return estimateHeadingHeight(doc, block.text, 1);
  }
  if (block.type === "heading-2") {
    return estimateHeadingHeight(doc, block.text, 2);
  }
  if (block.type === "paragraph") {
    return estimateParagraphHeight(doc, block.text, { lead: !leadParagraph });
  }
  if (block.type === "bullets") {
    return estimateListHeight(doc, block.items, { ordered: false });
  }
  if (block.type === "numbered") {
    return estimateListHeight(doc, block.items, { ordered: true });
  }
  if (block.type === "code") {
    return estimateCodeHeight(doc, block.text);
  }

  return 0;
}

async function execFileAsync(command, args) {
  await new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function rasterizeGuidebookPdf({ inputPath, outputPath }) {
  try {
    await execFileAsync("python3", [
      GUIDEBOOK_RASTERIZE_SCRIPT,
      inputPath,
      outputPath,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function renderGuidebookVectorPdf({ language, outputPath }) {
  const normalizedLanguage = getNormalizedLanguage(language);
  const sourcePath = getGuidebookSourcePath(normalizedLanguage);
  const markdown = await fsp.readFile(sourcePath, "utf8");
  const blocks = parseMarkdownBlocks(markdown);
  const titleBlock = blocks.find((block) => block.type === "heading-1");
  const title = titleBlock?.text || "Guidebook";
  const footerLabel =
    normalizedLanguage === "eng"
      ? "Spike + Omni guidebook"
      : "Spike + Omni guidebook";

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      ...PAGE,
      bufferPages: true,
      info: {
        Title: title,
        Author: "codex-telegram-gateway",
        Subject: footerLabel,
      },
    });
    const stream = fs.createWriteStream(outputPath);

    doc.pipe(stream);
    registerFonts(doc);
    let currentPageNumber = 1;
    drawPageHeader(doc, footerLabel, currentPageNumber);
    doc.on("pageAdded", () => {
      currentPageNumber += 1;
      drawPageHeader(doc, footerLabel, currentPageNumber);
    });

    let firstParagraphDrawn = false;
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.type === "heading-1") {
        const nextBlock = blocks[index + 1];
        ensureSpace(
          doc,
          estimateBlockHeight(doc, block) +
            estimateBlockHeight(doc, nextBlock, {
              leadParagraph: firstParagraphDrawn,
            }),
        );
        drawHeading(doc, block.text, 1);
        continue;
      }
      if (block.type === "heading-2") {
        const nextBlock = blocks[index + 1];
        ensureSpace(
          doc,
          estimateBlockHeight(doc, block) +
            estimateBlockHeight(doc, nextBlock, {
              leadParagraph: firstParagraphDrawn,
            }),
        );
        drawHeading(doc, block.text, 2);
        continue;
      }
      if (block.type === "paragraph") {
        drawParagraph(doc, block.text, { lead: !firstParagraphDrawn });
        firstParagraphDrawn = true;
        continue;
      }
      if (block.type === "bullets") {
        drawList(doc, block.items, { ordered: false });
        continue;
      }
      if (block.type === "numbered") {
        drawList(doc, block.items, { ordered: true });
        continue;
      }
      if (block.type === "code") {
        drawCode(doc, block.text);
      }
    }

    doc.end();

    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);
  });

  return {
    filePath: outputPath,
    fileName: getGuidebookFileName(normalizedLanguage),
    contentType: "application/pdf",
    sourcePath,
  };
}

async function renderRunbookVectorPdf({ language, outputPath }) {
  const normalizedLanguage = getNormalizedLanguage(language);
  const sourcePath = getRunbookSourcePath(normalizedLanguage);
  const markdown = await fsp.readFile(sourcePath, "utf8");
  const blocks = parseMarkdownBlocks(markdown);
  const titleBlock = blocks.find((block) => block.type === "heading-1");
  const title =
    titleBlock?.text ||
    (normalizedLanguage === "eng"
      ? "Codex Telegram Gateway Runbook"
      : "Runbook для Codex Telegram Gateway");
  const footerLabel =
    normalizedLanguage === "eng"
      ? "Codex Telegram Gateway runbook"
      : "Codex Telegram Gateway runbook";

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      ...PAGE,
      bufferPages: true,
      info: {
        Title: title,
        Author: "codex-telegram-gateway",
        Subject: footerLabel,
      },
    });
    const stream = fs.createWriteStream(outputPath);

    doc.pipe(stream);
    registerFonts(doc);
    let currentPageNumber = 1;
    drawPageHeader(doc, footerLabel, currentPageNumber);
    doc.on("pageAdded", () => {
      currentPageNumber += 1;
      drawPageHeader(doc, footerLabel, currentPageNumber);
    });

    let firstParagraphDrawn = false;
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block.type === "heading-1") {
        const nextBlock = blocks[index + 1];
        ensureSpace(
          doc,
          estimateBlockHeight(doc, block) +
            estimateBlockHeight(doc, nextBlock, {
              leadParagraph: firstParagraphDrawn,
            }),
        );
        drawHeading(doc, block.text, 1);
        continue;
      }
      if (block.type === "heading-2") {
        const nextBlock = blocks[index + 1];
        ensureSpace(
          doc,
          estimateBlockHeight(doc, block) +
            estimateBlockHeight(doc, nextBlock, {
              leadParagraph: firstParagraphDrawn,
            }),
        );
        drawHeading(doc, block.text, 2);
        continue;
      }
      if (block.type === "paragraph") {
        drawParagraph(doc, block.text, { lead: !firstParagraphDrawn });
        firstParagraphDrawn = true;
        continue;
      }
      if (block.type === "bullets") {
        drawList(doc, block.items, { ordered: false });
        continue;
      }
      if (block.type === "numbered") {
        drawList(doc, block.items, { ordered: true });
        continue;
      }
      if (block.type === "code") {
        drawCode(doc, block.text);
      }
    }

    doc.end();

    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);
  });

  return {
    filePath: outputPath,
    fileName: getRunbookFileName(normalizedLanguage),
    contentType: "application/pdf",
    sourcePath,
  };
}

async function renderGuidebookPdf({ language, outputPath }) {
  const tempVectorPath = `${outputPath}.vector-${process.pid}-${Date.now()}.pdf`;
  const result = await renderGuidebookVectorPdf({
    language,
    outputPath: tempVectorPath,
  });

  try {
    const rasterized = await rasterizeGuidebookPdf({
      inputPath: tempVectorPath,
      outputPath,
    });

    if (!rasterized) {
      await fsp.copyFile(tempVectorPath, outputPath);
    }
  } finally {
    await fsp.rm(tempVectorPath, {
      force: true,
    });
  }

  return {
    ...result,
    filePath: outputPath,
  };
}

async function renderRunbookPdf({ language, outputPath }) {
  const tempVectorPath = `${outputPath}.vector-${process.pid}-${Date.now()}.pdf`;
  const result = await renderRunbookVectorPdf({
    language,
    outputPath: tempVectorPath,
  });

  try {
    const rasterized = await rasterizeGuidebookPdf({
      inputPath: tempVectorPath,
      outputPath,
    });

    if (!rasterized) {
      await fsp.copyFile(tempVectorPath, outputPath);
    }
  } finally {
    await fsp.rm(tempVectorPath, {
      force: true,
    });
  }

  return {
    ...result,
    filePath: outputPath,
  };
}

export async function generateGuidebookPdf({
  language = "rus",
  outputPath = null,
  stateRoot = null,
} = {}) {
  return renderGuidebookPdf({
    language,
    outputPath: outputPath || resolveGuidebookOutputPath(language, stateRoot),
  });
}

export async function generateRunbookPdf({
  language = "rus",
  outputPath = null,
  stateRoot = null,
} = {}) {
  return renderRunbookPdf({
    language,
    outputPath: outputPath || resolveRunbookOutputPath(language, stateRoot),
  });
}

export async function getGuidebookAsset(language, { stateRoot = null } = {}) {
  return generateGuidebookPdf({
    language,
    stateRoot,
  });
}

export const __guidebookTest = {
  normalizeInlineMarkdown,
  parseMarkdownBlocks,
};
