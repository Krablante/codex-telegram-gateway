import test from "node:test";
import assert from "node:assert/strict";

import { createRolloutController } from "../src/cli/run-rollout-controller.js";

test("requestRollout keeps a pending request until leadership is available", async () => {
  const calls = [];
  const pollAbortController = {
    aborted: false,
    abort() {
      this.aborted = true;
    },
  };
  const replacement = {
    killed: false,
    unrefCalled: false,
    unref() {
      this.unrefCalled = true;
    },
    kill(signal) {
      this.killed = true;
      this.signal = signal;
    },
  };
  const serviceState = {
    generationId: "gen-current",
    isLeader: false,
    retiring: false,
    rolloutStatus: "idle",
  };
  const controller = createRolloutController({
    config: {},
    collectOwnedSessionKeysImpl() {
      calls.push("collect-owned");
      return ["-1003577434463:2203"];
    },
    createGenerationId() {
      return "gen-next";
    },
    generationStore: {
      async releaseLeadership() {
        calls.push("release-leadership");
      },
    },
    markOwnedSessionsRetiringImpl: async () => {
      calls.push("mark-retiring");
    },
    rolloutCoordinationStore: {
      async requestRollout(payload) {
        calls.push(["request", payload]);
      },
      async startRollout(payload) {
        calls.push(["start", payload]);
      },
      async failRollout() {
        throw new Error("should not fail");
      },
    },
    serviceState,
    sessionStore: {},
    spawnReplacementGenerationImpl() {
      calls.push("spawn");
      return replacement;
    },
    waitForGenerationReadyImpl: async () => {
      calls.push("wait-ready");
      return { generation_id: "gen-next" };
    },
    workerPool: {},
    scriptPath: "/tmp/run.js",
    getPollAbortController: () => pollAbortController,
    isStopRequested: () => false,
  });

  controller.requestRollout();
  assert.equal(controller.hasPendingRequest(), true);
  assert.deepEqual(calls, []);

  serviceState.isLeader = true;
  await controller.maybeStartRollout();

  assert.equal(controller.hasPendingRequest(), false);
  assert.equal(serviceState.retiring, true);
  assert.equal(serviceState.isLeader, false);
  assert.equal(serviceState.rolloutStatus, "in_progress");
  assert.equal(replacement.unrefCalled, true);
  assert.equal(replacement.killed, false);
  assert.equal(pollAbortController.aborted, true);
  assert.deepEqual(calls, [
    "collect-owned",
    ["request", {
      currentGenerationId: "gen-current",
      targetGenerationId: "gen-next",
      requestedBy: "signal:SIGUSR2",
    }],
    "spawn",
    "wait-ready",
    "mark-retiring",
    ["start", {
      currentGenerationId: "gen-next",
      targetGenerationId: "gen-next",
      retiringGenerationId: "gen-current",
      retainedSessionKeys: ["-1003577434463:2203"],
    }],
    "release-leadership",
  ]);
});

test("reconcileRolloutState completes handoff when the retiring generation is gone", async () => {
  const serviceState = {
    generationId: "gen-new",
    rolloutStatus: "idle",
    isLeader: true,
    retiring: false,
  };
  const controller = createRolloutController({
    config: {},
    createGenerationId() {
      return "unused";
    },
    generationStore: {
      async loadGeneration(generationId) {
        assert.equal(generationId, "gen-old");
        return { generation_id: "gen-old" };
      },
      async isGenerationRecordVerifiablyLive() {
        return false;
      },
    },
    rolloutCoordinationStore: {
      async load() {
        return {
          status: "in_progress",
          target_generation_id: "gen-new",
          retiring_generation_id: "gen-old",
        };
      },
      async completeRollout(payload) {
        assert.deepEqual(payload, {
          currentGenerationId: "gen-new",
        });
        return { status: "completed" };
      },
    },
    serviceState,
    sessionStore: {},
    workerPool: {},
    scriptPath: "/tmp/run.js",
    getPollAbortController: () => null,
    isStopRequested: () => false,
  });

  const result = await controller.reconcileRolloutState();

  assert.deepEqual(result, { status: "completed" });
  assert.equal(serviceState.rolloutStatus, "completed");
});
