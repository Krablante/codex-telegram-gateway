import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildEmptyRolloutCoordinationState,
  normalizeRolloutCoordinationState,
  RolloutCoordinationStore,
} from "../src/session-manager/rollout-coordination-store.js";

test("normalizeRolloutCoordinationState trims strings and de-duplicates retained sessions", () => {
  assert.deepEqual(
    normalizeRolloutCoordinationState({
      status: "IN_PROGRESS",
      current_generation_id: " gen-current ",
      target_generation_id: " gen-target ",
      retiring_generation_id: " gen-old ",
      requested_by: " admin ",
      retained_session_keys: ["-100:2", " -100:1 ", "-100:2", ""],
    }),
    {
      ...buildEmptyRolloutCoordinationState(),
      status: "in_progress",
      current_generation_id: "gen-current",
      target_generation_id: "gen-target",
      retiring_generation_id: "gen-old",
      requested_by: "admin",
      retained_session_keys: ["-100:1", "-100:2"],
    },
  );
});

test("RolloutCoordinationStore persists requested and active rollout state under settings", async () => {
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-settings-"),
  );
  const store = new RolloutCoordinationStore(settingsRoot);

  const requested = await store.requestRollout({
    currentGenerationId: " gen-old ",
    targetGenerationId: " gen-new ",
    requestedBy: " admin ",
  });
  assert.equal(requested.status, "requested");
  assert.equal(requested.current_generation_id, "gen-old");
  assert.equal(requested.target_generation_id, "gen-new");
  assert.equal(requested.requested_by, "admin");
  assert.ok(requested.requested_at);

  const active = await store.startRollout({
    currentGenerationId: "gen-new",
    targetGenerationId: "gen-new",
    retiringGenerationId: "gen-old",
    retainedSessionKeys: ["-1001234567890:2203", "-1001234567890:2203", " -1001234567890:2204 "],
  });
  assert.equal(active.status, "in_progress");
  assert.equal(active.retiring_generation_id, "gen-old");
  assert.deepEqual(active.retained_session_keys, [
    "-1001234567890:2203",
    "-1001234567890:2204",
  ]);
  assert.ok(active.started_at);

  const reloaded = await store.load({ force: true });
  assert.equal(reloaded.status, "in_progress");
  assert.equal(reloaded.retiring_generation_id, "gen-old");
  await fs.access(store.getFilePath());
});

test("RolloutCoordinationStore quarantines malformed files and falls back to empty state", async () => {
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-settings-"),
  );
  const store = new RolloutCoordinationStore(settingsRoot);

  await fs.mkdir(settingsRoot, { recursive: true });
  await fs.writeFile(store.getFilePath(), "{", "utf8");

  const loaded = await store.load({ force: true });
  assert.deepEqual(loaded, buildEmptyRolloutCoordinationState());

  const entries = await fs.readdir(settingsRoot);
  assert.equal(entries.includes("rollout-coordination.json"), false);
  assert.equal(
    entries.some((entry) => entry.startsWith("rollout-coordination.json.corrupt-")),
    true,
  );
});
