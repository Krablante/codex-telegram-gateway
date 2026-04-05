import test from "node:test";
import assert from "node:assert/strict";

import {
  collectOwnedSessionKeys,
  markOwnedSessionsRetiring,
  spawnReplacementGeneration,
  waitForGenerationReady,
} from "../src/runtime/service-rollout.js";

test("collectOwnedSessionKeys merges active and starting runs without duplicates", () => {
  const owned = collectOwnedSessionKeys({
    activeRuns: new Map([
      ["-100:2", { session: { session_key: "-100:2" } }],
      ["-100:1", { session: { session_key: "-100:1" } }],
    ]),
    startingRuns: new Set(["-100:2", "-100:3"]),
  });

  assert.deepEqual(owned, ["-100:1", "-100:2", "-100:3"]);
});

test("markOwnedSessionsRetiring updates active run ownership in session storage", async () => {
  const run = {
    session: {
      session_key: "-100:2203",
      chat_id: "-100",
      topic_id: "2203",
    },
  };
  const claims = [];
  const updated = await markOwnedSessionsRetiring({
    workerPool: {
      activeRuns: new Map([["-100:2203", run]]),
    },
    sessionStore: {
      async load() {
        return run.session;
      },
      async claimSessionOwner(session, ownership) {
        claims.push({ session, ownership });
        return {
          ...session,
          session_owner_generation_id: ownership.generationId,
          session_owner_mode: ownership.mode,
        };
      },
    },
    generationId: "gen-old",
  });

  assert.equal(claims.length, 1);
  assert.equal(updated[0].session_owner_generation_id, "gen-old");
  assert.equal(run.session.session_owner_mode, "retiring");
});

test("waitForGenerationReady returns once a live generation exposes IPC", async () => {
  let calls = 0;
  const record = await waitForGenerationReady({
    generationId: "gen-next",
    pollIntervalMs: 1,
    timeoutMs: 50,
    generationStore: {
      async loadGeneration() {
        calls += 1;
        if (calls < 2) {
          return null;
        }
        return {
          generation_id: "gen-next",
          ipc_endpoint: "http://127.0.0.1:39001/ipc/forward-spike/token",
        };
      },
      isGenerationRecordLive(value) {
        return Boolean(value?.generation_id);
      },
    },
  });

  assert.equal(record.generation_id, "gen-next");
});

test("spawnReplacementGeneration preserves the runtime env and injects rollout ids", () => {
  const launches = [];
  spawnReplacementGeneration({
    config: {
      repoRoot: "/repo",
      envFilePath: "/state/runtime.env",
    },
    generationId: "gen-next",
    parentGenerationId: "gen-old",
    scriptPath: "/repo/src/cli/run.js",
    execPath: "/usr/bin/node",
    execArgv: ["--trace-warnings"],
    env: {
      BASE: "1",
    },
    spawnCommand(command, args, options) {
      launches.push({ command, args, options });
      return { unref() {} };
    },
  });

  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, "/usr/bin/node");
  assert.deepEqual(launches[0].args, ["--trace-warnings", "/repo/src/cli/run.js"]);
  assert.equal(launches[0].options.cwd, "/repo");
  assert.equal(launches[0].options.env.ENV_FILE, "/state/runtime.env");
  assert.equal(launches[0].options.env.SERVICE_GENERATION_ID, "gen-next");
  assert.equal(
    launches[0].options.env.SERVICE_ROLLOUT_PARENT_GENERATION_ID,
    "gen-old",
  );
});
