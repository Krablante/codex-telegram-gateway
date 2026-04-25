import test from "node:test";
import assert from "node:assert/strict";

import { buildRunCodexTaskArgs } from "../src/cli/host-executor.js";

test("buildRunCodexTaskArgs forwards developerInstructions into runCodexTask", () => {
  const args = buildRunCodexTaskArgs({
    cwd: "~/workspace",
    prompt: "User Prompt:\nrun a quick task",
    baseInstructions: "Context:\n- host: worker-b, cwd: /home/worker-b/workspace",
    imagePaths: ["~/input.png"],
    knownRolloutPath: "~/workspace/state/codex/rollout.jsonl",
    contextWindow: 400000,
    autoCompactTokenLimit: 375000,
  });

  assert.equal(
    args.developerInstructions,
    "Context:\n- host: worker-b, cwd: /home/worker-b/workspace",
  );
  assert.equal(
    args.baseInstructions,
    "Context:\n- host: worker-b, cwd: /home/worker-b/workspace",
  );
  assert.match(args.cwd, /[\\/]workspace$/u);
  assert.match(args.imagePaths[0], /[\\/]input\.png$/u);
  assert.match(args.knownRolloutPath, /[\\/]rollout\.jsonl$/u);
  assert.equal(args.contextWindow, 400000);
  assert.equal(args.autoCompactTokenLimit, 375000);
});

test("buildRunCodexTaskArgs prefers explicit developerInstructions over legacy baseInstructions", () => {
  const args = buildRunCodexTaskArgs({
    cwd: "~/workspace",
    prompt: "User Prompt:\nrun a quick task",
    developerInstructions: "Context:\n- fresh developer context",
    baseInstructions: "Context:\n- legacy base context",
  });

  assert.equal(args.developerInstructions, "Context:\n- fresh developer context");
  assert.equal(args.baseInstructions, "Context:\n- legacy base context");
});
