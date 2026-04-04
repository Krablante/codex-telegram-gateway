import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(cwd, args) {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      maxBuffer: 20 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const message =
      error?.stderr?.trim() ||
      error?.stdout?.trim() ||
      error?.message ||
      "unknown git error";
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}

function hasStatusChanges(statusText) {
  const lines = statusText
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);

  return lines.some((line) => !line.startsWith("## "));
}

function buildDiffSnapshot(session, generatedAt, status, unstagedDiff, stagedDiff) {
  return [
    "# Workspace diff snapshot",
    "",
    `generated_at: ${generatedAt}`,
    `session_key: ${session.session_key}`,
    `cwd: ${session.workspace_binding.cwd}`,
    `repo_root: ${session.workspace_binding.repo_root}`,
    `branch: ${session.workspace_binding.branch ?? "none"}`,
    "",
    "## git status --short --branch --untracked-files=all",
    status.trim() || "(empty)",
    "",
    "## git diff --no-ext-diff --stat --patch --submodule=diff",
    unstagedDiff.trim() || "(empty)",
    "",
    "## git diff --cached --no-ext-diff --stat --patch --submodule=diff",
    stagedDiff.trim() || "(empty)",
    "",
  ].join("\n");
}

export async function createWorkspaceDiffArtifact({ session, sessionStore }) {
  const generatedAt = new Date().toISOString();
  const cwd = session.workspace_binding.cwd;
  const status = await runGit(cwd, [
    "status",
    "--short",
    "--branch",
    "--untracked-files=all",
  ]);
  const unstagedDiff = await runGit(cwd, [
    "diff",
    "--no-ext-diff",
    "--stat",
    "--patch",
    "--submodule=diff",
  ]);
  const stagedDiff = await runGit(cwd, [
    "diff",
    "--cached",
    "--no-ext-diff",
    "--stat",
    "--patch",
    "--submodule=diff",
  ]);

  const clean =
    !hasStatusChanges(status) &&
    unstagedDiff.trim().length === 0 &&
    stagedDiff.trim().length === 0;
  if (clean) {
    return {
      clean: true,
      generatedAt,
      status,
    };
  }

  return sessionStore.writeArtifact(session, {
    kind: "diff",
    extension: "txt",
    content: buildDiffSnapshot(
      session,
      generatedAt,
      status,
      unstagedDiff,
      stagedDiff,
    ),
  });
}
