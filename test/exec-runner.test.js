import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexExecArgs } from "../src/codex-exec/exec-runner.js";

test("buildCodexExecArgs appends model and reasoning overrides", () => {
  assert.deepEqual(buildCodexExecArgs({
    repoRoot: "/home/bloob/atlas",
    outputPath: "/tmp/last-message.txt",
    model: "gpt-5.4-mini",
    reasoningEffort: "medium",
  }), [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    "/home/bloob/atlas",
    "--json",
    "-o",
    "/tmp/last-message.txt",
    "-c",
    'model="gpt-5.4-mini"',
    "-c",
    'model_reasoning_effort="medium"',
    "-",
  ]);
});
