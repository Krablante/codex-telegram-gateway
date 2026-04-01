import os from "node:os";
import path from "node:path";

export const SYSTEMD_USER_SERVICE_NAME = "codex-telegram-gateway.service";

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
  return path.join(homeDirectory, ".config", "systemd", "user", serviceName);
}

export function buildUserServiceUnit({
  repoRoot,
  envFilePath,
  nodePath,
  codexBinPath,
  pathEntries = [],
}) {
  const pathValue = [...new Set(pathEntries.filter(Boolean))].join(":");

  return [
    "[Unit]",
    "Description=Codex Telegram Gateway",
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
    `ExecStart=${nodePath} src/cli/run.js`,
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
