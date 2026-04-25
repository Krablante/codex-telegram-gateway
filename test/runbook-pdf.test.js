import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateRunbookPdf } from "../src/telegram/guidebook.js";

for (const language of ["rus", "eng"]) {
  test(`generateRunbookPdf creates the ${language.toUpperCase()} runbook PDF`, async () => {
    const outputDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "codex-telegram-runbook-test-"),
    );
    const outputPath = path.join(outputDir, `runbook-${language}.pdf`);

    const result = await generateRunbookPdf({
      language,
      outputPath,
    });

    const pdf = await fs.readFile(outputPath);
    assert.match(pdf.subarray(0, 8).toString("utf8"), /^%PDF-/u);
    assert.equal(result.filePath, outputPath);
    assert.equal(result.fileName, `codex-telegram-runbook-${language}.pdf`);
    assert.ok(pdf.length > 1_000);

    const source = await fs.readFile(result.sourcePath, "utf8");
    assert.match(source, /Runbook/u);
  });
}
