import test from "node:test";
import assert from "node:assert/strict";

import { schedulePendingSteerFlush } from "../src/pty-worker/codex-runner-steer.js";
import { waitForCondition } from "../test-support/codex-runner-fixtures.js";

test("schedulePendingSteerFlush reports async flush failures as warnings", async () => {
  const warnings = [];
  const context = {
    state: {
      activeTurnId: "turn-1",
      flushChain: Promise.resolve(),
      latestThreadId: "thread-1",
      pendingSteerInputs: [{ type: "text", text: "follow-up" }],
      rpc: {
        async request() {
          throw new Error("transport closed");
        },
      },
      warnings,
    },
    onWarning(line) {
      warnings.push(`callback:${line}`);
    },
    steerActiveTurnRefreshRetryDelaysMs: [],
    steerRequestTimeoutMs: 10,
  };

  schedulePendingSteerFlush(context);
  await waitForCondition(() => warnings.length === 2);

  assert.match(warnings[0], /pending steer flush failed: transport closed/u);
  assert.match(warnings[1], /callback:pending steer flush failed: transport closed/u);
  assert.deepEqual(context.state.pendingSteerInputs, [
    { type: "text", text: "follow-up" },
  ]);
});
