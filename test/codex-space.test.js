import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { renderCodexSpace } from "../src/hosts/codex-space.js";
import {
  PRIVATE_DIRECTORY_MODE,
  supportsPosixFileModes,
} from "../src/state/file-utils.js";

async function getMode(filePath) {
  return (await fs.stat(filePath)).mode & 0o777;
}

test("renderCodexSpace writes shared and per-host rendered outputs", async () => {
  const codexSpaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-codex-space-"),
  );
  const result = await renderCodexSpace({
    codexSpaceRoot,
    currentHostId: "controller",
    hosts: [
      {
        host_id: "controller",
        label: "controller",
        role: "controller",
        enabled: true,
        worker_runtime_root: "~/.local/state/codex-telegram-gateway",
        workspace_root: "~/workspace",
        repo_root: "~/workspace/codex-telegram-gateway",
        profile_id: "controller-profile",
        suffix_id: "controller",
        last_health: "ready",
        last_health_checked_at: "2026-04-21T18:00:00.000Z",
        last_ready_at: "2026-04-21T18:00:00.000Z",
        failure_reason: null,
      },
      {
        host_id: "worker-a",
        label: "worker-a",
        role: "worker-profile",
        enabled: true,
        worker_runtime_root: "~/.local/state/codex-telegram-gateway",
        workspace_root: "~/workspace",
        repo_root: "~/workspace/codex-telegram-gateway",
        profile_id: "worker-profile",
        suffix_id: "worker-a",
        last_health: "not-ready",
        last_health_checked_at: "2026-04-21T18:10:00.000Z",
        last_ready_at: null,
        failure_reason: "codex-auth",
      },
    ],
  });

  assert.deepEqual(
    result.files
      .map((filePath) => path.relative(codexSpaceRoot, filePath).replace(/\\/gu, "/"))
      .sort(),
    [
      "hosts/controller/rendered/health.json",
      "hosts/controller/rendered/profile.json",
      "hosts/controller/rendered/prompt-snippet.txt",
      "hosts/worker-a/rendered/health.json",
      "hosts/worker-a/rendered/profile.json",
      "hosts/worker-a/rendered/prompt-snippet.txt",
      "shared/rendered/fleet-map.json",
      "shared/rendered/fleet-reminder.txt",
      "shared/rendered/manifest.json",
      "shared/rendered/operator-reminder.txt",
    ],
  );

  const fleetReminder = await fs.readFile(
    path.join(codexSpaceRoot, "shared", "rendered", "fleet-reminder.txt"),
    "utf8",
  );
  const operatorReminder = await fs.readFile(
    path.join(codexSpaceRoot, "shared", "rendered", "operator-reminder.txt"),
    "utf8",
  );
  const serProfile = JSON.parse(
    await fs.readFile(
      path.join(codexSpaceRoot, "hosts", "worker-a", "rendered", "profile.json"),
      "utf8",
    ),
  );

  assert.match(fleetReminder, /Current controller host: controller/u);
  assert.match(operatorReminder, /Avoid overengineering\./u);
  assert.equal(serProfile.host_id, "worker-a");

  if (supportsPosixFileModes()) {
    assert.equal(await getMode(codexSpaceRoot), PRIVATE_DIRECTORY_MODE);
    assert.equal(
      await getMode(path.join(codexSpaceRoot, "hosts", "worker-a", "rendered")),
      PRIVATE_DIRECTORY_MODE,
    );
  }
});
