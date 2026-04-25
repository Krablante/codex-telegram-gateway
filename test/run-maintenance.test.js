import test from "node:test";
import assert from "node:assert/strict";

import { performRunOnceMaintenance } from "../src/cli/run-maintenance.js";

test("performRunOnceMaintenance runs queue scan, retention sweep, and fragment flushes in order", async () => {
  const calls = [];

  const completedAt = await performRunOnceMaintenance({
    promptFragmentAssembler: {
      async flushAll() {
        calls.push("prompt-flush");
      },
    },
    queuePromptAssembler: {
      async flushAll() {
        calls.push("queue-flush");
      },
    },
    runtimeObserver: {
      async noteRetentionSweep(value) {
        calls.push(`retention:${value}`);
      },
    },
    async scanPendingSpikeQueue() {
      calls.push("queue");
    },
    sessionLifecycleManager: {
      async sweepExpiredParkedSessions() {
        calls.push("sweep");
      },
    },
  });

  assert.equal(Number.isFinite(completedAt), true);
  assert.deepEqual(calls.slice(0, 2), ["queue", "sweep"]);
  assert.match(calls[2], /^retention:/u);
  assert.deepEqual(calls.slice(3), ["prompt-flush", "queue-flush"]);
});
