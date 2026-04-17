import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import {
  MIN_SYSTEMD_EXIT_TYPE_CGROUP_VERSION,
  SYSTEMD_USER_OMNI_SERVICE_NAME,
  SYSTEMD_USER_SERVICE_NAME,
  buildServicePathEntries,
  buildUnsupportedSystemdUserMessage,
  buildUserServiceUnit,
  getUserServiceUnitPath,
  isSystemdUserSupported,
  parseSystemdVersion,
  supportsExitTypeCgroup,
} from "../runtime/systemd-user-service.js";
import { resolveExecutablePath } from "../runtime/executable-path.js";

const execFileAsync = promisify(execFile);

function printLine(label, value) {
  console.log(`${label}: ${value}`);
}

async function resolveCodexBinPath(config, nodePath) {
  try {
    return await resolveExecutablePath(config.codexBinPath, {
      cwd: config.repoRoot,
      preferredDirectories: [path.dirname(nodePath)],
    });
  } catch {
    throw new Error(
      `Unable to resolve codex binary: ${config.codexBinPath}. Set CODEX_BIN_PATH to an absolute path or a PATH-visible executable.`,
    );
  }
}

async function readLingerState() {
  const username = os.userInfo().username;
  try {
    const { stdout } = await execFileAsync("loginctl", [
      "show-user",
      username,
      "--property=Linger",
      "--value",
    ]);
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function runSystemctl(args) {
  await execFileAsync("systemctl", ["--user", ...args]);
}

async function readSystemdVersion() {
  const { stdout } = await execFileAsync("systemctl", ["--user", "--version"]);
  return parseSystemdVersion(stdout);
}

async function main() {
  const omniVariant = process.env.SERVICE_VARIANT === "omni";
  if (!isSystemdUserSupported()) {
    throw new Error(buildUnsupportedSystemdUserMessage({
      omniVariant,
    }));
  }

  const config = await loadRuntimeConfig();
  const serviceName = omniVariant
    ? SYSTEMD_USER_OMNI_SERVICE_NAME
    : SYSTEMD_USER_SERVICE_NAME;
  const description = omniVariant
    ? "Codex Telegram Gateway Omni"
    : "Codex Telegram Gateway";
  const scriptPath = omniVariant ? "src/cli/run-omni.js" : "src/cli/run.js";
  const systemdVersion = await readSystemdVersion();
  if (
    !omniVariant
    && !supportsExitTypeCgroup(systemdVersion)
  ) {
    throw new Error(
      `Spike session-aware service install requires systemd >= ${MIN_SYSTEMD_EXIT_TYPE_CGROUP_VERSION} for ExitType=cgroup; detected ${systemdVersion ?? "unknown"}. Use foreground runs or upgrade systemd.`,
    );
  }
  const nodePath = process.execPath;
  const codexBinPath = await resolveCodexBinPath(config, nodePath);
  const unitPath = getUserServiceUnitPath(undefined, serviceName);
  const unitText = buildUserServiceUnit({
    repoRoot: config.repoRoot,
    envFilePath: config.envFilePath,
    nodePath,
    codexBinPath,
    codexConfigPath: config.codexConfigPath,
    pathEntries: buildServicePathEntries({ nodePath }),
    description,
    scriptPath,
    exitType: omniVariant ? null : "cgroup",
  });

  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.writeFile(unitPath, unitText, "utf8");

  await runSystemctl(["daemon-reload"]);
  await runSystemctl(["enable", "--now", serviceName]);

  const { stdout } = await execFileAsync("systemctl", [
    "--user",
    "show",
    serviceName,
    "--property=ActiveState,SubState,UnitFileState",
  ]);

  const linger = await readLingerState();

  printLine("service", serviceName);
  printLine("unit_path", unitPath);
  printLine("node", nodePath);
  printLine("codex", codexBinPath);
  printLine("systemd_version", systemdVersion ?? "unknown");
  printLine("linger", linger);
  printLine("systemd", stdout.trim().replace(/\n/gu, " "));

  if (linger !== "yes") {
    console.log(
      "warning: user linger is disabled; the service is persistent in the active user session but will not auto-start before first login after reboot.",
    );
  }
}

main().catch((error) => {
  console.error(`service install failed: ${error.message}`);
  process.exitCode = 1;
});
