import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RuntimeObserver } from "../src/runtime/runtime-observer.js";

test("RuntimeObserver survives concurrent heartbeat writes in the same millisecond", async () => {
  const logsDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-logs-concurrent-"),
  );
  const observer = new RuntimeObserver({
    logsDir,
    config: {
      envFilePath: "/state/runtime.env",
      repoRoot: "/repo",
      stateRoot: "/state",
      telegramForumChatId: "-1001234567890",
    },
    serviceState: {
      startedAt: "2026-03-22T12:00:00.000Z",
      botId: "1",
      botUsername: "gatewaybot",
      handledUpdates: 0,
      ignoredUpdates: 0,
      handledCommands: 0,
      acceptedPrompts: 0,
      pollErrors: 0,
      knownSessions: 0,
      activeRunCount: 0,
      generationId: "gen-runtime",
      isLeader: true,
      retiring: false,
      rolloutStatus: "idle",
      lastUpdateId: null,
      lastCommandName: null,
      lastCommandAt: null,
      lastPromptAt: null,
      bootstrapDroppedUpdateId: null,
    },
    probe: {
      me: {
        first_name: "SEVERUS",
      },
    },
    mode: "poller",
  });

  const originalNow = Date.now;
  Date.now = () => 1_748_800_000_000;

  try {
    observer.currentOffset = 111;
    observer.lastRetentionSweepAt = "2026-03-22T12:05:00.000Z";
    observer.lastErrorMessage = "transient";

    await Promise.all([
      observer.writeHeartbeat(),
      observer.writeHeartbeat(),
      observer.writeHeartbeat(),
    ]);
  } finally {
    Date.now = originalNow;
  }

  const heartbeat = JSON.parse(
    await fs.readFile(path.join(logsDir, "runtime-heartbeat.json"), "utf8"),
  );
  assert.equal(heartbeat.polling.current_offset, 111);
  assert.equal(
    heartbeat.polling.last_retention_sweep_at,
    "2026-03-22T12:05:00.000Z",
  );
  assert.equal(heartbeat.last_error_message, "transient");
});
