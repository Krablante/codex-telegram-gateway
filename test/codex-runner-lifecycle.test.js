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

test("runCodexTask ignores foreign thread completion events and only finishes the primary thread", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const summaries = [];
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Проверь чужой turn/completed.",
    onEvent(summary) {
      summaries.push(summary);
    },
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
  });

  emitListenBanner(child, 43123);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitNotification({
    method: "turn/completed",
    params: {
      threadId: "foreign-thread",
      turn: {
        id: "foreign-turn",
      },
    },
  });

  let settled = false;
  void run.finished.finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(settled, false);

  ws.emitNotification({
    method: "item/completed",
    params: {
      threadId: "foreign-thread",
      turnId: "foreign-turn",
      item: {
        type: "agentMessage",
        text: "Подсказка от сабагента.",
        phase: "commentary",
      },
    },
  });
  ws.emitNotification({
    method: "turn/completed",
    params: {
      threadId: "root-thread",
      turn: {
        id: "root-turn",
      },
    },
  });

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
  assert.equal(result.threadId, "root-thread");
  assert.equal(
    summaries.some((summary) => summary.isPrimaryThreadEvent === false),
    true,
  );
});

test("runCodexTask keeps refreshing the active turn id across many steer responses", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-runner-steer-turn-id-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const steerCount = 100;
  const steerExpectedTurnIds = [];
  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers({
      turnId: "turn-1",
      onTurnSteer(params) {
        steerExpectedTurnIds.push(params.expectedTurnId);
        const expectedIndex = steerExpectedTurnIds.length;
        assert.equal(
          params.expectedTurnId,
          `turn-${expectedIndex}`,
          `unexpected steer turn id at step ${expectedIndex}`,
        );
        return {
          turn: {
            id: `turn-${expectedIndex + 1}`,
          },
        };
      },
    }),
  });

  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Allow repeated steer updates.",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
    codexSessionsRoot,
  });

  emitListenBanner(child, 43128);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  for (let index = 1; index <= steerCount; index += 1) {
    const steerResult = await run.steer({
      input: [{ type: "text", text: `follow-up ${index}` }],
    });
    assert.equal(steerResult.ok, true);
    assert.equal(steerResult.reason, "steered");
    assert.equal(steerResult.turnId, `turn-${index + 1}`);
  }

  assert.deepEqual(
    steerExpectedTurnIds,
    Array.from({ length: steerCount }, (_, index) => `turn-${index + 1}`),
  );

  ws.emitNotification({
    method: "turn/completed",
    params: {
      threadId: "root-thread",
      turnId: `turn-${steerCount + 1}`,
    },
  });

  const finished = await run.finished;
  assert.equal(finished.exitCode, 0);
});

test("runCodexTask waits for async final message handling before resolving turn completion", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });

  let finalMessageHandled = false;
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Не обгоняй async final handler.",
    onEvent: async (summary) => {
      if (summary.kind === "agent_message" && summary.messagePhase === "final_answer") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        finalMessageHandled = true;
      }
    },
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
  });

  emitListenBanner(child, 43129);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitNotification({
    method: "item/completed",
    params: {
      threadId: "root-thread",
      turnId: "root-turn",
      item: {
        type: "agentMessage",
        text: "Финал.",
        phase: "final_answer",
      },
    },
  });
  ws.emitNotification({
    method: "turn/completed",
    params: {
      threadId: "root-thread",
      turn: {
        id: "root-turn",
      },
    },
  });

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
  assert.equal(finalMessageHandled, true);
});

test("runCodexTask waits briefly for a late final message after turn completion", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });

  let finalMessageHandled = false;
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Не теряй поздний финал после turn/completed.",
    onEvent: async (summary) => {
      if (summary.kind === "agent_message" && summary.messagePhase === "final_answer") {
        finalMessageHandled = true;
      }
    },
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
  });

  emitListenBanner(child, 43130);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitNotification({
    method: "turn/completed",
    params: {
      threadId: "root-thread",
      turn: {
        id: "root-turn",
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  child.exitCode = 0;
  child.emit("close", 0, null);

  setTimeout(() => {
    ws.emitNotification({
      method: "item/completed",
      params: {
        threadId: "root-thread",
        turnId: "root-turn",
        item: {
          type: "agentMessage",
          text: "Поздний финал.",
          phase: "final_answer",
        },
      },
    });
  }, 10);

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
  assert.equal(finalMessageHandled, true);
});

test("runCodexTask ignores websocket disconnects after turn completion while the final-message grace window is open", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });

  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Не уходи в recovery после уже завершённого turn.",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
  });

  emitListenBanner(child, 43131);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitNotification({
    method: "turn/completed",
    params: {
      threadId: "root-thread",
      turn: {
        id: "root-turn",
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  ws.emitClose({
    code: 1006,
    wasClean: false,
  });
  child.exitCode = 0;
  child.emit("close", 0, null);

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
});
