import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { appendCodexRuntimeConfigArgs } from "../codex-runtime/config-args.js";
import { buildCodexChildEnv } from "../runtime/codex-child-env.js";
import { spawnRuntimeCommand } from "../runtime/spawn-command.js";

function limitText(text, maxChars = 8000) {
  const normalized = String(text || "");
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return normalized.slice(-maxChars);
}

function buildOutputFilePath(rootDir, prefix = "last-message") {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, "");
  return path.join(rootDir, `${stamp}-${prefix}.txt`);
}

export function buildCodexExecArgs({
  repoRoot,
  outputPath,
  imagePaths = [],
  model = null,
  reasoningEffort = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
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
  appendCodexRuntimeConfigArgs(args, {
    model,
    reasoningEffort,
    contextWindow,
    autoCompactTokenLimit,
  });

  for (const imagePath of imagePaths) {
    args.push("-i", imagePath);
  }

  args.push("-");
  return args;
}

export function startCodexExecRun({
  codexBinPath,
  repoRoot,
  outputDir,
  outputPrefix = "last-message",
  prompt,
  imagePaths = [],
  model = null,
  reasoningEffort = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  spawnProcess,
  platform = process.platform,
}) {
  const outputPath = buildOutputFilePath(outputDir, outputPrefix);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const args = buildCodexExecArgs({
    repoRoot,
    outputPath,
    imagePaths,
    model,
    reasoningEffort,
    contextWindow,
    autoCompactTokenLimit,
  });
  const child = spawnRuntimeCommand(codexBinPath, args, {
    cwd: repoRoot,
    detached: platform !== "win32",
    env: buildCodexChildEnv(),
    platform,
    stdio: ["pipe", "pipe", "pipe"],
    spawnImpl: spawnProcess,
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
