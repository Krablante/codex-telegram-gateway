import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveWorkspaceBinding } from "../src/workspace/binding-resolver.js";

const execFileAsync = promisify(execFile);

test("resolveWorkspaceBinding returns repo and cwd for a generic workspace path", async () => {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-workspace-"),
  );
  await execFileAsync("git", ["init", "-b", "main", workspaceRoot]);

  const binding = await resolveWorkspaceBinding({
    workspaceRoot,
    requestedPath: workspaceRoot,
  });

  assert.equal(binding.workspace_root, workspaceRoot);
  assert.equal(binding.repo_root, workspaceRoot);
  assert.equal(binding.cwd, workspaceRoot);
  assert.equal(binding.worktree_path, workspaceRoot);
  assert.ok(binding.branch);
});
