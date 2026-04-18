#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

async function main() {
  const child = spawn(
    process.execPath,
    ["--test", "test/worker-pool.live.test.js"],
    {
      stdio: "inherit",
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
