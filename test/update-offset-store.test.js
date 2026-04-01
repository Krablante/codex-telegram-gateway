import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { UpdateOffsetStore } from "../src/session-manager/update-offset-store.js";

test("UpdateOffsetStore persists and loads next offset", async () => {
  const indexesRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-offset-"),
  );
  const store = new UpdateOffsetStore(indexesRoot);

  assert.equal(await store.load(), null);

  await store.save(123);
  assert.equal(await store.load(), 123);
});

test("UpdateOffsetStore quarantines malformed cursor files and overwrites them on save", async () => {
  const indexesRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-offset-"),
  );
  const store = new UpdateOffsetStore(indexesRoot);
  const filePath = path.join(indexesRoot, "telegram-update-offset.json");

  await fs.writeFile(filePath, "{", "utf8");
  assert.equal(await store.load(), 0);
  const filesAfterLoad = await fs.readdir(indexesRoot);
  assert.equal(filesAfterLoad.includes("telegram-update-offset.json"), false);
  assert.equal(
    filesAfterLoad.some((entry) =>
      entry.startsWith("telegram-update-offset.json.corrupt-"),
    ),
    true,
  );

  await store.save(456);
  assert.equal(await store.load(), 456);
});

test("UpdateOffsetStore quarantines invalid cursor payloads and falls back to replay-safe offset", async () => {
  const indexesRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-offset-"),
  );
  const store = new UpdateOffsetStore(indexesRoot);
  const filePath = path.join(indexesRoot, "telegram-update-offset.json");

  await fs.writeFile(
    filePath,
    JSON.stringify({ next_update_offset: "bad" }),
    "utf8",
  );

  assert.equal(await store.load(), 0);
  const filesAfterLoad = await fs.readdir(indexesRoot);
  assert.equal(filesAfterLoad.includes("telegram-update-offset.json"), false);
  assert.equal(
    filesAfterLoad.some((entry) =>
      entry.startsWith("telegram-update-offset.json.corrupt-"),
    ),
    true,
  );
});
