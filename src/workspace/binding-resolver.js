import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function isSameOrDescendantPath(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

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
  atlasWorkspaceRoot,
  requestedPath,
}) {
  const resolvedAtlasRoot = await fs.realpath(atlasWorkspaceRoot);
  const requestedAbsolutePath = requestedPath
    ? path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(resolvedAtlasRoot, requestedPath)
    : resolvedAtlasRoot;
  const cwd = await fs.realpath(requestedAbsolutePath);
  const cwdStat = await fs.stat(cwd);
  if (!cwdStat.isDirectory()) {
    throw new Error(`Requested path is not a directory: ${cwd}`);
  }
  if (!isSameOrDescendantPath(resolvedAtlasRoot, cwd)) {
    throw new Error(`Requested path escapes workspace root: ${cwd}`);
  }

  const repoRoot =
    (await readGitOutput(["rev-parse", "--show-toplevel"], cwd)) || cwd;
  if (!isSameOrDescendantPath(resolvedAtlasRoot, repoRoot)) {
    throw new Error(`Resolved repo root escapes workspace root: ${repoRoot}`);
  }
  const branch =
    (await readGitOutput(["branch", "--show-current"], cwd)) ||
    (await readGitOutput(["rev-parse", "--short", "HEAD"], cwd));

  return {
    atlas_workspace_root: resolvedAtlasRoot,
    repo_root: repoRoot,
    cwd,
    branch: branch || null,
    worktree_path: repoRoot,
    cwd_relative_to_workspace_root:
      path.relative(resolvedAtlasRoot, cwd) || ".",
  };
}
