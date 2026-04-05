import { spawn } from "node:child_process";
import process from "node:process";

function isFinitePid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

export function buildWindowsTaskkillArgs(pid, { force = false } = {}) {
  if (!isFinitePid(pid)) {
    return null;
  }

  return [
    "/pid",
    String(pid),
    "/t",
    ...(force ? ["/f"] : []),
  ];
}

function startWindowsTaskkill(
  pid,
  {
    force = false,
    spawnImpl = spawn,
  } = {},
) {
  const args = buildWindowsTaskkillArgs(pid, { force });
  if (!args) {
    return false;
  }

  try {
    const child = spawnImpl("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

export function signalChildProcessTree(
  child,
  signal,
  {
    platform = process.platform,
    processImpl = process,
    spawnImpl = spawn,
  } = {},
) {
  if (!child) {
    return false;
  }

  if (platform === "win32" && isFinitePid(child.pid)) {
    const force = signal === "SIGKILL";
    if (startWindowsTaskkill(child.pid, { force, spawnImpl })) {
      return true;
    }
  }

  if (isFinitePid(child.pid)) {
    try {
      processImpl.kill(-child.pid, signal);
      return true;
    } catch {}
  }

  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}
