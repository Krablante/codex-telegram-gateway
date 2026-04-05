import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  buildEmergencyExecArgs,
  startEmergencyExecRun,
} from "../src/emergency/exec-runner.js";

test("buildEmergencyExecArgs builds codex exec fallback args", () => {
  assert.deepEqual(
    buildEmergencyExecArgs({
      repoRoot: "/repo",
      outputPath: "/state/emergency/runs/out.txt",
      imagePaths: ["/tmp/a.png", "/tmp/b.jpg"],
    }),
    [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      "/repo",
      "--json",
      "-o",
      "/state/emergency/runs/out.txt",
      "-i",
      "/tmp/a.png",
      "-i",
      "/tmp/b.jpg",
      "-",
    ],
  );
});

test("startEmergencyExecRun creates the output directory before spawning codex", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "emergency-exec-runner-"),
  );
  const expectedRunsDir = path.join(tempRoot, "emergency", "runs");
  let sawRunsDir = false;

  assert.throws(
    () =>
      startEmergencyExecRun({
        codexBinPath: "codex",
        repoRoot: "/repo",
        stateRoot: tempRoot,
        prompt: "repair it",
        spawnProcess() {
          sawRunsDir = fs.existsSync(expectedRunsDir);
          throw new Error("spawn blocked");
        },
      }),
    /spawn blocked/u,
  );

  assert.equal(sawRunsDir, true);
});

test("startEmergencyExecRun launches codex exec in a detached process group", () => {
  let spawnOptions = null;

  assert.throws(
    () =>
      startEmergencyExecRun({
        codexBinPath: "codex",
        repoRoot: "/repo",
        stateRoot: "/tmp/state-root",
        prompt: "repair it",
        platform: "linux",
        spawnProcess(_bin, _args, options) {
          spawnOptions = options;
          throw new Error("spawn blocked");
        },
      }),
    /spawn blocked/u,
  );

  assert.equal(spawnOptions?.detached, true);
});

test("startEmergencyExecRun disables detached mode on Windows", () => {
  let spawnOptions = null;

  assert.throws(
    () =>
      startEmergencyExecRun({
        codexBinPath: "codex.cmd",
        repoRoot: "/repo",
        stateRoot: "/tmp/state-root",
        prompt: "repair it",
        platform: "win32",
        spawnProcess(_bin, _args, options) {
          spawnOptions = options;
          throw new Error("spawn blocked");
        },
      }),
    /spawn blocked/u,
  );

  assert.equal(spawnOptions?.detached, false);
});

test("startEmergencyExecRun treats shell interrupt exit codes as interrupted", async () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "emergency-exec-runner-interrupt-"),
  );
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();

  const run = startEmergencyExecRun({
    codexBinPath: "codex",
    repoRoot: "/repo",
    stateRoot: tempRoot,
    prompt: "repair it",
    spawnProcess() {
      setImmediate(() => {
        child.emit("close", 143, null);
      });
      return child;
    },
  });

  const result = await run.done;
  assert.equal(result.ok, false);
  assert.equal(result.interrupted, true);
  assert.equal(result.exitCode, 143);
  assert.equal(result.signal, null);
});
