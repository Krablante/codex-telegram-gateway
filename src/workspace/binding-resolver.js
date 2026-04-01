import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function readGitOutput(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
    const value = stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

export async function resolveWorkspaceBinding({
  workspaceRoot,
  atlasWorkspaceRoot,
  requestedPath,
}) {
  const resolvedWorkspaceRoot = await fs.realpath(
    workspaceRoot || atlasWorkspaceRoot,
  );
  const requestedAbsolutePath = requestedPath
    ? path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(resolvedWorkspaceRoot, requestedPath)
    : resolvedWorkspaceRoot;
  const cwd = await fs.realpath(requestedAbsolutePath);
  await fs.stat(cwd);

  const repoRoot =
    (await readGitOutput(["rev-parse", "--show-toplevel"], cwd)) || cwd;
  const branch =
    (await readGitOutput(["branch", "--show-current"], cwd)) ||
    (await readGitOutput(["rev-parse", "--short", "HEAD"], cwd));

  return {
    workspace_root: resolvedWorkspaceRoot,
    atlas_workspace_root: resolvedWorkspaceRoot,
    repo_root: repoRoot,
    cwd,
    branch: branch || null,
    worktree_path: repoRoot,
    cwd_relative_to_workspace_root:
      path.relative(resolvedWorkspaceRoot, cwd) || ".",
  };
}
