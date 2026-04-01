import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GlobalPromptSuffixStore } from "../src/session-manager/global-prompt-suffix-store.js";

test("GlobalPromptSuffixStore quarantines malformed state files and falls back to empty state", async () => {
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-settings-"),
  );
  const filePath = path.join(settingsRoot, "global-prompt-suffix.json");
  const store = new GlobalPromptSuffixStore(settingsRoot);

  await fs.writeFile(filePath, "{", "utf8");
  assert.deepEqual(await store.load({ force: true }), {
    schema_version: 1,
    updated_at: null,
    prompt_suffix_text: null,
    prompt_suffix_enabled: false,
  });

  const filesAfterLoad = await fs.readdir(settingsRoot);
  assert.equal(filesAfterLoad.includes("global-prompt-suffix.json"), false);
  assert.equal(
    filesAfterLoad.some((entry) =>
      entry.startsWith("global-prompt-suffix.json.corrupt-"),
    ),
    true,
  );

  const saved = await store.save({
    prompt_suffix_text: "P.S.\nKeep it short.",
    prompt_suffix_enabled: true,
  });
  assert.equal(saved.prompt_suffix_enabled, true);
  assert.equal(saved.prompt_suffix_text, "P.S.\nKeep it short.");
});
