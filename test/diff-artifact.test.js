import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SessionStore } from "../src/session-manager/session-store.js";
import { createWorkspaceDiffArtifact } from "../src/workspace/diff-artifact.js";

const execFileAsync = promisify(execFile);

async function run(command, args, cwd) {
  await execFileAsync(command, args, { cwd });
}

async function makeGitRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-gateway-git-"));
  await run("git", ["init"], repoRoot);
  await run("git", ["config", "user.name", "Codex"], repoRoot);
  await run("git", ["config", "user.email", "codex@example.test"], repoRoot);
  await fs.writeFile(path.join(repoRoot, "tracked.txt"), "line 1\n", "utf8");
  await run("git", ["add", "tracked.txt"], repoRoot);
  await run("git", ["commit", "-m", "initial"], repoRoot);
  return repoRoot;
}

test("createWorkspaceDiffArtifact returns clean snapshot for unchanged workspace", async () => {
  const repoRoot = await makeGitRepo();
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 91,
    createdVia: "test",
    workspaceBinding: {
      repo_root: repoRoot,
      cwd: repoRoot,
      branch: "master",
      worktree_path: repoRoot,
    },
  });

  const result = await createWorkspaceDiffArtifact({
    session,
    sessionStore,
  });

  assert.equal(result.clean, true);
  assert.ok(result.generatedAt);
});

test("createWorkspaceDiffArtifact stores a diff artifact for dirty workspace", async () => {
  const repoRoot = await makeGitRepo();
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 92,
    createdVia: "test",
    workspaceBinding: {
      repo_root: repoRoot,
      cwd: repoRoot,
      branch: "master",
      worktree_path: repoRoot,
    },
  });

  await fs.writeFile(path.join(repoRoot, "tracked.txt"), "line 1\nline 2\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "new.txt"), "new file\n", "utf8");

  const result = await createWorkspaceDiffArtifact({
    session,
    sessionStore,
  });

  assert.equal(result.artifact.kind, "diff");
  const artifactText = await fs.readFile(result.filePath, "utf8");
  assert.match(artifactText, /Workspace diff snapshot/u);
  assert.match(artifactText, /tracked\.txt/u);
  assert.match(artifactText, /new\.txt/u);
});
