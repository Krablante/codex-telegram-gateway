import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { resolveWorkspaceBinding } from "../src/workspace/binding-resolver.js";

test("resolveWorkspaceBinding returns repo and cwd for workspace-root paths", async () => {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-workspace-root-"),
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: workspaceRoot });
  const resolvedWorkspaceRoot = await fs.realpath(workspaceRoot);

  const binding = await resolveWorkspaceBinding({
    workspaceRoot: workspaceRoot,
    requestedPath: workspaceRoot,
  });

  assert.equal(path.normalize(binding.repo_root), path.normalize(resolvedWorkspaceRoot));
  assert.equal(path.normalize(binding.cwd), path.normalize(resolvedWorkspaceRoot));
  assert.equal(
    path.normalize(binding.worktree_path),
    path.normalize(resolvedWorkspaceRoot),
  );
  assert.ok(binding.branch);
});

test("resolveWorkspaceBinding rejects paths outside the workspace root", async () => {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-workspace-root-"),
  );
  const outsideRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-workspace-outside-"),
  );

  await assert.rejects(
    resolveWorkspaceBinding({
      workspaceRoot: workspaceRoot,
      requestedPath: outsideRoot,
    }),
    /escapes workspace root/u,
  );
});

test("resolveWorkspaceBinding rejects file paths", async () => {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-workspace-root-"),
  );
  const filePath = path.join(workspaceRoot, "README.md");
  await fs.writeFile(filePath, "# test\n", "utf8");

  await assert.rejects(
    resolveWorkspaceBinding({
      workspaceRoot: workspaceRoot,
      requestedPath: filePath,
    }),
    /not a directory/u,
  );
});
