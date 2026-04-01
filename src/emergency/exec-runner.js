import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

function limitText(text, maxChars = 8000) {
  const normalized = String(text || "");
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return normalized.slice(-maxChars);
}

function buildOutputFilePath(emergencyRoot) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, "");
  return path.join(emergencyRoot, "runs", `${stamp}-last-message.txt`);
}

export function buildEmergencyExecArgs({
  repoRoot,
  outputPath,
  imagePaths = [],
}) {
  const args = [
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    repoRoot,
    "--json",
    "-o",
    outputPath,
  ];

  for (const imagePath of imagePaths) {
    args.push("-i", imagePath);
  }

  args.push("-");
  return args;
}

export function startEmergencyExecRun({
  codexBinPath,
  repoRoot,
  stateRoot,
  prompt,
  imagePaths = [],
  spawnProcess = spawn,
}) {
  const emergencyRoot = path.join(stateRoot, "emergency");
  const outputPath = buildOutputFilePath(emergencyRoot);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const args = buildEmergencyExecArgs({
    repoRoot,
    outputPath,
    imagePaths,
  });
  const child = spawnProcess(codexBinPath, args, {
    cwd: repoRoot,
    detached: true,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const done = (async () => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout = limitText(`${stdout}${chunk}`);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = limitText(`${stderr}${chunk}`);
    });

    if (child.stdin) {
      child.stdin.end(String(prompt || ""));
    }

    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    });

    let finalReply = "";
    try {
      finalReply = (await fs.readFile(outputPath, "utf8")).trim();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    return {
      ok: exit.code === 0 && !exit.signal,
      interrupted:
        exit.signal === "SIGTERM" ||
        exit.signal === "SIGKILL" ||
        exit.code === 130 ||
        exit.code === 143,
      exitCode: exit.code,
      signal: exit.signal,
      finalReply,
      stdout,
      stderr,
      outputPath,
    };
  })();

  return {
    child,
    done,
  };
}
