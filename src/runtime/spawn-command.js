import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import {
  getExecutableSearchPathValue,
  resolveExecutablePathSync,
} from "./executable-path.js";

const WINDOWS_SHELL_EXTENSIONS = new Set([".bat", ".cmd"]);

function normalizeCommand(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error("Command is empty");
  }

  return normalized;
}

function normalizeArgs(args) {
  return Array.isArray(args) ? args.map((arg) => String(arg)) : [];
}

function quoteWindowsShellValue(value) {
  const normalized = String(value ?? "");
  const escaped = normalized.replace(/"/gu, "\"\"");
  return /[\s&()<>^|"]/u.test(normalized) ? `"${escaped}"` : normalized;
}

export function buildSpawnCommand(
  command,
  args = [],
  {
    cwd = process.cwd(),
    env = process.env,
    platform = process.platform,
    preferredDirectories = [],
  } = {},
) {
  const normalizedCommand = normalizeCommand(command);
  const normalizedArgs = normalizeArgs(args);

  if (platform !== "win32") {
    return {
      command: normalizedCommand,
      args: normalizedArgs,
      spawnOptions: {},
    };
  }

  let resolvedCommand = normalizedCommand;
  try {
    resolvedCommand = resolveExecutablePathSync(normalizedCommand, {
      cwd,
      env,
      platform,
      pathValue: getExecutableSearchPathValue(env, platform),
      preferredDirectories,
    });
  } catch {}

  const extension = path.win32.extname(resolvedCommand).toLowerCase();
  if (WINDOWS_SHELL_EXTENSIONS.has(extension)) {
    return {
      command: quoteWindowsShellValue(resolvedCommand),
      args: normalizedArgs.map((arg) => quoteWindowsShellValue(arg)),
      spawnOptions: {
        shell: true,
        windowsHide: true,
      },
    };
  }

  return {
    command: resolvedCommand,
    args: normalizedArgs,
    spawnOptions: {
      windowsHide: true,
    },
  };
}

export function spawnRuntimeCommand(
  command,
  args = [],
  {
    spawnImpl = spawn,
    cwd = process.cwd(),
    env = process.env,
    platform = process.platform,
    preferredDirectories = [],
    ...spawnOptions
  } = {},
) {
  const launch = buildSpawnCommand(command, args, {
    cwd,
    env,
    platform,
    preferredDirectories,
  });

  return spawnImpl(launch.command, launch.args, {
    cwd,
    env,
    ...spawnOptions,
    ...launch.spawnOptions,
  });
}
