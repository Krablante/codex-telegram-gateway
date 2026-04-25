import { execFile } from "node:child_process";
import process from "node:process";

function buildExecFilePromise(execFileImpl, command, args, options) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({
        stdout,
        stderr,
      });
    });
  });
}

export function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/gu, `'\\''`)}'`;
}

export function normalizeRsyncLocalPath(
  localPath,
  { platform = process.platform } = {},
) {
  const normalized = String(localPath ?? "");
  if (platform !== "win32") {
    return normalized;
  }

  const driveMatch = normalized.match(/^([A-Za-z]):[\\/]*(.*)$/u);
  if (!driveMatch) {
    return normalized.replace(/\\/gu, "/");
  }

  const [, drive, rest] = driveMatch;
  const posixRest = rest.replace(/[\\/]+/gu, "/");
  const trailingSeparator = /[\\/]$/u.test(normalized);
  return `/${drive.toLowerCase()}${
    posixRest ? `/${posixRest}` : trailingSeparator ? "/" : ""
  }`;
}

function isRemoteHost(host, currentHostId) {
  return String(host?.host_id || "").trim() !== String(currentHostId || "").trim();
}

function buildSshOptionArgs(connectTimeoutSecs) {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${connectTimeoutSecs}`,
  ];
}

export function normalizeSshTarget(target) {
  const normalized = String(target ?? "").trim();
  if (!normalized) {
    throw new Error("SSH target is required");
  }
  if (
    normalized.startsWith("-")
    || /[\s"'`$;&|<>()[\]{}!*?\\]/u.test(normalized)
    || normalized.includes(":")
    || !/^(?:[A-Za-z0-9._~-]+@)?[A-Za-z0-9._~-]+$/u.test(normalized)
  ) {
    throw new Error(`Unsafe SSH target: ${normalized}`);
  }
  return normalized;
}

export function buildSshBaseArgs(target, connectTimeoutSecs) {
  const safeTarget = normalizeSshTarget(target);
  return [
    ...buildSshOptionArgs(connectTimeoutSecs),
    safeTarget,
  ];
}

function buildShellCommand(command, args = []) {
  return [
    command,
    ...args,
  ].map((part) => shellQuote(part)).join(" ");
}

function buildRsyncTransportCommand(connectTimeoutSecs) {
  return buildShellCommand(
    "ssh",
    buildSshOptionArgs(connectTimeoutSecs),
  );
}

export function buildRsyncBaseArgs(connectTimeoutSecs) {
  return [
    "-az",
    "-s",
    "-e",
    buildRsyncTransportCommand(connectTimeoutSecs),
  ];
}

export function buildRsyncRemotePath(target, remotePath) {
  return `${normalizeSshTarget(target)}:${remotePath}`;
}

export async function runCommand(
  command,
  args = [],
  {
    cwd = undefined,
    env = undefined,
    execFileImpl = execFile,
    maxBufferBytes = 1024 * 1024,
    timeoutMs = 0,
  } = {},
) {
  return buildExecFilePromise(
    execFileImpl,
    command,
    args,
    {
      cwd,
      env,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: maxBufferBytes,
    },
  );
}

export async function runHostBash({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl = execFile,
  host,
  maxBufferBytes = 1024 * 1024,
  script,
  timeoutMs = 0,
}) {
  if (isRemoteHost(host, currentHostId)) {
    return runCommand(
      "ssh",
      [
        ...buildSshBaseArgs(host.ssh_target, connectTimeoutSecs),
        `bash -c ${shellQuote(script)}`,
      ],
      {
        execFileImpl,
        maxBufferBytes,
        timeoutMs,
      },
    );
  }

  return runCommand(
    "bash",
    ["-c", script],
    {
      execFileImpl,
      maxBufferBytes,
      timeoutMs,
    },
  );
}
