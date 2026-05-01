import test from "node:test";
import assert from "node:assert/strict";

import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import { runCodexExecTask } from "../src/codex-exec/telegram-exec-runner.js";

const LIVE_ENABLED = process.env.CODEX_LIVE_TESTS === "1";
const LIVE_TIMEOUT_MS = Number.parseInt(
  process.env.CODEX_EXEC_LIVE_TIMEOUT_MS || "120000",
  10,
);

function withTimeout(promise, timeoutMs, onTimeout = null) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

test("live codex exec JSONL smoke returns a thread id and final answer", {
  skip: LIVE_ENABLED ? false : "set CODEX_LIVE_TESTS=1 to run live Codex exec smoke",
  timeout: LIVE_TIMEOUT_MS + 5000,
}, async () => {
  const config = await loadRuntimeConfig();
  let finalAnswer = "";
  const warnings = [];
  const run = runCodexExecTask({
    codexBinPath: process.env.CODEX_BIN_PATH || config.codexBinPath || "codex",
    cwd: config.workspaceRoot || process.cwd(),
    prompt: "Reply with exactly EXEC_JSON_SMOKE_OK and nothing else.",
    onEvent(summary) {
      if (
        summary?.kind === "agent_message"
        && summary.messagePhase === "final_answer"
      ) {
        finalAnswer = summary.text || "";
      }
    },
    onWarning(warning) {
      warnings.push(String(warning || ""));
    },
  });

  const result = await withTimeout(run.finished, LIVE_TIMEOUT_MS, () => {
    void run.interrupt().catch(() => null);
  });
  assert.equal(result.ok, true, warnings.join("\n"));
  assert.ok(result.threadId, "codex exec should emit thread.started first");
  assert.match(finalAnswer, /EXEC_JSON_SMOKE_OK/u);
});
