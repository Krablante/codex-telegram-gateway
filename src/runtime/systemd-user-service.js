import os from "node:os";
import path from "node:path";
import process from "node:process";

export const SYSTEMD_USER_SERVICE_NAME = "codex-telegram-gateway.service";
export const SYSTEMD_USER_OMNI_SERVICE_NAME = "codex-telegram-gateway-omni.service";

export function isSystemdUserSupported(platform = process.platform) {
  return platform === "linux";
}

function quoteEnvironment(name, value) {
  const escaped = String(value)
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"');
  return `Environment="${name}=${escaped}"`;
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
  pathEntries = [],
  description = "Codex Telegram Gateway",
  scriptPath = "src/cli/run.js",
}) {
  const pathValue = [...new Set(pathEntries.filter(Boolean))].join(":");

  return [
    "[Unit]",
    `Description=${description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${repoRoot}`,
    quoteEnvironment("ENV_FILE", envFilePath),
    quoteEnvironment("NODE", nodePath),
    quoteEnvironment("CODEX_BIN_PATH", codexBinPath),
    quoteEnvironment("PATH", pathValue),
    `ExecStart=${nodePath} ${scriptPath}`,
    "Restart=always",
    "RestartSec=5",
    "KillMode=control-group",
    "KillSignal=SIGINT",
    "SuccessExitStatus=130 SIGINT",
    "TimeoutStopSec=20",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
