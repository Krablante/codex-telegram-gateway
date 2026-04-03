import test from "node:test";
import assert from "node:assert/strict";

import { resolveWorkspaceBinding } from "../src/workspace/binding-resolver.js";

test("resolveWorkspaceBinding returns repo and cwd for the current repo root", async () => {
  const repoRoot = process.cwd();
  const binding = await resolveWorkspaceBinding({
    workspaceRoot: repoRoot,
    requestedPath: repoRoot,
  });

  assert.equal(binding.workspace_root, repoRoot);
  assert.equal(binding.repo_root, repoRoot);
  assert.equal(binding.cwd, repoRoot);
  assert.equal(binding.worktree_path, repoRoot);
  assert.ok(binding.branch);
});
