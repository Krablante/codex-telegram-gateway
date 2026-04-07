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
    omni_model: null,
    omni_reasoning_effort: null,
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
    omni_model: "gpt-5.4",
    omni_reasoning_effort: "low",
  });
  assert.equal(saved.spike_model, "gpt-5.4-mini");
  assert.equal(saved.spike_reasoning_effort, "high");
  assert.equal(saved.omni_model, "gpt-5.4");
  assert.equal(saved.omni_reasoning_effort, "low");
});
