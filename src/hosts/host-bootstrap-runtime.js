import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

import { writeTextAtomic } from "../state/file-utils.js";
import {
  buildRsyncBaseArgs,
  buildRsyncRemotePath,
  normalizeRsyncLocalPath,
  runCommand,
  runHostBash,
  shellQuote,
} from "./host-command-runner.js";

const REMOTE_BOOTSTRAP_TIMEOUT_MS = 15 * 60 * 1000;
const LARGE_OUTPUT_BUFFER_BYTES = 16 * 1024 * 1024;
const REQUIRED_NODE_MAJOR = 24;
const DEFAULT_REMOTE_WORKSPACE_ROOT = "~/workspace";
const DEFAULT_REMOTE_REPO_ROOT = "~/workspace/codex-telegram-gateway";
const DEFAULT_REMOTE_RUNTIME_ROOT = "~/.local/state/codex-telegram-gateway";
const CODEX_PROFILE_SYNC_EXCLUDES = [
  "config.toml",
  "auth.json",
  "sessions/",
  "archived_sessions/",
  ".tmp/",
  "tmp/",
  "cache/",
  "log/",
  "shell_snapshots/",
  "vendor_imports/",
  "history.jsonl",
  "session_index.jsonl",
  "models_cache.json",
  "cloud-requirements-cache.json",
  "logs_2.sqlite*",
  "state_5.sqlite*",
];

function expandHomePath(value, homeDir = os.homedir()) {
  if (!value) {
    return null;
  }

  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/")) {
    return path.join(homeDir, value.slice(2));
  }

  return value;
}

function parseKeyValueLines(text) {
  const pairs = {};
  for (const rawLine of String(text || "").split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    pairs[key] = value;
  }

  return pairs;
}

async function detectInstalledCodexNpmSpec(execFileImpl = execFile) {
  try {
    const { stdout } = await runCommand(
      "npm",
      ["ls", "-g", "--json", "--depth=0"],
      {
        execFileImpl,
        timeoutMs: 10_000,
      },
    );
    const parsed = JSON.parse(stdout);
    const version = parsed?.dependencies?.["@openai/codex"]?.version;
    return version
      ? `@openai/codex@${version}`
      : null;
  } catch {
    return null;
  }
}

function isPinnedCodexNpmSpec(value) {
  const normalized = String(value || "").trim();
  return /^@openai\/codex@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u
    .test(normalized);
}

async function assertReadableFile(filePath, label) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing readable ${label}: ${filePath}`);
  }
}

async function assertReadableDirectory(directoryPath, label) {
  try {
    const stats = await fs.stat(directoryPath);
    if (!stats.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new Error(`Missing readable ${label}: ${directoryPath}`);
  }
}

function buildBootstrapScript({
  workspaceRoot,
  repoRoot,
  runtimeRoot,
  codexPackageSpec,
  skipCodexInstall = false,
}) {
  return [
    "set -euo pipefail",
    "expand_path() {",
    '  local value="$1"',
    '  if [[ "$value" == "~" ]]; then printf "%s\\n" "$HOME"; return; fi',
    '  if [[ "$value" == "~/"* ]]; then printf "%s/%s\\n" "$HOME" "${value:2}"; return; fi',
    '  printf "%s\\n" "$value"',
    "}",
    `workspace_root=$(expand_path ${shellQuote(workspaceRoot)})`,
    `repo_root=$(expand_path ${shellQuote(repoRoot)})`,
    `runtime_root=$(expand_path ${shellQuote(runtimeRoot)})`,
    `codex_package=${shellQuote(codexPackageSpec)}`,
    `required_node_major=${REQUIRED_NODE_MAJOR}`,
    `skip_codex_install=${skipCodexInstall ? "1" : "0"}`,
    "install_supported_node() {",
    '  source /etc/os-release',
    '  case "$ID" in',
    '    ubuntu|debian)',
    '      sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update',
    '      sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg',
    '      sudo -n install -d -m 0755 /etc/apt/keyrings',
    '      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo -n gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg',
    '      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${required_node_major}.x nodistro main" | sudo -n tee /etc/apt/sources.list.d/nodesource.list >/dev/null',
    '      sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update',
    '      sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs',
    "      ;;",
    "    arch)",
    '      sudo -n pacman -Sy --noconfirm nodejs npm',
    "      ;;",
    '    *) echo "unsupported-os:$ID" >&2; exit 1 ;;',
    "  esac",
    "}",
    "node_runtime_ready() {",
    '  command -v node >/dev/null 2>&1 || return 1',
    '  node - <<\'NODE\' >/dev/null 2>&1',
    'const [major] = process.versions.node.split(".").map((value) => Number.parseInt(value, 10));',
    `if (!Number.isFinite(major) || major < ${REQUIRED_NODE_MAJOR}) {`,
    "  process.exit(1);",
    "}",
    "NODE",
    "}",
    'mkdir -p "$workspace_root" "$repo_root" "$runtime_root"',
    'if ! node_runtime_ready || ! command -v npm >/dev/null 2>&1; then',
    '  install_supported_node',
    "fi",
    'node_runtime_ready',
    'if ! command -v codex >/dev/null 2>&1; then',
    '  if [[ "$skip_codex_install" != "1" ]]; then sudo -n npm install -g "$codex_package"; fi',
    "fi",
    'if [[ "$skip_codex_install" != "1" ]]; then codex exec --help >/dev/null 2>&1; fi',
  ].join("\n");
}

function buildRuntimeProbeScript(host) {
  return [
    "set -euo pipefail",
    "expand_path() {",
    '  local value="$1"',
    '  if [[ "$value" == "~" ]]; then printf "%s\\n" "$HOME"; return; fi',
    '  if [[ "$value" == "~/"* ]]; then printf "%s/%s\\n" "$HOME" "${value:2}"; return; fi',
    '  printf "%s\\n" "$value"',
    "}",
    `workspace_root=$(expand_path ${shellQuote(host.workspace_root || "~")})`,
    `repo_root=$(expand_path ${shellQuote(host.repo_root || "~")})`,
    `runtime_root=$(expand_path ${shellQuote(host.worker_runtime_root || "~")})`,
    `codex_config_path=$(expand_path ${shellQuote(host.codex_config_path || "~/.codex/config.toml")})`,
    `codex_auth_path=$(expand_path ${shellQuote(host.codex_auth_path || "~/.codex/auth.json")})`,
    `configured_codex_path=$(expand_path ${shellQuote(host.codex_bin_path || "codex")})`,
    'printf "home_path=%s\\n" "$HOME"',
    'printf "node_path=%s\\n" "$(command -v node || true)"',
    'printf "node_version=%s\\n" "$(node --version 2>/dev/null || true)"',
    'printf "npm_path=%s\\n" "$(command -v npm || true)"',
    'printf "npm_version=%s\\n" "$(npm --version 2>/dev/null || true)"',
    'printf "codex_path=%s\\n" "$(command -v codex || true)"',
    'printf "configured_codex_present=%s\\n" "$([[ -x "$configured_codex_path" ]] && echo 1 || echo 0)"',
    'printf "configured_codex_path=%s\\n" "$([[ -x "$configured_codex_path" ]] && printf "%s" "$configured_codex_path")"',
    'printf "docker_path=%s\\n" "$(command -v docker || true)"',
    'printf "workspace_root_exists=%s\\n" "$([[ -d "$workspace_root" ]] && echo 1 || echo 0)"',
    'printf "repo_root_exists=%s\\n" "$([[ -d "$repo_root" ]] && echo 1 || echo 0)"',
    'printf "runtime_root_exists=%s\\n" "$([[ -d "$runtime_root" ]] && echo 1 || echo 0)"',
    'printf "config_present=%s\\n" "$([[ -f "$codex_config_path" ]] && echo 1 || echo 0)"',
    'printf "auth_present=%s\\n" "$([[ -f "$codex_auth_path" ]] && echo 1 || echo 0)"',
  ].join("\n");
}

async function copyLocalFileToHost({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  localPath,
  remotePath,
  chmod = null,
}) {
  const remoteDirectory = path.posix.dirname(remotePath);
  await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      `target=${shellQuote(remoteDirectory)}`,
      'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
      'mkdir -p "$target"',
    ].join("; "),
    timeoutMs: 20_000,
  });
  await runCommand(
    "rsync",
    [
      ...buildRsyncBaseArgs(connectTimeoutSecs),
      ...(chmod ? [`--chmod=${chmod}`] : []),
      normalizeRsyncLocalPath(localPath),
      buildRsyncRemotePath(host.ssh_target, remotePath),
    ],
    {
      execFileImpl,
      timeoutMs: 30_000,
    },
  );
}

async function syncLocalDirectoryToHost({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  localPath,
  remotePath,
  exclude = [],
}) {
  await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      `target=${shellQuote(remotePath)}`,
      'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
      'mkdir -p "$target"',
    ].join("; "),
    timeoutMs: 20_000,
  });

  const sourceRoot = localPath.endsWith(path.sep) ? localPath : `${localPath}${path.sep}`;
  await runCommand(
    "rsync",
    [
      ...buildRsyncBaseArgs(connectTimeoutSecs),
      "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=",
      ...exclude.flatMap((pattern) => ["--exclude", pattern]),
      normalizeRsyncLocalPath(sourceRoot),
      buildRsyncRemotePath(host.ssh_target, `${remotePath}/`),
    ],
    {
      execFileImpl,
      timeoutMs: 60_000,
    },
  );
}

function replaceAll(text, sourceValue, targetValue) {
  if (!sourceValue || sourceValue === targetValue) {
    return text;
  }
  return text.split(sourceValue).join(targetValue);
}

function normalizeCodexConfigText(
  configText,
  {
    sourceCodexRoot,
    sourceWorkspaceRoot,
    targetHomePath,
    targetWorkspaceRoot,
  },
) {
  const sourceHomePath = sourceCodexRoot
    ? path.dirname(sourceCodexRoot)
    : null;
  const replacements = [
    [sourceWorkspaceRoot, targetWorkspaceRoot],
    [sourceHomePath, targetHomePath],
  ].filter(([sourceValue, targetValue]) =>
    typeof sourceValue === "string"
    && sourceValue.length > 0
    && typeof targetValue === "string"
    && targetValue.length > 0,
  ).sort((left, right) => right[0].length - left[0].length);

  let normalized = String(configText);
  for (const [sourceValue, targetValue] of replacements) {
    normalized = replaceAll(normalized, sourceValue, targetValue);
  }
  return normalized;
}

function resolveRemoteCustomCodexPath({
  host,
  sourceBinPath,
  sourceWorkspaceRoot,
}) {
  if (!sourceBinPath || !path.isAbsolute(sourceBinPath)) {
    return null;
  }

  if (sourceWorkspaceRoot && path.isAbsolute(sourceWorkspaceRoot)) {
    const relativePath = path.relative(sourceWorkspaceRoot, sourceBinPath);
    if (
      relativePath === ""
      || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
    ) {
      return path.posix.join(
        host.workspace_root || DEFAULT_REMOTE_WORKSPACE_ROOT,
        relativePath.replace(/\\/gu, "/"),
      );
    }
  }

  return path.posix.join(
    host.worker_runtime_root || DEFAULT_REMOTE_RUNTIME_ROOT,
    "bin",
    path.basename(sourceBinPath),
  );
}

export async function runHostBootstrapRuntime({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl = execFile,
  hostsRoot,
  registryService,
  sourceBinPath = null,
  sourceCodexRoot = null,
  sourceAuthPath = null,
  sourceConfigPath = null,
  sourceWorkspaceRoot = null,
  targetHostId,
  codexNpmSpec = null,
}) {
  if (!targetHostId) {
    throw new Error("Host runtime bootstrap requires --host");
  }

  const host = await registryService.getHost(targetHostId);
  if (!host) {
    throw new Error(`Unknown host for runtime bootstrap: ${targetHostId}`);
  }
  if (host.host_id === currentHostId) {
    throw new Error("Host runtime bootstrap target must be different from the current host");
  }
  if (!host.ssh_target) {
    throw new Error(`Host ${targetHostId} is missing ssh_target`);
  }

  const currentHost = await registryService.getHost(currentHostId);
  const resolvedSourceConfigPath = expandHomePath(
    sourceConfigPath || currentHost?.codex_config_path || "~/.codex/config.toml",
  );
  const resolvedSourceAuthPath = expandHomePath(
    sourceAuthPath || currentHost?.codex_auth_path || "~/.codex/auth.json",
  );
  const resolvedSourceCodexRoot = expandHomePath(
    sourceCodexRoot || path.dirname(resolvedSourceConfigPath),
  );
  const resolvedSourceWorkspaceRoot = expandHomePath(
    sourceWorkspaceRoot,
  );
  const resolvedSourceBinPath = expandHomePath(sourceBinPath);
  await assertReadableFile(resolvedSourceConfigPath, "Codex config");
  await assertReadableFile(resolvedSourceAuthPath, "Codex auth");
  await assertReadableDirectory(resolvedSourceCodexRoot, "Codex profile root");
  if (resolvedSourceBinPath) {
    await assertReadableFile(resolvedSourceBinPath, "Codex binary");
  }

  const resolvedCodexNpmSpec =
    codexNpmSpec || await detectInstalledCodexNpmSpec(execFileImpl);
  const resolvedRemoteBinPath = resolveRemoteCustomCodexPath({
    host,
    sourceBinPath: resolvedSourceBinPath,
    sourceWorkspaceRoot: resolvedSourceWorkspaceRoot,
  });
  if (!resolvedRemoteBinPath && !isPinnedCodexNpmSpec(resolvedCodexNpmSpec)) {
    throw new Error(
      "Host runtime bootstrap requires a copied Codex binary or a pinned codexNpmSpec such as @openai/codex@0.124.0",
    );
  }

  await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    maxBufferBytes: LARGE_OUTPUT_BUFFER_BYTES,
    script: buildBootstrapScript({
      workspaceRoot: host.workspace_root || DEFAULT_REMOTE_WORKSPACE_ROOT,
      repoRoot: host.repo_root || DEFAULT_REMOTE_REPO_ROOT,
      runtimeRoot: host.worker_runtime_root || DEFAULT_REMOTE_RUNTIME_ROOT,
      codexPackageSpec: resolvedCodexNpmSpec,
      skipCodexInstall: Boolean(resolvedRemoteBinPath),
    }),
    timeoutMs: REMOTE_BOOTSTRAP_TIMEOUT_MS,
  });

  const bootstrapProbe = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host: resolvedRemoteBinPath
      ? { ...host, codex_bin_path: resolvedRemoteBinPath }
      : host,
    script: buildRuntimeProbeScript(
      resolvedRemoteBinPath
        ? { ...host, codex_bin_path: resolvedRemoteBinPath }
        : host,
    ),
    timeoutMs: 20_000,
  });
  const bootstrapProbeFields = parseKeyValueLines(bootstrapProbe.stdout);
  const remoteHomePath = bootstrapProbeFields.home_path || null;
  const remoteCodexRoot = path.posix.dirname(
    host.codex_config_path || "~/.codex/config.toml",
  );

  await syncLocalDirectoryToHost({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    localPath: resolvedSourceCodexRoot,
    remotePath: remoteCodexRoot,
    exclude: CODEX_PROFILE_SYNC_EXCLUDES,
  });

  const normalizedConfigText = normalizeCodexConfigText(
    await fs.readFile(resolvedSourceConfigPath, "utf8"),
    {
      sourceCodexRoot: resolvedSourceCodexRoot,
      sourceWorkspaceRoot: resolvedSourceWorkspaceRoot,
      targetHomePath: remoteHomePath,
      targetWorkspaceRoot: remoteHomePath
        ? expandHomePath(host.workspace_root || null, remoteHomePath)
        : host.workspace_root || null,
    },
  );
  const normalizedConfigPath = path.join(
    hostsRoot,
    `${host.host_id}-bootstrap-config.toml`,
  );
  await writeTextAtomic(normalizedConfigPath, normalizedConfigText);
  await fs.chmod(normalizedConfigPath, 0o600).catch(() => null);
  try {
    await copyLocalFileToHost({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      localPath: normalizedConfigPath,
      remotePath: host.codex_config_path || "~/.codex/config.toml",
      chmod: "600",
    });
  } finally {
    await fs.rm(normalizedConfigPath, { force: true });
  }
  await copyLocalFileToHost({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    localPath: resolvedSourceAuthPath,
    remotePath: host.codex_auth_path || "~/.codex/auth.json",
    chmod: "600",
  });

  if (resolvedRemoteBinPath) {
    await copyLocalFileToHost({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      localPath: resolvedSourceBinPath,
      remotePath: resolvedRemoteBinPath,
      chmod: "755",
    });
  }

  const probe = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host: resolvedRemoteBinPath
      ? { ...host, codex_bin_path: resolvedRemoteBinPath }
      : host,
    script: buildRuntimeProbeScript(
      resolvedRemoteBinPath
        ? { ...host, codex_bin_path: resolvedRemoteBinPath }
        : host,
    ),
    timeoutMs: 20_000,
  });
  const probeFields = parseKeyValueLines(probe.stdout);
  await registryService.patchHost(host.host_id, {
    codex_bin_path:
      probeFields.configured_codex_path
      || probeFields.codex_path
      || host.codex_bin_path,
  });
  const summary = {
    ran_at: new Date().toISOString(),
    current_host_id: currentHostId,
    host_id: host.host_id,
    status: "bootstrapped",
    codex_npm_spec: resolvedCodexNpmSpec,
    source_codex_root: resolvedSourceCodexRoot,
    source_config_path: resolvedSourceConfigPath,
    source_auth_path: resolvedSourceAuthPath,
    source_bin_path: resolvedSourceBinPath,
    remote_codex_root: remoteCodexRoot,
    remote_bin_path: resolvedRemoteBinPath,
    profile_sync_excludes: CODEX_PROFILE_SYNC_EXCLUDES,
    probe: {
      home_path: probeFields.home_path || null,
      node_path: probeFields.node_path || null,
      node_version: probeFields.node_version || null,
      npm_path: probeFields.npm_path || null,
      npm_version: probeFields.npm_version || null,
      codex_path:
        probeFields.configured_codex_path
        || probeFields.codex_path
        || null,
      docker_path: probeFields.docker_path || null,
      workspace_root_exists: probeFields.workspace_root_exists === "1",
      repo_root_exists: probeFields.repo_root_exists === "1",
      runtime_root_exists: probeFields.runtime_root_exists === "1",
      config_present: probeFields.config_present === "1",
      auth_present: probeFields.auth_present === "1",
    },
  };

  await writeTextAtomic(
    path.join(hostsRoot, "bootstrap-last-run.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  return summary;
}
