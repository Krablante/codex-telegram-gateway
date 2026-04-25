import path from "node:path";

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function isSameOrDescendantPath(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === ""
    || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function toPosixRelativePath(value) {
  return String(value || ".").replace(/\\/gu, "/");
}

function resolveWorkspaceRelativePath(workspaceBinding, absolutePath) {
  const normalizedAbsolutePath = normalizeOptionalText(absolutePath);
  const workspaceRoot = normalizeOptionalText(
    workspaceBinding?.workspace_root,
  );
  if (!normalizedAbsolutePath || !workspaceRoot) {
    return null;
  }

  if (!isSameOrDescendantPath(workspaceRoot, normalizedAbsolutePath)) {
    return null;
  }

  return path.relative(workspaceRoot, normalizedAbsolutePath) || ".";
}

export function resolveBindingRelativeCwd(workspaceBinding) {
  const explicitRelativePath = normalizeOptionalText(
    workspaceBinding?.cwd_relative_to_workspace_root,
  );
  if (explicitRelativePath) {
    return explicitRelativePath;
  }

  return resolveWorkspaceRelativePath(
    workspaceBinding,
    workspaceBinding?.cwd,
  );
}

export function translateWorkspacePathForHost(
  absolutePath,
  {
    workspaceBinding,
    host,
    currentHostId,
  },
) {
  const normalizedAbsolutePath = normalizeOptionalText(absolutePath);
  const normalizedWorkspaceRoot = normalizeOptionalText(host?.workspace_root);
  const normalizedHostId = normalizeOptionalText(host?.host_id);
  const normalizedCurrentHostId = normalizeOptionalText(currentHostId);

  if (!normalizedAbsolutePath) {
    return null;
  }
  if (normalizedHostId && normalizedHostId === normalizedCurrentHostId) {
    return normalizedAbsolutePath;
  }
  if (!normalizedWorkspaceRoot) {
    return null;
  }

  const relativePath = resolveWorkspaceRelativePath(
    workspaceBinding,
    normalizedAbsolutePath,
  );
  if (!relativePath) {
    return null;
  }

  return relativePath === "."
    ? normalizedWorkspaceRoot
    : path.posix.join(normalizedWorkspaceRoot, toPosixRelativePath(relativePath));
}

export function resolveExecutionCwd({
  workspaceBinding,
  host,
  currentHostId,
}) {
  const normalizedHostId = normalizeOptionalText(host?.host_id);
  const normalizedCurrentHostId = normalizeOptionalText(currentHostId);
  const localCwd = normalizeOptionalText(workspaceBinding?.cwd);

  if (normalizedHostId && normalizedHostId === normalizedCurrentHostId) {
    return localCwd;
  }

  const normalizedWorkspaceRoot = normalizeOptionalText(host?.workspace_root);
  if (!normalizedWorkspaceRoot) {
    return null;
  }

  const relativeCwd = resolveBindingRelativeCwd(workspaceBinding);
  if (!relativeCwd) {
    return null;
  }

  return relativeCwd === "."
    ? normalizedWorkspaceRoot
    : path.posix.join(
        normalizedWorkspaceRoot,
        toPosixRelativePath(relativeCwd),
      );
}
