import process from "node:process";

const WINDOWS_COMMAND_HINTS = Object.freeze({
  admin: "scripts\\windows\\admin.cmd",
  doctor: "scripts\\windows\\doctor.cmd",
  install: "scripts\\windows\\install.cmd",
  "install-codex": "scripts\\windows\\install-codex.cmd",
  run: "scripts\\windows\\run.cmd",
  test: "scripts\\windows\\test.cmd",
  "test-live": "scripts\\windows\\test-live.cmd",
  "user-e2e": "scripts\\windows\\user-e2e.cmd",
  "user-login": "scripts\\windows\\user-login.cmd",
  "user-spike-audit": "scripts\\windows\\user-spike-audit.cmd",
  "user-status": "scripts\\windows\\user-status.cmd",
});

export function getOperatorCommandHint(
  commandName,
  { platform = process.platform } = {},
) {
  const normalized = String(commandName ?? "").trim();
  if (!normalized) {
    return null;
  }

  if (platform === "win32") {
    return WINDOWS_COMMAND_HINTS[normalized] || normalized;
  }

  return `make ${normalized}`;
}

export function formatOperatorCommandHints(
  commandNames,
  { platform = process.platform } = {},
) {
  return (Array.isArray(commandNames) ? commandNames : [])
    .map((commandName) => getOperatorCommandHint(commandName, { platform }))
    .filter(Boolean)
    .map((command) => `\`${command}\``)
    .join(", ");
}
