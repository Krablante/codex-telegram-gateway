import test from "node:test";
import assert from "node:assert/strict";

import { buildLiveNodeTestArgs } from "../src/cli/run-live-tests.js";

test("buildLiveNodeTestArgs passes node test flags before files and defaults to sequential live runs", () => {
  const args = buildLiveNodeTestArgs({
    suite: "exec-json",
    nodeTestArgs: ["--test-name-pattern", "smoke"],
  });

  assert.deepEqual(args.slice(0, 4), [
    "--test",
    "--test-concurrency=1",
    "--test-name-pattern",
    "smoke",
  ]);
  assert.match(args.at(-1), /worker-pool\.exec-json\.live\.test\.js/u);
});

test("buildLiveNodeTestArgs preserves explicit test concurrency", () => {
  const args = buildLiveNodeTestArgs({
    suite: "app-server",
    nodeTestArgs: ["--test-concurrency=2"],
  });

  assert.deepEqual(args.slice(0, 2), ["--test", "--test-concurrency=2"]);
  assert.match(args.at(-1), /worker-pool\.live\.test\.js/u);
});
