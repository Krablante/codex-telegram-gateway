import test from "node:test";
import assert from "node:assert/strict";

import {
  getSupportedReasoningLevelsForModel,
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

test("resolveCodexRuntimeProfile keeps the configured default model even when it is absent from the cached model list", () => {
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

  assert.equal(profile.model, "gpt-6-experimental");
  assert.equal(profile.modelSource, "default");
});
