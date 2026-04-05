import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { runCodexTask } from "../src/pty-worker/codex-runner.js";

test("runCodexTask initializes completion handlers before child lifecycle starts", async () => {
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Проверка раннего старта.",
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      child.pid = null;

      setImmediate(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });

      return child;
    },
  });

  assert.equal(typeof run.steer, "function");
  const finished = await run.finished;
  assert.equal(finished.exitCode, 0);
});
