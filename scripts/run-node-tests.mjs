#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT = path.join(REPO_ROOT, "test");
const BEFORE_CLEANUP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const TEST_RUN_TEMP_PREFIX = "codex-telegram-gateway-test-run-";
const TEST_RUN_MARKER_FILE = ".codex-telegram-gateway-test-run";
const TEST_TEMP_PREFIXES = [
  TEST_RUN_TEMP_PREFIX,
  "codex-telegram-",
  "codex-telegram-gateway-",
  "codex-exec-jsonl-mirror-",
  "codex-remote-images-",
  "codex-runtime-models-",
  "ctg-stale-",
];

const EXEC_TEST_FILES = [
  "test/telegram-exec-runner.test.js",
  "test/exec-runner.test.js",
  "test/host-aware-run-task.test.js",
  "test/worker-pool-common.test.js",
  "test/worker-pool-startup.test.js",
  "test/worker-pool.test.js",
  "test/worker-pool-exec-json-contract.test.js",
  "test/worker-pool-live-steer.test.js",
  "test/session-store.test.js",
  "test/session-service.test.js",
  "test/session-compactor.test.js",
  "test/run-stale-run-recovery.test.js",
];

export function isRepoOwnedTempDir(name) {
  return TEST_TEMP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

async function hasTestRunMarker(dirPath) {
  try {
    const stats = await fs.stat(path.join(dirPath, TEST_RUN_MARKER_FILE));
    return stats.isFile();
  } catch {
    return false;
  }
}

async function resolveActiveTempRoots() {
  const roots = new Set();
  for (const candidate of [
    os.tmpdir(),
    process.env.TMPDIR,
    process.env.TEMP,
    process.env.TMP,
  ]) {
    if (!candidate) {
      continue;
    }
    try {
      roots.add(await fs.realpath(candidate));
    } catch {
      roots.add(path.resolve(candidate));
    }
  }
  return roots;
}

export async function cleanupTestTempDirs({
  olderThanMs = null,
  sinceMs = null,
  includeMarked = true,
  includeUnmarked = false,
} = {}) {
  const tmpRoot = os.tmpdir();
  const activeTempRoots = await resolveActiveTempRoots();
  let entries;
  try {
    entries = await fs.readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return 0;
  }

  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isRepoOwnedTempDir(entry.name)) {
      continue;
    }

    const dirPath = path.join(tmpRoot, entry.name);
    let resolvedDirPath;
    try {
      resolvedDirPath = await fs.realpath(dirPath);
    } catch {
      resolvedDirPath = path.resolve(dirPath);
    }
    if (activeTempRoots.has(resolvedDirPath)) {
      continue;
    }

    const hasMarker = await hasTestRunMarker(dirPath);
    if ((hasMarker && !includeMarked) || (!hasMarker && !includeUnmarked)) {
      continue;
    }

    let stats;
    try {
      stats = await fs.stat(dirPath);
    } catch {
      continue;
    }

    if (olderThanMs !== null && now - stats.mtimeMs < olderThanMs) {
      continue;
    }
    if (sinceMs !== null && stats.mtimeMs < sinceMs) {
      continue;
    }

    await fs.rm(dirPath, { recursive: true, force: true }).catch(() => {});
    removed += 1;
  }

  return removed;
}

export async function collectDefaultTestFiles(dir = TEST_ROOT) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectDefaultTestFiles(fullPath));
      continue;
    }
    if (
      entry.isFile()
      && entry.name.endsWith(".test.js")
      && !entry.name.includes(".live.")
    ) {
      files.push(path.relative(REPO_ROOT, fullPath));
    }
  }

  return files.sort();
}

export async function createTestRunTempRoot() {
  const runTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), TEST_RUN_TEMP_PREFIX));
  await fs.writeFile(
    path.join(runTempRoot, TEST_RUN_MARKER_FILE),
    `${new Date().toISOString()}\n`,
    "utf8",
  );
  return runTempRoot;
}

export function buildTestRunEnv(runTempRoot) {
  return {
    ...process.env,
    TMPDIR: runTempRoot,
    TEMP: runTempRoot,
    TMP: runTempRoot,
  };
}

export function hasExplicitTestFile(args) {
  return args.some((arg) => {
    if (arg.startsWith("-")) {
      return false;
    }
    const normalized = arg.replace(/\\/gu, "/");
    return normalized.endsWith(".js") || normalized.startsWith("test/");
  });
}

export function parseArgs(rawArgs) {
  const args = [];
  let suite = null;
  let cleanupOnly = false;
  let cleanupAll = false;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--cleanup-only") {
      cleanupOnly = true;
      continue;
    }
    if (arg === "--cleanup-all") {
      cleanupAll = true;
      continue;
    }
    if (arg === "--suite") {
      suite = rawArgs[index + 1] || null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--suite=")) {
      suite = arg.slice("--suite=".length);
      continue;
    }
    args.push(arg);
  }

  return { args, cleanupAll, cleanupOnly, suite };
}

export async function buildNodeTestArgs({ args, suite }) {
  if (suite === "exec") {
    return [...args, ...EXEC_TEST_FILES];
  }
  if (suite) {
    throw new Error(`Unknown test suite: ${suite}`);
  }
  if (hasExplicitTestFile(args)) {
    return args;
  }
  return [...args, ...await collectDefaultTestFiles()];
}

async function main() {
  const { args, cleanupAll, cleanupOnly, suite } = parseArgs(process.argv.slice(2));

  if (cleanupOnly) {
    const removed = await cleanupTestTempDirs({
      olderThanMs: cleanupAll ? 0 : BEFORE_CLEANUP_MAX_AGE_MS,
    });
    console.log(`removed_test_temp_dirs: ${removed}`);
    return;
  }

  await cleanupTestTempDirs({ olderThanMs: BEFORE_CLEANUP_MAX_AGE_MS });
  const runStartedAtMs = Date.now();
  const runTempRoot = await createTestRunTempRoot();
  const nodeTestArgs = await buildNodeTestArgs({ args, suite });
  let result;
  try {
    result = spawnSync(
      process.execPath,
      ["--test", ...nodeTestArgs],
      {
        cwd: REPO_ROOT,
        env: buildTestRunEnv(runTempRoot),
        stdio: "inherit",
      },
    );
  } finally {
    await fs.rm(runTempRoot, { recursive: true, force: true }).catch(() => {});
    await cleanupTestTempDirs({
      sinceMs: runStartedAtMs,
      includeMarked: false,
      includeUnmarked: true,
    }).catch(() => {});
  }

  if (result.signal) {
    console.error(`node --test terminated by signal ${result.signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`run-node-tests failed: ${error.message}`);
    process.exitCode = 1;
  });
}
