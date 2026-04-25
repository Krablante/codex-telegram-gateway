import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("Windows test helper uses the canonical Node test runner wrapper", async () => {
  const script = await fs.readFile("scripts/windows/test.cmd", "utf8");

  assert.match(script, /node scripts\\run-node-tests\.mjs %\*/u);
  assert.doesNotMatch(script, /node --test/u);
});
