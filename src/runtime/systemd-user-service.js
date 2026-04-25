import os from "node:os";
import path from "node:path";
import process from "node:process";

import { formatOperatorCommandHints } from "./operator-command-hints.js";

export const SYSTEMD_USER_SERVICE_NAME = "codex-telegram-gateway.service";
export const MIN_SYSTEMD_EXIT_TYPE_CGROUP_VERSION = 250;

export function isSystemdUserSupported(platform = process.platform) {
  return platform === "linux";
}

export function buildUnsupportedSystemdUserMessage() {
  const windowsHints = formatOperatorCommandHints(
    [
      "install",
      "install-codex",
      "doctor",
      "run",
    ],
    { platform: "win32" },
  );

  return `systemd user services are Linux-only here; on Windows use ${windowsHints} instead.`;
}

export function parseSystemdVersion(text) {
  const match = String(text ?? "").match(/\bsystemd\s+(\d+)\b/iu);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function supportsExitTypeCgroup(version) {
  return Number.isInteger(version) && version >= MIN_SYSTEMD_EXIT_TYPE_CGROUP_VERSION;
}

function quoteEnvironment(name, value) {
  const escaped = String(value)
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"');
  return `Environment="${name}=${escaped}"`;
}

function quoteUnitValue(value) {
  const escaped = String(value)
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"');
  return `"${escaped}"`;
}

function escapeDirectiveValue(value) {
  return String(value)
    .replace(/\\/gu, "\\\\")
    .replace(/ /gu, "\\ ");
}

export function buildServicePathEntries({
  nodePath,
  currentPath = process.env.PATH || process.env.Path || "",
} = {}) {
  return [
    path.posix.dirname(String(nodePath ?? "")),
    ...String(currentPath)
      .split(":")
      .map((entry) => entry.trim())
      .filter(Boolean),
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ].filter((entry, index, array) => Boolean(entry) && array.indexOf(entry) === index);
}

export function getUserServiceUnitPath(
  homeDirectory = os.homedir(),
  serviceName = SYSTEMD_USER_SERVICE_NAME,
) {
  return path.posix.join(
    homeDirectory,
    ".config",
    "systemd",
    "user",
    serviceName,
  );
}

export function buildUserServiceUnit({
  repoRoot,
  envFilePath,
  nodePath,
  codexBinPath,
  codexConfigPath,
  pathEntries = [],
  description = "Codex Telegram Gateway",
  scriptPath = "src/cli/run.js",
  exitType = null,
}) {
  const pathValue = [...new Set(pathEntries.filter(Boolean))].join(":");
  const scriptAbsolutePath = path.posix.resolve(repoRoot, scriptPath);

  return [
    "[Unit]",
    `Description=${description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "UMask=0077",
    ...(exitType ? [`ExitType=${exitType}`] : []),
    `WorkingDirectory=${escapeDirectiveValue(repoRoot)}`,
    quoteEnvironment("ENV_FILE", envFilePath),
    quoteEnvironment("NODE", nodePath),
    quoteEnvironment("CODEX_BIN_PATH", codexBinPath),
    quoteEnvironment("CODEX_CONFIG_PATH", codexConfigPath),
    quoteEnvironment("PATH", pathValue),
    `ExecStart=${quoteUnitValue(nodePath)} ${quoteUnitValue(scriptAbsolutePath)}`,
    "Restart=always",
    "RestartSec=5",
    "KillMode=control-group",
    "KillSignal=SIGINT",
    "SuccessExitStatus=130 SIGINT",
    "TimeoutStopSec=infinity",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
