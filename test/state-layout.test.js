import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureStateLayout, getStateLayout } from "../src/state/layout.js";

test("ensureStateLayout creates documented runtime state directories", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-state-layout-"),
  );

  try {
    const layout = await ensureStateLayout(stateRoot);
    assert.deepEqual(layout, getStateLayout(stateRoot));
    if (process.platform !== "win32") {
      const rootStats = await fs.stat(layout.root);
      assert.equal(rootStats.mode & 0o777, 0o700, "root");
    }

    for (const key of [
      "sessions",
      "indexes",
      "settings",
      "hosts",
      "codexSpace",
      "zoo",
      "emergency",
      "logs",
      "tmp",
    ]) {
      const stats = await fs.stat(layout[key]);
      assert.equal(stats.isDirectory(), true, key);
      if (process.platform !== "win32") {
        assert.equal(stats.mode & 0o777, 0o700, key);
      }
    }
  } finally {
    await fs.rm(stateRoot, { recursive: true, force: true });
  }
});
