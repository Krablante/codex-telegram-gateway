import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ServiceGenerationStore } from "../src/runtime/service-generation-store.js";
import {
  PRIVATE_DIRECTORY_MODE,
  supportsPosixFileModes,
} from "../src/state/file-utils.js";

async function getMode(filePath) {
  return (await fs.stat(filePath)).mode & 0o777;
}

test("ServiceGenerationStore writes generation heartbeats and leader leases", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-generation-store-"),
  );
  const now = new Date("2026-04-05T01:00:00.000Z").getTime();
  let currentNow = now;
  const store = new ServiceGenerationStore({
    indexesRoot: path.join(root, "indexes"),
    tmpRoot: path.join(root, "tmp"),
    serviceKind: "spike",
    generationId: "gen-a",
    now: () => currentNow,
    pid: process.pid,
  });

  const heartbeat = await store.heartbeat({
    mode: "leader",
    ipcEndpoint: "http://127.0.0.1:39001/ipc/forward-spike/token",
  });
  assert.equal(heartbeat.generation_id, "gen-a");
  assert.equal(heartbeat.mode, "leader");
  assert.equal(store.isGenerationRecordLive(heartbeat), true);

  const acquired = await store.acquireLeadership();
  assert.equal(acquired, true);

  const lease = await store.loadLeaderLease();
  assert.equal(lease.generation_id, "gen-a");

  currentNow += 1000;
  const renewed = await store.renewLeadership();
  assert.equal(renewed, true);

  const released = await store.releaseLeadership();
  assert.equal(released, true);
  assert.equal(await store.loadLeaderLease(), null);

  if (supportsPosixFileModes()) {
    assert.equal(await getMode(path.join(root, "indexes")), PRIVATE_DIRECTORY_MODE);
  }
});

test("ServiceGenerationStore refuses leadership while another live generation owns the lease", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-generation-store-contend-"),
  );
  const now = new Date("2026-04-05T01:05:00.000Z").getTime();
  const shared = {
    indexesRoot: path.join(root, "indexes"),
    tmpRoot: path.join(root, "tmp"),
    serviceKind: "spike",
    now: () => now,
    pid: process.pid,
    async probeGenerationIdentity() {
      return true;
    },
  };
  const leader = new ServiceGenerationStore({
    ...shared,
    generationId: "gen-leader",
  });
  const challenger = new ServiceGenerationStore({
    ...shared,
    generationId: "gen-challenger",
  });

  await leader.heartbeat({
    mode: "leader",
    ipcEndpoint: "http://127.0.0.1:39001/ipc/forward-spike/token",
  });
  await leader.acquireLeadership();
  assert.equal(await challenger.acquireLeadership(), false);
});

test("ServiceGenerationStore verifies generation identity over loopback IPC before trusting liveness", async () => {
  const store = new ServiceGenerationStore({
    indexesRoot: "/tmp/indexes",
    tmpRoot: "/tmp/tmp",
    serviceKind: "spike",
    generationId: "gen-a",
    pid: 123,
    processAlive() {
      return true;
    },
    async probeGenerationIdentity({ generationId, instanceToken }) {
      return generationId === "gen-a" && instanceToken === "token-a";
    },
  });

  assert.equal(
    await store.isGenerationRecordVerifiablyLive({
      generation_id: "gen-a",
      instance_token: "token-a",
      pid: 123,
      ipc_endpoint: "http://127.0.0.1:39001/ipc/forward-spike/token",
      heartbeat_expires_at: new Date(Date.now() + 1000).toISOString(),
    }),
    true,
  );
  assert.equal(
    await store.isGenerationRecordVerifiablyLive({
      generation_id: "gen-a",
      instance_token: "wrong",
      pid: 123,
      ipc_endpoint: "http://127.0.0.1:39001/ipc/forward-spike/token",
      heartbeat_expires_at: new Date(Date.now() + 1000).toISOString(),
    }),
    false,
  );
});

test("ServiceGenerationStore can take over a lease that is pid-live but identity-dead", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-generation-store-takeover-"),
  );
  const shared = {
    indexesRoot: path.join(root, "indexes"),
    tmpRoot: path.join(root, "tmp"),
    serviceKind: "spike",
    now: () => Date.now(),
    pid: process.pid,
  };
  const leader = new ServiceGenerationStore({
    ...shared,
    generationId: "gen-leader",
    async probeGenerationIdentity() {
      return false;
    },
  });
  const challenger = new ServiceGenerationStore({
    ...shared,
    generationId: "gen-challenger",
    async probeGenerationIdentity({ generationId }) {
      return generationId === "gen-challenger";
    },
  });

  await leader.heartbeat({
    mode: "leader",
    ipcEndpoint: "http://127.0.0.1:39021/ipc/forward-spike/token",
  });
  await leader.acquireLeadership();

  assert.equal(await challenger.acquireLeadership(), true);
});
