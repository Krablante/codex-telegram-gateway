import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCodexTask } from "../src/pty-worker/codex-runner.js";
import {
  createMockChild,
  createMockWebSocket,
  createStandardRequestHandlers,
  emitListenBanner,
  waitForCondition,
} from "../test-support/codex-runner-fixtures.js";

test("runCodexTask shuts down the app-server child when the websocket disconnects unexpectedly", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-empty-rollout-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Проверь disconnect.",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
    codexSessionsRoot,
    rolloutDiscoveryTimeoutMs: 50,
  });

  emitListenBanner(child, 43124);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitClose({
    code: 1006,
    wasClean: false,
  });

  await assert.rejects(run.finished, /websocket closed \(code=1006, clean=false\)/u);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("runCodexTask follows the rollout file after websocket disconnect and completes from final_answer", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "03", "30");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-03-30T18-22-16-root-thread.jsonl",
  );
  await fs.writeFile(rolloutPath, "");

  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const summaries = [];
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Проверь rollout fallback.",
    onEvent(summary) {
      summaries.push(summary);
    },
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
    codexSessionsRoot,
    rolloutDiscoveryTimeoutMs: 100,
    rolloutPollIntervalMs: 20,
  });

  emitListenBanner(child, 43125);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitClose({
    code: 1006,
    wasClean: false,
  });

  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-03-30T18:38:23.493Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Комментарий после обрыва сокета.",
        phase: "commentary",
      },
    })}\n`,
  );
  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-03-30T18:40:23.493Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Финал из rollout fallback.",
        phase: "final_answer",
      },
    })}\n`,
  );

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
  assert.equal(result.threadId, "root-thread");
  assert.equal(
    summaries.some((summary) => summary.text === "Комментарий после обрыва сокета."),
    true,
  );
  assert.equal(
    summaries.some((summary) => summary.text === "Финал из rollout fallback."),
    true,
  );
});

test("runCodexTask rollout fallback does not replay commentary that was already present before disconnect", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-replay-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "03", "30");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-03-30T18-22-16-root-thread.jsonl",
  );
  await fs.writeFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-03-30T18:35:23.493Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Старый комментарий до обрыва.",
        phase: "commentary",
      },
    })}\n`,
  );

  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const summaries = [];
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Не дублируй старые rollout-сообщения.",
    onEvent(summary) {
      summaries.push(summary);
    },
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
    codexSessionsRoot,
    rolloutDiscoveryTimeoutMs: 100,
    rolloutPollIntervalMs: 20,
  });

  emitListenBanner(child, 43126);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitClose({
    code: 1006,
    wasClean: false,
  });

  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-03-30T18:38:23.493Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Новый комментарий после обрыва 1.",
        phase: "commentary",
      },
    })}\n`,
  );
  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-03-30T18:39:23.493Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Новый комментарий после обрыва 2.",
        phase: "commentary",
      },
    })}\n`,
  );
  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-03-30T18:40:23.493Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Финал после обрыва.",
        phase: "final_answer",
      },
    })}\n`,
  );

  await run.finished;
  assert.equal(
    summaries.some((summary) => summary.text === "Старый комментарий до обрыва."),
    false,
  );
  assert.equal(
    summaries.some((summary) => summary.text === "Новый комментарий после обрыва 1."),
    true,
  );
  assert.equal(
    summaries.some((summary) => summary.text === "Новый комментарий после обрыва 2."),
    true,
  );
});

test("runCodexTask completes from rollout task_complete when websocket finalization never arrives", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-task-complete-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "04", "05");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-04-05T18-22-16-root-thread.jsonl",
  );
  await fs.writeFile(rolloutPath, "");

  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const summaries = [];
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Заверши по task_complete.",
    onEvent(summary) {
      summaries.push(summary);
    },
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
    codexSessionsRoot,
    rolloutDiscoveryTimeoutMs: 100,
    rolloutPollIntervalMs: 20,
  });

  emitListenBanner(child, 43128);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitClose({
    code: 1006,
    wasClean: false,
  });

  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-04-05T18:40:23.493Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "root-turn",
        last_agent_message: "Финал из task_complete fallback.",
      },
    })}\n`,
  );

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
  assert.equal(
    summaries.some((summary) => summary.text === "Финал из task_complete fallback."),
    true,
  );
});

test("runCodexTask completes from rollout task_complete while the websocket stays connected", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-live-task-complete-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "04", "08");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-04-08T18-55-00-root-thread.jsonl",
  );
  await fs.writeFile(rolloutPath, "");

  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const summaries = [];
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Заверши run по live task_complete.",
    onEvent(summary) {
      summaries.push(summary);
    },
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
    codexSessionsRoot,
    rolloutPollIntervalMs: 20,
  });

  emitListenBanner(child, 43129);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-04-08T18:56:23.493Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "root-turn",
        last_agent_message: "Финал из live task_complete watcher.",
      },
    })}\n`,
  );

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  assert.equal(
    summaries.some((summary) => summary.text === "Финал из live task_complete watcher."),
    true,
  );
});

test("runCodexTask rollout fallback fails if the app-server exits and no final_answer arrives", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-stall-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "03", "30");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-03-30T18-22-16-root-thread.jsonl",
  );
  await fs.writeFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-03-30T18:35:23.493Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Старый комментарий до обрыва.",
        phase: "commentary",
      },
    })}\n`,
  );

  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Не зависай без финала.",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
    codexSessionsRoot,
    rolloutDiscoveryTimeoutMs: 100,
    rolloutPollIntervalMs: 20,
    rolloutStallAfterChildExitMs: 60,
  });

  emitListenBanner(child, 43127);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitClose({
    code: 1006,
    wasClean: false,
  });

  child.exitCode = 1;
  child.emit("close", 1, null);

  await assert.rejects(
    run.finished,
    /exited before rollout fallback reached a final answer/u,
  );
});

test("runCodexTask resolves interrupted when disconnect recovery sees a user interrupt before child exit", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-interrupt-recovery-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "04", "15");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-04-15T19-45-56-root-thread.jsonl",
  );
  await fs.writeFile(rolloutPath, "");

  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Остановись cleanly во время recovery.",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
    codexSessionsRoot,
    rolloutDiscoveryTimeoutMs: 100,
    rolloutPollIntervalMs: 20,
    rolloutStallAfterChildExitMs: 60,
  });

  emitListenBanner(child, 43130);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitClose({
    code: 1006,
    wasClean: false,
  });

  assert.equal(await run.interrupt(), false);

  child.exitCode = 0;
  child.emit("close", 0, null);

  const result = await run.finished;
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGINT");
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptReason, "user");
});

test("runCodexTask finishes interrupted from rollout turn_aborted and reaps the child", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-turn-aborted-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "04", "15");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-04-15T19-20-40-root-thread.jsonl",
  );
  await fs.writeFile(rolloutPath, "");

  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Не зависай после turn_aborted.",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
    codexSessionsRoot,
    rolloutDiscoveryTimeoutMs: 100,
    rolloutPollIntervalMs: 20,
    rolloutStallWithoutChildExitMs: 200,
  });

  emitListenBanner(child, 43131);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitClose({
    code: 1006,
    wasClean: false,
  });

  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-04-15T19:20:40.000Z",
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        turn_id: "root-turn",
        reason: "interrupted",
      },
    })}\n`,
  );

  const result = await run.finished;
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGINT");
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptReason, "upstream");
  assert.equal(result.abortReason, "interrupted");
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("runCodexTask fails stalled recovery when the websocket disconnects and rollout stops growing", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-stall-live-child-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "04", "15");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-04-15T19-20-40-root-thread.jsonl",
  );
  await fs.writeFile(rolloutPath, "");

  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Не виси бесконечно после disconnect.",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
    codexSessionsRoot,
    rolloutDiscoveryTimeoutMs: 100,
    rolloutPollIntervalMs: 20,
    rolloutStallWithoutChildExitMs: 60,
  });

  emitListenBanner(child, 43132);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitClose({
    code: 1006,
    wasClean: false,
  });

  await assert.rejects(
    run.finished,
    /rollout recovery stalled after websocket disconnect/u,
  );
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("runCodexTask reports transport-recovering instead of pretending to steer a disconnected run", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-recovering-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "03", "30");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-03-30T18-22-16-root-thread.jsonl",
  );
  await fs.writeFile(rolloutPath, "");

  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Не pretend-steer во время recovery.",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
    codexSessionsRoot,
    rolloutDiscoveryTimeoutMs: 100,
    rolloutPollIntervalMs: 20,
    rolloutStallAfterChildExitMs: 60,
  });

  emitListenBanner(child, 43128);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitClose({
    code: 1006,
    wasClean: false,
  });

  const steerResult = await run.steer({
    input: [{ type: "text", text: "follow-up" }],
  });
  assert.deepEqual(steerResult, {
    ok: false,
    reason: "transport-recovering",
  });

  child.exitCode = 1;
  child.emit("close", 1, null);
  await assert.rejects(
    run.finished,
    /exited before rollout fallback reached a final answer/u,
  );
});
