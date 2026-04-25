import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  cleanupTestTempDirs,
  createTestRunTempRoot,
  hasExplicitTestFile,
  isRepoOwnedTempDir,
} from "../scripts/run-node-tests.mjs";

test("hasExplicitTestFile accepts POSIX and Windows-style test paths", () => {
  assert.equal(hasExplicitTestFile(["test/foo.test.js"]), true);
  assert.equal(hasExplicitTestFile(["test\\foo.test.js"]), true);
  assert.equal(hasExplicitTestFile(["--test-name-pattern", "foo"]), false);
});

test("cleanupTestTempDirs only removes marked runner temp roots", async () => {
  const marked = await createTestRunTempRoot();
  const unmarked = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-unmarked-"),
  );

  try {
    assert.equal(isRepoOwnedTempDir(path.basename(marked)), true);
    const removed = await cleanupTestTempDirs({ olderThanMs: 0 });
    assert.equal(removed >= 1, true);
    await assert.rejects(() => fs.stat(marked), { code: "ENOENT" });
    assert.equal((await fs.stat(unmarked)).isDirectory(), true);
  } finally {
    await fs.rm(marked, { recursive: true, force: true });
    await fs.rm(unmarked, { recursive: true, force: true });
  }
});

test("cleanupTestTempDirs can remove unmarked dirs created by the current run", async () => {
  const runStartedAtMs = Date.now();
  const unmarked = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-unmarked-current-"),
  );

  try {
    const removed = await cleanupTestTempDirs({
      sinceMs: runStartedAtMs - 1000,
      includeMarked: false,
      includeUnmarked: true,
    });
    assert.equal(removed >= 1, true);
    await assert.rejects(() => fs.stat(unmarked), { code: "ENOENT" });
  } finally {
    await fs.rm(unmarked, { recursive: true, force: true });
  }
});
