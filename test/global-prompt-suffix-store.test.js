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

test("GlobalPromptSuffixStore patchWithCurrent serializes overlapping writes", async () => {
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-settings-"),
  );
  const store = new GlobalPromptSuffixStore(settingsRoot);

  let enteredFirstPatch;
  let releaseFirstPatch;
  const firstPatchEnteredPromise = new Promise((resolve) => {
    enteredFirstPatch = resolve;
  });
  const releaseFirstPatchPromise = new Promise((resolve) => {
    releaseFirstPatch = resolve;
  });

  const firstPatch = store.patchWithCurrent(async () => {
    enteredFirstPatch();
    await releaseFirstPatchPromise;
    return {
      prompt_suffix_text: "Use terse diffs.",
      prompt_suffix_enabled: true,
    };
  });

  await firstPatchEnteredPromise;
  let secondFinished = false;
  const secondPatch = store.patchWithCurrent((current) => ({
    prompt_suffix_enabled: Boolean(current.prompt_suffix_text),
  })).then(() => {
    secondFinished = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondFinished, false);

  releaseFirstPatch();
  await Promise.all([firstPatch, secondPatch]);

  const loaded = await store.load({ force: true });
  assert.equal(loaded.prompt_suffix_text, "Use terse diffs.");
  assert.equal(loaded.prompt_suffix_enabled, true);
});
