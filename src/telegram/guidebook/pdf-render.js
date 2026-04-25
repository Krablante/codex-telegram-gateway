import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

import PDFDocument from "pdfkit";

import {
  GUIDEBOOK_RASTERIZE_SCRIPT,
  PAGE,
  getGuidebookFileName,
  getGuidebookSourcePath,
  getNormalizedLanguage,
  getRunbookFileName,
  getRunbookSourcePath,
} from "./config.js";
import { ensureUnicodeFontCoverage, getFontName, registerFonts } from "./fonts.js";
import { parseMarkdownBlocks } from "./markdown.js";

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

function drawPageHeader(doc, footerLabel, pageNumber) {
  const headerY = 18;
  doc
    .font(getFontName("sans"))
    .fontSize(8.5)
    .fillColor("#94A3B8")
    .text(footerLabel, doc.page.margins.left, headerY, {
      width: contentWidth(doc) / 2,
      align: "left",
      lineBreak: false,
    })
    .text(`${pageNumber}`, doc.page.margins.left, headerY, {
      width: contentWidth(doc),
      align: "right",
      lineBreak: false,
    });
  doc.x = doc.page.margins.left;
  doc.y = doc.page.margins.top;
}

function drawHeading(doc, text, level = 1) {
  const size = level === 1 ? 20 : 13.5;
  const color = level === 1 ? "#0F172A" : "#111827";
  const gapBefore = level === 1 ? 0 : 8;
  const gapAfter = level === 1 ? 8 : 4;
  doc.font(getFontName("bold")).fontSize(size);
  const height = doc.heightOfString(text, { width: contentWidth(doc), lineGap: 2 });
  ensureSpace(doc, gapBefore + height + gapAfter);
  if (gapBefore > 0) {
    doc.moveDown(gapBefore / 12);
  }
  const startX = doc.page.margins.left;
  const startY = doc.y;
  doc.font(getFontName("bold")).fontSize(size).fillColor(color).text(text, startX, startY, {
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
  const height = doc.heightOfString(text, { width: contentWidth(doc), lineGap: 2 });
  return gapBefore + height + gapAfter;
}

function drawParagraph(doc, text, { lead = false } = {}) {
  const fontSize = lead ? 11.2 : 10.2;
  const lineGap = lead ? 2.2 : 1.7;
  const color = lead ? "#334155" : "#1F2937";
  doc.font(getFontName("sans")).fontSize(fontSize);
  const height = doc.heightOfString(text, { width: contentWidth(doc), lineGap });
  ensureSpace(doc, height + 8);
  const startX = doc.page.margins.left;
  const startY = doc.y;
  doc.font(getFontName("sans")).fontSize(fontSize).fillColor(color).text(text, startX, startY, {
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
  const height = doc.heightOfString(text, { width: contentWidth(doc), lineGap });
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
    doc.text(marker, startX, startY, { width: bulletIndent, lineGap: 1.7 });
    doc.text(item, startX + bulletIndent, startY, { width: textWidth, lineGap: 1.7 });
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
  doc.font(getFontName("mono")).fontSize(8.2).fillColor("#111827").text(text, x + innerPadding, y + innerPadding, {
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

function renderBlocks(doc, blocks) {
  let firstParagraphDrawn = false;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type === "heading-1") {
      const nextBlock = blocks[index + 1];
      ensureSpace(
        doc,
        estimateBlockHeight(doc, block) +
          estimateBlockHeight(doc, nextBlock, { leadParagraph: firstParagraphDrawn }),
      );
      drawHeading(doc, block.text, 1);
      continue;
    }
    if (block.type === "heading-2") {
      const nextBlock = blocks[index + 1];
      ensureSpace(
        doc,
        estimateBlockHeight(doc, block) +
          estimateBlockHeight(doc, nextBlock, { leadParagraph: firstParagraphDrawn }),
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

async function rasterizePdf({ inputPath, outputPath }) {
  try {
    await execFileAsync("python3", [GUIDEBOOK_RASTERIZE_SCRIPT, inputPath, outputPath]);
    return true;
  } catch {
    return false;
  }
}

async function renderVectorPdf({
  language,
  outputPath,
  sourcePathResolver,
  fileNameResolver,
  fallbackTitle,
  footerLabel,
}) {
  const normalizedLanguage = getNormalizedLanguage(language);
  const sourcePath = sourcePathResolver(normalizedLanguage);
  const markdown = await fsp.readFile(sourcePath, "utf8");
  ensureUnicodeFontCoverage(markdown, sourcePath);
  const blocks = parseMarkdownBlocks(markdown);
  const titleBlock = blocks.find((block) => block.type === "heading-1");
  const title = titleBlock?.text || fallbackTitle(normalizedLanguage);
  const footer = footerLabel(normalizedLanguage);

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      ...PAGE,
      bufferPages: true,
      info: {
        Title: title,
        Author: "codex-telegram-gateway",
        Subject: footer,
      },
    });
    const stream = fs.createWriteStream(outputPath);

    doc.pipe(stream);
    registerFonts(doc);
    let currentPageNumber = 1;
    drawPageHeader(doc, footer, currentPageNumber);
    doc.on("pageAdded", () => {
      currentPageNumber += 1;
      drawPageHeader(doc, footer, currentPageNumber);
    });

    renderBlocks(doc, blocks);
    doc.end();

    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);
  });

  return {
    filePath: outputPath,
    fileName: fileNameResolver(normalizedLanguage),
    contentType: "application/pdf",
    sourcePath,
  };
}

async function renderRasterizedPdf({ language, outputPath, renderVector }) {
  const tempVectorPath = `${outputPath}.vector-${process.pid}-${Date.now()}.pdf`;
  const result = await renderVector({ language, outputPath: tempVectorPath });

  try {
    const rasterized = await rasterizePdf({ inputPath: tempVectorPath, outputPath });
    if (!rasterized) {
      await fsp.copyFile(tempVectorPath, outputPath);
    }
  } finally {
    await fsp.rm(tempVectorPath, { force: true });
  }

  return {
    ...result,
    filePath: outputPath,
  };
}

async function renderGuidebookVectorPdf({ language, outputPath }) {
  return renderVectorPdf({
    language,
    outputPath,
    sourcePathResolver: getGuidebookSourcePath,
    fileNameResolver: getGuidebookFileName,
    fallbackTitle: () => "Guidebook",
    footerLabel: () => "Spike guidebook",
  });
}

async function renderRunbookVectorPdf({ language, outputPath }) {
  return renderVectorPdf({
    language,
    outputPath,
    sourcePathResolver: getRunbookSourcePath,
    fileNameResolver: getRunbookFileName,
    fallbackTitle: (normalizedLanguage) =>
      normalizedLanguage === "eng"
        ? "Codex Telegram Gateway Runbook"
        : "Runbook для Codex Telegram Gateway",
    footerLabel: () => "Codex Telegram Gateway runbook",
  });
}

export async function renderGuidebookPdf({ language, outputPath }) {
  return renderRasterizedPdf({
    language,
    outputPath,
    renderVector: renderGuidebookVectorPdf,
  });
}

export async function renderRunbookPdf({ language, outputPath }) {
  return renderRasterizedPdf({
    language,
    outputPath,
    renderVector: renderRunbookVectorPdf,
  });
}
