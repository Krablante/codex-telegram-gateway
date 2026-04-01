import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import {
  SYSTEMD_USER_SERVICE_NAME,
  buildUserServiceUnit,
  getUserServiceUnitPath,
} from "../runtime/systemd-user-service.js";

const execFileAsync = promisify(execFile);

function printLine(label, value) {
  console.log(`${label}: ${value}`);
}

function buildRuntimePath(nodePath) {
  return [
    path.dirname(nodePath),
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ];
}

async function resolveCodexBinPath(config) {
  if (path.isAbsolute(config.codexBinPath)) {
    return config.codexBinPath;
  }

  const { stdout } = await execFileAsync("/bin/bash", [
    "-lc",
    `command -v ${config.codexBinPath}`,
  ]);
  const resolved = stdout.trim();
  if (!resolved) {
    throw new Error(`Unable to resolve codex binary: ${config.codexBinPath}`);
  }

  return resolved;
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

async function main() {
  const config = await loadRuntimeConfig();
  const nodePath = process.execPath;
  const codexBinPath = await resolveCodexBinPath(config);
  const unitPath = getUserServiceUnitPath();
  const unitText = buildUserServiceUnit({
    repoRoot: config.repoRoot,
    envFilePath: config.envFilePath,
    nodePath,
    codexBinPath,
    pathEntries: buildRuntimePath(nodePath),
  });

  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.writeFile(unitPath, unitText, "utf8");

  await runSystemctl(["daemon-reload"]);
  await runSystemctl(["enable", "--now", SYSTEMD_USER_SERVICE_NAME]);

  const { stdout } = await execFileAsync("systemctl", [
    "--user",
    "show",
    SYSTEMD_USER_SERVICE_NAME,
    "--property=ActiveState,SubState,UnitFileState",
  ]);

  const linger = await readLingerState();

  printLine("service", SYSTEMD_USER_SERVICE_NAME);
  printLine("unit_path", unitPath);
  printLine("node", nodePath);
  printLine("codex", codexBinPath);
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
