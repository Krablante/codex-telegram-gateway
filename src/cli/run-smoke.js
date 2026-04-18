#!/usr/bin/env node

import process from "node:process";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { assertSmokeSupported, resolveSmokeVariant } from "./run-smoke-common.js";

const execFileAsync = promisify(execFile);

async function main() {
  const isOmni = resolveVariant() === "omni";
  const serviceName = isOmni
    ? "codex-telegram-gateway-omni.service"
    : "codex-telegram-gateway.service";
  await assertSmokeSupported(serviceName, { execFileAsync });

  const scriptPath = fileURLToPath(
    new URL(isOmni ? "./run-omni.js" : "./run.js", import.meta.url),
  );
  const child = spawn(process.execPath, [scriptPath], {
    stdio: "inherit",
    env: {
      ...process.env,
      RUN_ONCE: "1",
      TELEGRAM_POLL_TIMEOUT_SECS: "1",
      ...(isOmni ? { OMNI_SKIP_PENDING_SCAN: "1" } : {}),
    },
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`smoke run exited via signal ${signal}`));
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
