import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BUILTIN_CODEX_MODELS,
  getSupportedReasoningLevelsForModel,
  loadAvailableCodexModels,
  loadVisibleCodexModels,
  normalizeReasoningEffort,
  resolveCodexRuntimeProfile,
} from "../src/session-manager/codex-runtime-settings.js";

test("normalizeReasoningEffort keeps explicit Codex-only levels available", () => {
  assert.equal(normalizeReasoningEffort("minimal"), "minimal");
  assert.equal(normalizeReasoningEffort("none"), "none");
});

test("getSupportedReasoningLevelsForModel uses a conservative fallback when metadata is missing", () => {
  assert.deepEqual(
    getSupportedReasoningLevelsForModel([], "gpt-5.4").map((entry) => entry.value),
    ["low", "medium", "high", "xhigh"],
  );
});

test("resolveCodexRuntimeProfile ignores stale unavailable overrides and falls back to the configured default model", () => {
  const profile = resolveCodexRuntimeProfile({
    session: {
      spike_model_override: "old-session-model",
    },
    globalSettings: {
      spike_model: "old-global-model",
    },
    config: {
      codexModel: "gpt-5.4-mini",
      codexReasoningEffort: "medium",
    },
    target: "spike",
    availableModels: [
      { slug: "gpt-5.4", displayName: "GPT-5.4" },
      { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" },
    ],
  });

  assert.equal(profile.model, "gpt-5.4-mini");
  assert.equal(profile.modelSource, "default");
});

test("resolveCodexRuntimeProfile falls back to an available model when the configured default is stale", () => {
  const profile = resolveCodexRuntimeProfile({
    session: null,
    globalSettings: null,
    config: {
      codexModel: "gpt-6-experimental",
      codexReasoningEffort: "medium",
    },
    target: "spike",
    availableModels: [
      { slug: "gpt-5.4", displayName: "GPT-5.4" },
    ],
  });

  assert.equal(profile.model, "gpt-5.4");
  assert.equal(profile.modelSource, "default");
});

test("resolveCodexRuntimeProfile keeps a hidden-but-valid configured model when the runtime catalog knows it", () => {
  const profile = resolveCodexRuntimeProfile({
    session: null,
    globalSettings: null,
    config: {
      codexModel: "hidden-model",
      codexReasoningEffort: "medium",
    },
    target: "spike",
    availableModels: [
      { slug: "gpt-5.4", displayName: "GPT-5.4" },
      { slug: "hidden-model", displayName: "Hidden Model" },
    ],
  });

  assert.equal(profile.model, "hidden-model");
  assert.equal(profile.modelSource, "default");
});

test("loadAvailableCodexModels keeps the full runtime catalog and sorts it by priority", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-models-"));
  const modelsCachePath = path.join(runtimeDir, "models_cache.json");
  await fs.writeFile(
    modelsCachePath,
    `${JSON.stringify({
      models: [
        {
          slug: "codex-auto-review",
          display_name: "Codex Auto Review",
          visibility: "hide",
          priority: 29,
        },
        {
          slug: "gpt-5.4-mini",
          display_name: "gpt-5.4-mini",
          visibility: "list",
          priority: 4,
        },
        {
          slug: "gpt-5.4",
          display_name: "gpt-5.4",
          visibility: "list",
          priority: -1,
        },
        {
          slug: "gpt-oss-120b",
          display_name: "GPT-OSS-120B",
          visibility: "hide",
          priority: 18,
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const models = await loadAvailableCodexModels({ modelsCachePath });

  assert.deepEqual(
    models.map((entry) => entry.slug),
    ["gpt-5.4", "gpt-5.4-mini", "gpt-oss-120b", "codex-auto-review"],
  );
});

test("loadVisibleCodexModels keeps only list-visible models and sorts them by priority", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-models-"));
  const modelsCachePath = path.join(runtimeDir, "models_cache.json");
  await fs.writeFile(
    modelsCachePath,
    `${JSON.stringify({
      models: [
        {
          slug: "codex-auto-review",
          display_name: "Codex Auto Review",
          visibility: "hide",
          priority: 29,
        },
        {
          slug: "gpt-5.4-mini",
          display_name: "gpt-5.4-mini",
          visibility: "list",
          priority: 4,
        },
        {
          slug: "gpt-5.4",
          display_name: "gpt-5.4",
          visibility: "list",
          priority: -1,
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const models = await loadVisibleCodexModels({ modelsCachePath });

  assert.deepEqual(
    models.map((entry) => entry.slug),
    ["gpt-5.4", "gpt-5.4-mini"],
  );
});

test("loadVisibleCodexModels returns an empty list when cache only contains hidden entries", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-models-"));
  const modelsCachePath = path.join(runtimeDir, "models_cache.json");
  await fs.writeFile(
    modelsCachePath,
    `${JSON.stringify({
      models: [
        {
          slug: "codex-auto-review",
          display_name: "Codex Auto Review",
          visibility: "hide",
          priority: 29,
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const models = await loadVisibleCodexModels({ modelsCachePath });

  assert.deepEqual(models, []);
});

test("loadVisibleCodexModels falls back to builtin visible models when cache is missing", async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-models-"));
  const modelsCachePath = path.join(runtimeDir, "missing-models-cache.json");

  const models = await loadVisibleCodexModels({ modelsCachePath });

  assert.deepEqual(models, BUILTIN_CODEX_MODELS);
});
