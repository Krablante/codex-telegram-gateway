import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { RuntimeObserver } from "../src/runtime/runtime-observer.js";

test("RuntimeObserver writes heartbeat and lifecycle events", async () => {
  const logsDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-logs-"),
  );
  const serviceState = {
    startedAt: "2026-03-22T12:00:00.000Z",
    botId: "1",
    botUsername: "gatewaybot",
    handledUpdates: 4,
    ignoredUpdates: 1,
    handledCommands: 2,
    acceptedPrompts: 1,
    pollErrors: 0,
    knownSessions: 2,
    activeRunCount: 1,
    generationId: "gen-runtime",
    isLeader: true,
    retiring: false,
    rolloutStatus: "in_progress",
    lastUpdateId: 200,
    lastCommandName: "status",
    lastCommandAt: "2026-03-22T12:01:00.000Z",
    lastPromptAt: "2026-03-22T12:02:00.000Z",
    bootstrapDroppedUpdateId: null,
  };
  const observer = new RuntimeObserver({
    logsDir,
    config: {
      envFilePath: "/state/runtime.env",
      repoRoot: "/repo",
      stateRoot: "/state",
      telegramForumChatId: "-1003577434463",
    },
    serviceState,
    probe: {
      me: {
        first_name: "SEVERUS",
      },
    },
    mode: "poller",
  });

  await observer.start({ currentOffset: 123 });
  await observer.noteBootstrapDrop(122);
  await observer.noteOffset(130);
  await observer.noteRetentionSweep("2026-03-22T12:05:00.000Z");
  await observer.stop();

  const heartbeat = JSON.parse(
    await fs.readFile(path.join(logsDir, "runtime-heartbeat.json"), "utf8"),
  );
  const events = (await fs.readFile(path.join(logsDir, "runtime-events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(heartbeat.lifecycle_state, "stopped");
  assert.equal(heartbeat.generation.id, "gen-runtime");
  assert.equal(heartbeat.generation.is_leader, true);
  assert.equal(heartbeat.generation.rollout_status, "in_progress");
  assert.equal(heartbeat.polling.current_offset, 130);
  assert.equal(
    heartbeat.polling.last_retention_sweep_at,
    "2026-03-22T12:05:00.000Z",
  );
  assert.equal(heartbeat.service_state.handled_updates, 4);
  assert.equal(events[0].type, "service.started");
  assert.equal(events[1].type, "updates.bootstrap_drop");
  assert.equal(events.at(-1).type, "service.stopped");
});

test("RuntimeObserver serializes overlapping heartbeat writes", async () => {
  const logsDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-logs-"),
  );
  const serviceState = {
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
  };
  const observer = new RuntimeObserver({
    logsDir,
    config: {
      envFilePath: "/state/runtime.env",
      repoRoot: "/repo",
      stateRoot: "/state",
      telegramForumChatId: "-1003577434463",
    },
    serviceState,
    probe: {
      me: {
        first_name: "SEVERUS",
      },
    },
    mode: "poller",
  });

  await Promise.all(
    Array.from({ length: 20 }, (_, index) => observer.noteOffset(index + 1)),
  );

  const heartbeat = JSON.parse(
    await fs.readFile(path.join(logsDir, "runtime-heartbeat.json"), "utf8"),
  );

  assert.equal(heartbeat.polling.current_offset, 20);
});
