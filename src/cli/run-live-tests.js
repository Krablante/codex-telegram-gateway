#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIVE_TEST_PATH = path.join(REPO_ROOT, "test", "worker-pool.live.test.js");

async function main() {
  const child = spawn(
    process.execPath,
    ["--test", LIVE_TEST_PATH],
    {
      stdio: "inherit",
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CODEX_LIVE_TESTS: "1",
      },
    },
  );

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`live tests exited via signal ${signal}`));
        return;
      }

      resolve(code ?? 1);
    });
  });

  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
