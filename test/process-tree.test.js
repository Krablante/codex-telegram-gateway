import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWindowsTaskkillArgs,
  signalChildProcessTree,
} from "../src/runtime/process-tree.js";

test("buildWindowsTaskkillArgs renders the expected taskkill argv", () => {
  assert.deepEqual(buildWindowsTaskkillArgs(4821), ["/pid", "4821", "/t"]);
  assert.deepEqual(buildWindowsTaskkillArgs(4821, { force: true }), [
    "/pid",
    "4821",
    "/t",
    "/f",
  ]);
  assert.equal(buildWindowsTaskkillArgs(0), null);
});

test("signalChildProcessTree uses taskkill on Windows before falling back", () => {
  const spawned = [];
  const childSignals = [];
  const result = signalChildProcessTree(
    {
      pid: 4821,
      kill(signal) {
        childSignals.push(signal);
      },
    },
    "SIGKILL",
    {
      platform: "win32",
      processImpl: {
        kill() {
          throw new Error("should not reach process.kill fallback");
        },
      },
      spawnImpl(command, args, options) {
        spawned.push({ command, args, options });
        return {
          on() {},
          unref() {},
        };
      },
    },
  );

  assert.equal(result, true);
  assert.deepEqual(childSignals, []);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "taskkill");
  assert.deepEqual(spawned[0].args, ["/pid", "4821", "/t", "/f"]);
  assert.equal(spawned[0].options.windowsHide, true);
});

test("signalChildProcessTree maps Windows soft signals to non-forced taskkill", () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const spawned = [];
    const result = signalChildProcessTree(
      {
        pid: 4821,
        kill() {
          throw new Error("child.kill fallback should not be used");
        },
      },
      signal,
      {
        platform: "win32",
        processImpl: {
          kill() {
            throw new Error("process.kill fallback should not be used");
          },
        },
        spawnImpl(command, args, options) {
          spawned.push({ command, args, options });
          return {
            on() {},
            unref() {},
          };
        },
      },
    );

    assert.equal(result, true);
    assert.equal(spawned[0].command, "taskkill");
    assert.deepEqual(spawned[0].args, ["/pid", "4821", "/t"]);
  }
});
