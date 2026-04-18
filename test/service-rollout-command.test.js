import test from "node:test";
import assert from "node:assert/strict";

import {
  loadLiveLeaderGeneration,
  performServiceRollout,
  signalGenerationRollout,
  waitForLiveLeaderGeneration,
  waitForRolloutTrafficShift,
} from "../src/runtime/service-rollout-command.js";

test("loadLiveLeaderGeneration returns the live leader and generation record", async () => {
  const result = await loadLiveLeaderGeneration({
    generationStore: {
      async loadLeaderLease() {
        return { generation_id: "gen-a", pid: 1234 };
      },
      isLeaderLeaseLive(lease) {
        return lease.generation_id === "gen-a";
      },
      async loadGeneration(generationId) {
        return {
          generation_id: generationId,
          ipc_endpoint: "http://127.0.0.1:39001/ipc/forward-spike/token",
        };
      },
      isGenerationRecordLive(record) {
        return Boolean(record?.generation_id);
      },
    },
  });

  assert.equal(result.lease.generation_id, "gen-a");
  assert.equal(result.generation.generation_id, "gen-a");
});

test("signalGenerationRollout targets the leader pid with SIGUSR2", () => {
  const signals = [];
  signalGenerationRollout(
    {
      lease: {
        pid: 4821,
      },
    },
    {
      processImpl: {
        kill(pid, signal) {
          signals.push({ pid, signal });
        },
      },
    },
  );

  assert.deepEqual(signals, [{ pid: 4821, signal: "SIGUSR2" }]);
});

test("waitForLiveLeaderGeneration waits until the expected leader appears", async () => {
  let calls = 0;
  const leader = await waitForLiveLeaderGeneration({
    timeoutMs: 250,
    pollIntervalMs: 5,
    generationStore: {
      async loadLeaderLease() {
        calls += 1;
        if (calls < 3) {
          return null;
        }
        return { generation_id: "gen-b", pid: 222 };
      },
      isLeaderLeaseLive(lease) {
        return Boolean(lease?.generation_id);
      },
      async loadGeneration(generationId) {
        return {
          generation_id: generationId,
          ipc_endpoint: "http://127.0.0.1:39002/ipc/forward-spike/token",
        };
      },
      isGenerationRecordLive(record) {
        return Boolean(record?.generation_id);
      },
    },
  });

  assert.equal(leader.lease.generation_id, "gen-b");
});

test("waitForRolloutTrafficShift returns once the replacement generation becomes leader", async () => {
  let stateCalls = 0;
  const shifted = await waitForRolloutTrafficShift({
    previousGenerationId: "gen-old",
    timeoutMs: 50,
    pollIntervalMs: 1,
    rolloutCoordinationStore: {
      async load() {
        stateCalls += 1;
        if (stateCalls < 2) {
          return {
            status: "requested",
            target_generation_id: null,
          };
        }
        return {
          status: "in_progress",
          target_generation_id: "gen-new",
        };
      },
    },
    generationStore: {
      async loadLeaderLease() {
        return { generation_id: "gen-new", pid: 333 };
      },
      isLeaderLeaseLive(lease) {
        return Boolean(lease?.generation_id);
      },
      async loadGeneration(generationId) {
        return {
          generation_id: generationId,
          ipc_endpoint: "http://127.0.0.1:39003/ipc/forward-spike/token",
        };
      },
      isGenerationRecordLive(record) {
        return Boolean(record?.generation_id);
      },
    },
  });

  assert.equal(shifted.targetGenerationId, "gen-new");
  assert.equal(shifted.leader.lease.pid, 333);
});

test("performServiceRollout falls back to restart when no live leader exists", async () => {
  const calls = [];
  const result = await performServiceRollout({
    generationStore: {},
    rolloutCoordinationStore: {
      async clear() {
        calls.push("clear");
      },
    },
    restartService: async () => {
      calls.push("restart");
    },
    loadLeaderGeneration: async () => null,
    waitForLeaderGeneration: async () => ({
      lease: {
        generation_id: "gen-restarted",
        pid: 991,
      },
    }),
  });

  assert.deepEqual(calls, ["clear", "restart"]);
  assert.deepEqual(result, {
    mode: "restart-fallback",
    leaderGenerationId: "gen-restarted",
    leaderPid: 991,
  });
});

test("performServiceRollout requests and waits for a replacement leader when one is live", async () => {
  const calls = [];
  const result = await performServiceRollout({
    generationStore: {},
    rolloutCoordinationStore: {
      async load() {
        calls.push("load");
        return {
          status: "idle",
          target_generation_id: null,
        };
      },
      async requestRollout(payload) {
        calls.push(["request", payload]);
      },
    },
    restartService: async () => {
      calls.push("restart");
    },
    loadLeaderGeneration: async () => ({
      lease: {
        generation_id: "gen-old",
        pid: 111,
      },
    }),
    signalRollout(generation) {
      calls.push(["signal", generation.lease.generation_id]);
    },
    waitForTrafficShift: async () => ({
      state: {
        status: "in_progress",
      },
      targetGenerationId: "gen-new",
      leader: {
        lease: {
          pid: 222,
        },
      },
    }),
  });

  assert.deepEqual(calls, [
    "load",
    [
      "request",
      {
        currentGenerationId: "gen-old",
        requestedBy: "service-rollout",
      },
    ],
    ["signal", "gen-old"],
  ]);
  assert.deepEqual(result, {
    mode: "soft-rollout",
    previousGenerationId: "gen-old",
    leaderGenerationId: "gen-new",
    leaderPid: 222,
    rolloutStatus: "in_progress",
  });
});

test("performServiceRollout can chain a fresh rollout after traffic already shifted", async () => {
  const calls = [];
  const result = await performServiceRollout({
    generationStore: {},
    rolloutCoordinationStore: {
      async load() {
        calls.push("load");
        return {
          status: "in_progress",
          target_generation_id: "gen-current",
        };
      },
      async requestRollout(payload) {
        calls.push(["request", payload]);
      },
    },
    restartService: async () => {
      throw new Error("should not restart");
    },
    loadLeaderGeneration: async () => ({
      lease: {
        generation_id: "gen-current",
        pid: 333,
      },
    }),
    signalRollout(generation) {
      calls.push(["signal", generation.lease.generation_id]);
    },
    waitForTrafficShift: async () => ({
      state: {
        status: "in_progress",
      },
      targetGenerationId: "gen-next",
      leader: {
        lease: {
          pid: 444,
        },
      },
    }),
  });

  assert.deepEqual(calls, [
    "load",
    [
      "request",
      {
        currentGenerationId: "gen-current",
        requestedBy: "service-rollout",
      },
    ],
    ["signal", "gen-current"],
  ]);
  assert.deepEqual(result, {
    mode: "soft-rollout",
    previousGenerationId: "gen-current",
    leaderGenerationId: "gen-next",
    leaderPid: 444,
    rolloutStatus: "in_progress",
  });
});
