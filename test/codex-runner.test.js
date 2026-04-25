import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { runCodexTask } from "../src/pty-worker/codex-runner.js";

test("runCodexTask initializes completion handlers before early child lifecycle failures", async () => {
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
  await assert.rejects(
    run.finished,
    /Codex app-server ended before startup/u,
  );
});

test("runCodexTask disables detached app-server launches on Windows", () => {
  let spawnOptions = null;

  assert.throws(
    () =>
      runCodexTask({
        codexBinPath: "codex.cmd",
        cwd: process.cwd(),
        prompt: "Проверка Windows app-server spawn.",
        platform: "win32",
        spawnImpl(_command, _args, options) {
          spawnOptions = options;
          throw new Error("spawn blocked");
        },
      }),
    /spawn blocked/u,
  );

  assert.equal(spawnOptions?.detached, false);
});
