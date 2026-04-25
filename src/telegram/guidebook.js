import {
  resolveGuidebookOutputPath,
  resolveRunbookOutputPath,
} from "./guidebook/config.js";
import {
  buildFontCandidates,
  ensureUnicodeFontCoverage,
  getFontName,
  resolveFontSet,
} from "./guidebook/fonts.js";
import {
  normalizeInlineMarkdown,
  parseMarkdownBlocks,
} from "./guidebook/markdown.js";
import {
  renderGuidebookPdf,
  renderRunbookPdf,
} from "./guidebook/pdf-render.js";

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
  buildFontCandidates,
  ensureUnicodeFontCoverage,
  getFontName,
  normalizeInlineMarkdown,
  parseMarkdownBlocks,
  resolveFontSet,
};
