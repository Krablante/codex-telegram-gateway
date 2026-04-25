import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexExecArgs } from "../src/codex-exec/exec-runner.js";

test("buildCodexExecArgs appends model and reasoning overrides", () => {
  assert.deepEqual(buildCodexExecArgs({
    repoRoot: "/srv/codex-workspace",
    outputPath: "/tmp/last-message.txt",
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
    contextWindow: 400000,
    autoCompactTokenLimit: 375000,
  }), [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    "/srv/codex-workspace",
    "--json",
    "-o",
    "/tmp/last-message.txt",
    "-c",
    'model="gpt-5.4-mini"',
    "-c",
    'model_reasoning_effort="medium"',
    "-c",
    "model_context_window=400000",
    "-c",
    "model_auto_compact_token_limit=375000",
    "-",
  ]);
});
