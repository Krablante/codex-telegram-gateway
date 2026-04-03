import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";

import {
  buildCodexArgs,
  buildTurnInput,
  hasChildExited,
  runCodexTask,
  summarizeCodexEvent,
  waitForListenUrl,
} from "../src/pty-worker/codex-runner.js";

test("buildCodexArgs builds app-server args", () => {
  assert.deepEqual(buildCodexArgs({
    listenUrl: "ws://127.0.0.1:40187",
  }), [
    "app-server",
    "--listen",
    "ws://127.0.0.1:40187",
  ]);
});

test("buildCodexArgs appends model and reasoning overrides", () => {
  assert.deepEqual(buildCodexArgs({
    listenUrl: "ws://127.0.0.1:40187",
    model: "gpt-5.4-mini",
    reasoningEffort: "high",
  }), [
    "app-server",
    "--listen",
    "ws://127.0.0.1:40187",
    "-c",
    'model="gpt-5.4-mini"',
    "-c",
    'model_reasoning_effort="high"',
  ]);
});

test("buildTurnInput emits text and local images", () => {
  assert.deepEqual(buildTurnInput({
    prompt: "Посмотри на это.",
    imagePaths: ["/tmp/a.png", "/tmp/b.jpg"],
  }), [
    {
      type: "text",
      text: "Посмотри на это.",
    },
    {
      type: "localImage",
      path: "/tmp/a.png",
    },
    {
      type: "localImage",
      path: "/tmp/b.jpg",
    },
  ]);
});

test("summarizeCodexEvent extracts app-server command and agent message events", () => {
  const commandSummary = summarizeCodexEvent({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        command: "ls",
        exitCode: 0,
        aggregatedOutput: "one\ntwo\n",
      },
    },
  });
  const messageSummary = summarizeCodexEvent({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        text: "done",
        phase: "commentary",
      },
    },
  });

  assert.equal(commandSummary.kind, "command");
  assert.equal(commandSummary.exitCode, 0);
  assert.equal(commandSummary.turnId, "turn-1");
  assert.equal(messageSummary.kind, "agent_message");
  assert.equal(messageSummary.text, "done");
  assert.equal(messageSummary.messagePhase, "commentary");
});

test("summarizeCodexEvent keeps turn usage details from app-server notifications", () => {
  const turnSummary = summarizeCodexEvent({
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        last: {
          totalTokens: 18244,
          inputTokens: 18215,
          cachedInputTokens: 5504,
          outputTokens: 29,
          reasoningOutputTokens: 11,
        },
      },
    },
  });

  assert.equal(turnSummary.kind, "turn");
  assert.equal(turnSummary.eventType, "thread.tokenUsage.updated");
  assert.deepEqual(turnSummary.usage, {
    input_tokens: 18215,
    cached_input_tokens: 5504,
    output_tokens: 29,
    reasoning_tokens: 11,
    total_tokens: 18244,
  });
});

test("summarizeCodexEvent still understands legacy exec events", () => {
  const turnSummary = summarizeCodexEvent({
    type: "turn.completed",
    turn_id: "turn-legacy",
    usage: {
      input_tokens: 10,
      output_tokens: 2,
    },
  });

  assert.equal(turnSummary.kind, "turn");
  assert.equal(turnSummary.eventType, "turn.completed");
  assert.equal(turnSummary.turnId, "turn-legacy");
  assert.deepEqual(turnSummary.usage, {
    input_tokens: 10,
    output_tokens: 2,
  });
});

test("runCodexTask initializes completion handlers before child lifecycle starts", async () => {
  const run = runCodexTask({
    codexBinPath: "/bin/true",
    cwd: process.cwd(),
    prompt: "Проверка раннего старта.",
  });

  assert.equal(typeof run.steer, "function");
  const finished = await run.finished;
  assert.equal(finished.exitCode, 0);
});

test("hasChildExited ignores child.killed until the process really exits", () => {
  assert.equal(
    hasChildExited({
      killed: true,
      exitCode: null,
      signalCode: null,
    }),
    false,
  );
  assert.equal(
    hasChildExited({
      killed: true,
      exitCode: null,
      signalCode: "SIGTERM",
    }),
    true,
  );
  assert.equal(
    hasChildExited({
      killed: false,
      exitCode: 0,
      signalCode: null,
    }),
    true,
  );
});

test("waitForListenUrl accepts app-server banner from stderr", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutReader = readline.createInterface({ input: stdout });
  const stderrReader = readline.createInterface({ input: stderr });
  const child = new EventEmitter();

  const wait = waitForListenUrl(stdoutReader, stderrReader, child);
  stderr.write("codex app-server (WebSockets)\n");
  stderr.write("  listening on: ws://127.0.0.1:43123\n");

  const listenUrl = await wait;
  assert.equal(listenUrl, "ws://127.0.0.1:43123");

  stdoutReader.close();
  stderrReader.close();
  stdout.end();
  stderr.end();
});

function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = [];
  child.kill = (signal = "SIGTERM") => {
    child.killCalls.push(signal);
    if (child.exitCode !== null || child.signalCode !== null) {
      return true;
    }

    child.signalCode = signal;
    setImmediate(() => {
      child.emit("close", null, signal);
    });
    return true;
  };
  return child;
}

function createMockWebSocket({
  requestHandlers = {},
} = {}) {
  return {
    onmessage: null,
    onclose: null,
    onerror: null,
    sentMessages: [],
    send(raw) {
      const message = JSON.parse(raw);
      this.sentMessages.push(message);
      if (message.id === undefined) {
        return;
      }

      const handler = requestHandlers[message.method];
      Promise.resolve()
        .then(() => handler ? handler(message.params, message) : {})
        .then((result) => {
          this.onmessage?.({
            data: JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result,
            }),
          });
        })
        .catch((error) => {
          this.onmessage?.({
            data: JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                message: error.message,
              },
            }),
          });
        });
    },
    close() {
      this.onclose?.({
        code: 1000,
        wasClean: true,
      });
    },
    emitNotification(message) {
      this.onmessage?.({
        data: JSON.stringify(message),
      });
    },
    emitClose({ code = 1006, wasClean = false } = {}) {
      this.onclose?.({ code, wasClean });
    },
  };
}

async function waitForCondition(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test("runCodexTask ignores foreign thread completion events and only finishes the primary thread", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return {
          ok: true,
        };
      },
      "thread/start"() {
        return {
          thread: {
            id: "root-thread",
          },
        };
      },
      "turn/start"() {
        return {
          turn: {
            id: "root-turn",
          },
        };
      },
    },
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

  child.stderr.write("  listening on: ws://127.0.0.1:43123\n");
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

test("runCodexTask shuts down the app-server child when the websocket disconnects unexpectedly", async () => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-empty-rollout-"),
  );
  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return {
          ok: true,
        };
      },
      "thread/start"() {
        return {
          thread: {
            id: "root-thread",
          },
        };
      },
      "turn/start"() {
        return {
          turn: {
            id: "root-turn",
          },
        };
      },
    },
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

  child.stderr.write("  listening on: ws://127.0.0.1:43124\n");
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

test("runCodexTask follows the rollout file after websocket disconnect and completes from final_answer", async () => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-"),
  );
  const rolloutDir = path.join(codexSessionsRoot, "2026", "03", "30");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-03-30T18-22-16-root-thread.jsonl",
  );
  await fs.writeFile(rolloutPath, "");

  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return {
          ok: true,
        };
      },
      "thread/start"() {
        return {
          thread: {
            id: "root-thread",
          },
        };
      },
      "turn/start"() {
        return {
          turn: {
            id: "root-turn",
          },
        };
      },
    },
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

  child.stderr.write("  listening on: ws://127.0.0.1:43125\n");
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

test("runCodexTask rollout fallback does not replay commentary that was already present before disconnect", async () => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-replay-"),
  );
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
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/start"() {
        return {
          thread: {
            id: "root-thread",
          },
        };
      },
      "turn/start"() {
        return {
          turn: {
            id: "root-turn",
          },
        };
      },
    },
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

  child.stderr.write("  listening on: ws://127.0.0.1:43126\n");
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

test("runCodexTask rollout fallback fails if the app-server exits and no final_answer arrives", async () => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-stall-"),
  );
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
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/start"() {
        return {
          thread: {
            id: "root-thread",
          },
        };
      },
      "turn/start"() {
        return {
          turn: {
            id: "root-turn",
          },
        };
      },
    },
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

  child.stderr.write("  listening on: ws://127.0.0.1:43127\n");
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

test("runCodexTask reports transport-recovering instead of pretending to steer a disconnected run", async () => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-recovering-"),
  );
  const rolloutDir = path.join(codexSessionsRoot, "2026", "03", "30");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-03-30T18-22-16-root-thread.jsonl",
  );
  await fs.writeFile(rolloutPath, "");

  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/start"() {
        return {
          thread: {
            id: "root-thread",
          },
        };
      },
      "turn/start"() {
        return {
          turn: {
            id: "root-turn",
          },
        };
      },
    },
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

  child.stderr.write("  listening on: ws://127.0.0.1:43128\n");
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

test("runCodexTask waits for async final message handling before resolving turn completion", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/start"() {
        return {
          thread: {
            id: "root-thread",
          },
        };
      },
      "turn/start"() {
        return {
          turn: {
            id: "root-turn",
          },
        };
      },
    },
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

  child.stderr.write("  listening on: ws://127.0.0.1:43129\n");
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
