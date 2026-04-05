#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import { generateRunbookPdf } from "../src/telegram/guidebook.js";

function readFlag(name, fallback = null) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return fallback;
  }

  return process.argv[index + 1] ?? fallback;
}

const language = readFlag("language", "rus");
const outputArg = readFlag("output", null);
const outputPath = outputArg ? path.resolve(outputArg) : null;

const result = await generateRunbookPdf({
  language,
  outputPath,
});

process.stdout.write(`${result.filePath}\n`);
