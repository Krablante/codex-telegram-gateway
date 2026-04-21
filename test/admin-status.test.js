import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveCodexBinPathForStatus,
  summarizeHeartbeat,
} from "../src/cli/admin.js";

test("summarizeHeartbeat marks stale running heartbeats as stale", () => {
  const summary = summarizeHeartbeat(
    {
      observed_at: "2000-01-01T00:00:00.000Z",
      lifecycle_state: "running",
      pid: process.pid,
      service_state: {
        active_run_count: 2,
        last_update_id: 123,
      },
    },
    {
      nowMs: Date.parse("2000-01-01T00:10:00.000Z"),
      pollTimeoutSecs: 30,
    },
  );

  assert.equal(summary.lifecycleState, "stale");
  assert.equal(summary.fresh, false);
  assert.equal(summary.stale, true);
  assert.equal(summary.activeRunCount, 2);
  assert.equal(summary.lastUpdateId, 123);
});

test("resolveCodexBinPathForStatus resolves PATH-visible executables for operator status", () => {
  const resolved = resolveCodexBinPathForStatus({
    codexBinPath: "node",
    repoRoot: process.cwd(),
  });

  assert.notEqual(resolved, "node");
  assert.match(resolved, /node/u);
});
