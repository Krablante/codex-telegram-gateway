#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH_DIRS = ["src", "scripts", "test", "test-support"];
const JS_EXTENSIONS = new Set([".js", ".mjs"]);

// Keep this separate from ESLint so operators have a very cheap parser-only gate.
async function collectJavaScriptFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__pycache__") {
        continue;
      }
      files.push(...await collectJavaScriptFiles(fullPath));
      continue;
    }

    if (entry.isFile() && JS_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

const files = [];
for (const dir of SEARCH_DIRS) {
  files.push(...await collectJavaScriptFiles(path.join(REPO_ROOT, dir)));
}

let failed = false;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
}
