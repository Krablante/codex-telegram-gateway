import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  __guidebookTest,
  generateGuidebookPdf,
} from "../src/telegram/guidebook.js";

test("generateGuidebookPdf creates a PDF from the beginner guide source without Atlas references", async () => {
  const outputDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-guidebook-test-"),
  );
  const outputPath = path.join(outputDir, "guidebook-rus.pdf");

  const result = await generateGuidebookPdf({
    language: "rus",
    outputPath,
  });

  const pdf = await fs.readFile(outputPath);
  assert.match(pdf.subarray(0, 8).toString("utf8"), /^%PDF-/u);
  assert.equal(result.filePath, outputPath);
  assert.equal(result.fileName, "codex-telegram-guidebook-rus.pdf");
  assert.ok(pdf.length > 1_000);

  const source = await fs.readFile(result.sourcePath, "utf8");
  assert.doesNotMatch(source, /atlas/iu);
});

test("guidebook markdown parser removes inline markdown markers from rendered prose", () => {
  const blocks = __guidebookTest.parseMarkdownBlocks(`
# Title

Use \`/new Topic Name\` in **General** and open /menu after that.

- Keep \`/q\` for queued work
 - Keep /omni_model unchanged
  `);

  assert.deepEqual(blocks, [
    {
      type: "heading-1",
      text: "Title",
    },
    {
      type: "paragraph",
      text: "Use /new Topic Name in General and open /menu after that.",
    },
    {
      type: "bullets",
      items: ["Keep /q for queued work", "Keep /omni_model unchanged"],
    },
  ]);
});

test("guidebook font resolution picks Unicode Windows fonts before PDF base fonts", () => {
  const fontSet = __guidebookTest.resolveFontSet({
    platform: "win32",
    env: {
      WINDIR: "C:\\Windows",
    },
    existsSync(candidate) {
      return /arial(?:bd)?\.ttf$|consola\.ttf$/iu.test(candidate);
    },
  });

  assert.match(fontSet.sans, /arial\.ttf$/iu);
  assert.match(fontSet.bold, /arialbd\.ttf$/iu);
  assert.match(fontSet.mono, /consola\.ttf$/iu);
});

test("guidebook font coverage fails loudly instead of generating broken Cyrillic PDF text", () => {
  assert.throws(
    () =>
      __guidebookTest.ensureUnicodeFontCoverage(
        "# Привет\n\nТест",
        "/tmp/guidebook-rus.md",
        {
          sans: null,
          bold: null,
          mono: null,
        },
      ),
    /Unicode-capable PDF font for Cyrillic guidebook text/iu,
  );
});
