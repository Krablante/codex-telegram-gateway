import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runHostBash, shellQuote } from "../hosts/host-command-runner.js";
import { resolveExecutionCwd } from "../hosts/host-paths.js";

const execFileAsync = promisify(execFile);

function isNonGitWorkspaceError(error) {
  const details = [
    error?.stderr?.trim(),
    error?.stdout?.trim(),
    error?.message,
  ]
    .filter(Boolean)
    .join("\n");
  return /not a git repository/i.test(details);
}

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
    throw new Error(`git ${args.join(" ")} failed: ${message}`, {
      cause: error,
    });
  }
}

async function runRemoteGit({
  connectTimeoutSecs,
  currentHostId,
  host,
  cwd,
  args,
}) {
  const script = [
    "set -euo pipefail",
    `target=${shellQuote(cwd)}`,
    'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
    `git -C "$target" ${args.map((arg) => shellQuote(arg)).join(" ")}`,
  ].join("; ");
  try {
    const result = await runHostBash({
      connectTimeoutSecs,
      currentHostId,
      host,
      script,
      timeoutMs: 30_000,
    });
    return result.stdout;
  } catch (error) {
    const message =
      error?.stderr?.trim() ||
      error?.stdout?.trim() ||
      error?.message ||
      "unknown git error";
    throw new Error(`git ${args.join(" ")} failed: ${message}`, {
      cause: error,
    });
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

async function resolveDiffExecution(session, {
  config = null,
  hostRegistryService = null,
} = {}) {
  const hostId = String(session?.execution_host_id || "").trim();
  const currentHostId = String(config?.currentHostId || "").trim();
  if (!hostId || !currentHostId || hostId === currentHostId) {
    return {
      local: true,
      cwd: session.workspace_binding.cwd,
      repoRoot: session.workspace_binding.repo_root,
    };
  }
  if (typeof hostRegistryService?.getHost !== "function") {
    return {
      local: true,
      cwd: session.workspace_binding.cwd,
      repoRoot: session.workspace_binding.repo_root,
    };
  }

  const host = await hostRegistryService.getHost(hostId);
  if (!host?.ssh_target) {
    return {
      local: false,
      unavailable: true,
    };
  }

  const cwd = resolveExecutionCwd({
    workspaceBinding: session.workspace_binding,
    host,
    currentHostId,
  });
  if (!cwd) {
    return {
      local: false,
      unavailable: true,
    };
  }

  return {
    local: false,
    host,
    cwd,
    repoRoot: resolveExecutionCwd({
      workspaceBinding: {
        ...session.workspace_binding,
        cwd: session.workspace_binding.repo_root,
        cwd_relative_to_workspace_root: null,
      },
      host,
      currentHostId,
    }) || session.workspace_binding.repo_root,
  };
}

export async function createWorkspaceDiffArtifact({
  session,
  sessionStore,
  config = null,
  hostRegistryService = null,
}) {
  const generatedAt = new Date().toISOString();
  const execution = await resolveDiffExecution(session, {
    config,
    hostRegistryService,
  });
  const cwd = execution.cwd;
  if (execution.unavailable || !cwd) {
    return {
      unavailable: true,
      reason: "workspace-unavailable",
      generatedAt,
      cwd: session.workspace_binding.cwd,
    };
  }
  let status;
  try {
    status = execution.local
      ? await runGit(cwd, [
        "status",
        "--short",
        "--branch",
        "--untracked-files=all",
      ])
      : await runRemoteGit({
        connectTimeoutSecs: config?.hostSshConnectTimeoutSecs || 10,
        currentHostId: config?.currentHostId || "local",
        host: execution.host,
        cwd,
        args: [
          "status",
          "--short",
          "--branch",
          "--untracked-files=all",
        ],
      });
  } catch (error) {
    if (isNonGitWorkspaceError(error)) {
      return {
        unavailable: true,
        reason: "workspace-not-git",
        generatedAt,
        cwd,
      };
    }
    throw error;
  }
  const unstagedArgs = [
    "diff",
    "--no-ext-diff",
    "--stat",
    "--patch",
    "--submodule=diff",
  ];
  const stagedArgs = [
    "diff",
    "--cached",
    "--no-ext-diff",
    "--stat",
    "--patch",
    "--submodule=diff",
  ];
  const unstagedDiff = execution.local
    ? await runGit(cwd, unstagedArgs)
    : await runRemoteGit({
      connectTimeoutSecs: config?.hostSshConnectTimeoutSecs || 10,
      currentHostId: config?.currentHostId || "local",
      host: execution.host,
      cwd,
      args: unstagedArgs,
    });
  const stagedDiff = execution.local
    ? await runGit(cwd, stagedArgs)
    : await runRemoteGit({
      connectTimeoutSecs: config?.hostSshConnectTimeoutSecs || 10,
      currentHostId: config?.currentHostId || "local",
      host: execution.host,
      cwd,
      args: stagedArgs,
    });

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
