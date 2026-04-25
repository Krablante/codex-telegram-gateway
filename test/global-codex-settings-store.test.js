import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GlobalCodexSettingsStore } from "../src/session-manager/global-codex-settings-store.js";

test("GlobalCodexSettingsStore quarantines malformed state files and falls back to empty state", async () => {
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-settings-"),
  );
  const filePath = path.join(settingsRoot, "global-codex-settings.json");
  const store = new GlobalCodexSettingsStore(settingsRoot);

  await fs.writeFile(filePath, "{", "utf8");
  assert.deepEqual(await store.load({ force: true }), {
    schema_version: 1,
    updated_at: null,
    spike_model: null,
    spike_reasoning_effort: null,
    compact_model: null,
    compact_reasoning_effort: null,
  });

  const filesAfterLoad = await fs.readdir(settingsRoot);
  assert.equal(filesAfterLoad.includes("global-codex-settings.json"), false);
  assert.equal(
    filesAfterLoad.some((entry) =>
      entry.startsWith("global-codex-settings.json.corrupt-"),
    ),
    true,
  );

  const saved = await store.save({
    spike_model: "gpt-5.4-mini",
    spike_reasoning_effort: "high",
    compact_model: "gpt-5.4",
    compact_reasoning_effort: "low",
  });
  assert.equal(saved.spike_model, "gpt-5.4-mini");
  assert.equal(saved.spike_reasoning_effort, "high");
  assert.equal(saved.compact_model, "gpt-5.4");
  assert.equal(saved.compact_reasoning_effort, "low");
});

test("GlobalCodexSettingsStore patchWithCurrent serializes overlapping writes", async () => {
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-settings-"),
  );
  const store = new GlobalCodexSettingsStore(settingsRoot);

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
      spike_model: "gpt-5.4-mini",
      spike_reasoning_effort: "high",
    };
  });

  await firstPatchEnteredPromise;
  let secondFinished = false;
  const secondPatch = store.patchWithCurrent((current) => ({
    compact_model: current.spike_model,
  })).then(() => {
    secondFinished = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondFinished, false);

  releaseFirstPatch();
  await Promise.all([firstPatch, secondPatch]);

  const loaded = await store.load({ force: true });
  assert.equal(loaded.spike_model, "gpt-5.4-mini");
  assert.equal(loaded.spike_reasoning_effort, "high");
  assert.equal(loaded.compact_model, "gpt-5.4-mini");
});
