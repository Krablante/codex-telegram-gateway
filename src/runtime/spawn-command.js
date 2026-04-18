import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import {
  getExecutableSearchPathValue,
  resolveExecutablePathSync,
} from "./executable-path.js";

const WINDOWS_SHELL_EXTENSIONS = new Set([".bat", ".cmd"]);
const UNSUPPORTED_WINDOWS_SHELL_METACHARS = /[%\r\n]/u;

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

function getWindowsCommandShell(env) {
  return String(env?.ComSpec || env?.COMSPEC || "cmd.exe").trim() || "cmd.exe";
}

function buildWindowsCommandLine(command, args) {
  return [command, ...args].map((value) => quoteWindowsShellValue(value)).join(" ");
}

function assertSupportedWindowsShellValues(command, args) {
  const unsafeValue = [command, ...args].find((value) =>
    UNSUPPORTED_WINDOWS_SHELL_METACHARS.test(String(value ?? ""))
  );
  if (unsafeValue === undefined) {
    return;
  }

  throw new Error(
    "Windows .cmd/.bat launch does not support % or newline characters in shell-routed values; use a wrapper script or JSON argv instead.",
  );
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
    assertSupportedWindowsShellValues(resolvedCommand, normalizedArgs);
    return {
      command: getWindowsCommandShell(env),
      args: [
        "/d",
        "/s",
        "/c",
        buildWindowsCommandLine(resolvedCommand, normalizedArgs),
      ],
      spawnOptions: {
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
