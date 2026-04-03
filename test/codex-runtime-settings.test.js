import test from "node:test";
import assert from "node:assert/strict";

import {
  getSupportedReasoningLevelsForModel,
  normalizeReasoningEffort,
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
