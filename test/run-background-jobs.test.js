import test from "node:test";
import assert from "node:assert/strict";

import { createBackgroundJobs } from "../src/cli/run-background-jobs.js";

test("createBackgroundJobs registers unref'd timers and keeps scans leader-gated", async () => {
  const intervals = [];
  const cleared = [];
  const calls = [];
  const serviceState = {
    generationId: "gen-current",
    isLeader: false,
    retiring: false,
  };

  const jobs = createBackgroundJobs({
    api: {},
    botUsername: "gatewaybot",
    clearIntervalImpl(timer) {
      cleared.push(timer.ms);
    },
    config: {
      omniEnabled: true,
      retentionSweepIntervalSecs: 60,
    },
    drainPendingOmniPromptsImpl: async () => {
      calls.push("omni");
    },
    generationStore: {
      async heartbeat() {},
      async renewLeadership() {
        return true;
      },
    },
    getForwardingEndpoint: () => "http://127.0.0.1:39111/ipc/forward-spike/token",
    getPollAbortController: () => null,
    isStopRequested: () => false,
    promptHandoffStore: {},
    promptFragmentAssembler: {},
    reconcileRolloutState: async () => {},
    runtimeObserver: {
      async noteRetentionSweep() {},
      async writeHeartbeat() {},
    },
    setIntervalImpl(fn, ms) {
      const timer = {
        fn,
        ms,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        },
      };
      intervals.push(timer);
      return timer;
    },
    serviceState,
    sessionLifecycleManager: {
      async sweepExpiredParkedSessions() {
        calls.push("sweep");
      },
    },
    sessionService: {
      async drainPromptQueue() {
        calls.push("queue");
      },
    },
    sessionStore: {},
    workerPool: {},
  });

  assert.deepEqual(intervals.map((timer) => timer.ms), [15000, 3000, 1000, 60000]);
  assert.equal(intervals.every((timer) => timer.unrefCalled), true);

  await jobs.scanPendingOmniPrompts();
  await jobs.scanPendingSpikeQueue();
  assert.deepEqual(calls, []);

  serviceState.isLeader = true;
  await jobs.scanPendingOmniPrompts();
  await jobs.scanPendingSpikeQueue();
  assert.deepEqual(calls, ["omni", "queue"]);

  jobs.stop();
  assert.deepEqual(cleared, [15000, 3000, 1000, 60000]);
});

test("createBackgroundJobs skips timer registration when timers are disabled", async () => {
  const intervals = [];
  const calls = [];
  const serviceState = {
    generationId: "gen-current",
    isLeader: true,
    retiring: false,
  };

  const jobs = createBackgroundJobs({
    api: {},
    botUsername: "gatewaybot",
    config: {
      omniEnabled: true,
      retentionSweepIntervalSecs: 60,
    },
    drainPendingOmniPromptsImpl: async () => {
      calls.push("omni");
    },
    generationStore: {
      async heartbeat() {},
      async renewLeadership() {
        return true;
      },
    },
    getForwardingEndpoint: () => "http://127.0.0.1:39111/ipc/forward-spike/token",
    getPollAbortController: () => null,
    isStopRequested: () => false,
    promptHandoffStore: {},
    promptFragmentAssembler: {},
    reconcileRolloutState: async () => {},
    runtimeObserver: {
      async noteRetentionSweep() {},
      async writeHeartbeat() {},
    },
    setIntervalImpl(fn, ms) {
      intervals.push({ fn, ms });
      return {
        unref() {},
      };
    },
    serviceState,
    sessionLifecycleManager: {
      async sweepExpiredParkedSessions() {
        calls.push("sweep");
      },
    },
    sessionService: {
      async drainPromptQueue() {
        calls.push("queue");
      },
    },
    sessionStore: {},
    timersEnabled: false,
    workerPool: {},
  });

  assert.deepEqual(intervals, []);

  await jobs.scanPendingOmniPrompts();
  await jobs.scanPendingSpikeQueue();
  assert.deepEqual(calls, ["omni", "queue"]);
});
