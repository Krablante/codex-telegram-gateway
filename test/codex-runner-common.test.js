import test from "node:test";
import assert from "node:assert/strict";
import readline from "node:readline";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  buildCodexArgs,
  buildTurnInput,
  hasChildExited,
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

  const wait = waitForListenUrl(stdoutReader, stderrReader, child, {
    timeoutMs: 1000,
  });
  stderr.write("codex app-server (WebSockets)\n");
  stderr.write("  listening on: ws://127.0.0.1:43123\n");

  const listenUrl = await wait;
  assert.equal(listenUrl, "ws://127.0.0.1:43123");

  stdoutReader.close();
  stderrReader.close();
  stdout.end();
  stderr.end();
});

test("waitForListenUrl includes recent app-server output in timeout errors", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutReader = readline.createInterface({ input: stdout });
  const stderrReader = readline.createInterface({ input: stderr });
  const child = new EventEmitter();

  const wait = waitForListenUrl(stdoutReader, stderrReader, child, {
    timeoutMs: 25,
  });
  stdout.write("booting codex app-server\n");
  stderr.write("warning: slow init path\n");

  await assert.rejects(wait, (error) => {
    assert.match(error.message, /Timed out waiting for Codex app-server to start/u);
    assert.match(error.message, /\[stdout\] booting codex app-server/u);
    assert.match(error.message, /\[stderr\] warning: slow init path/u);
    return true;
  });

  stdoutReader.close();
  stderrReader.close();
  stdout.end();
  stderr.end();
});
