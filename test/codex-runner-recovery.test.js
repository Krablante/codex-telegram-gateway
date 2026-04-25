import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { runCodexTask } from "../src/pty-worker/codex-runner.js";
import {
  readRolloutDelta,
  summarizeRolloutLine,
  watchRolloutForTaskComplete,
} from "../src/pty-worker/codex-runner-recovery.js";
import {
  createMockChild,
  createMockWebSocket,
  createStandardRequestHandlers,
  emitListenBanner,
  waitForCondition,
} from "../test-support/codex-runner-fixtures.js";

test("summarizeRolloutLine keeps phase-less rollout agent messages non-terminal", () => {
  const summary = summarizeRolloutLine(
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Промежуточный комментарий.",
      },
    }),
    {
      primaryThreadId: "root-thread",
    },
  );

  assert.equal(summary?.messagePhase, null);
});

test("readRolloutDelta can flush an unterminated final record at EOF", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-tail-read-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const rolloutPath = path.join(root, "rollout.jsonl");
  await fs.writeFile(
    rolloutPath,
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "EOF final without newline.",
      },
    }),
    "utf8",
  );

  const delta = await readRolloutDelta({
    filePath: rolloutPath,
    offset: 0,
    carryover: Buffer.alloc(0),
    flushTailAtEof: true,
  });

  assert.equal(delta.lines.length, 1);
  assert.match(delta.lines[0].text, /EOF final without newline/u);
  assert.equal(delta.carryover.length, 0);
});

test("watchRolloutForTaskComplete ignores an older final before a newer task_started in the same rollout", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-watch-"),
  );
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const rolloutPath = path.join(root, "rollout.jsonl");
  await fs.writeFile(
    rolloutPath,
    [
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "old-turn",
          last_agent_message: "OLD FINAL FROM EARLIER TURN",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "new-turn",
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  let settled = false;
  let completedSummary = null;
  const watchPromise = watchRolloutForTaskComplete({
    codexSessionsRoot: root,
    rolloutPollIntervalMs: 20,
    getSettled: () => settled,
    getWatchingDisabled: () => false,
    getActiveTurnId: () => null,
    getHasPrimaryFinalAnswer: () => false,
    getPrimaryThreadId: () => "root-thread",
    getProviderSessionId: () => null,
    getLatestThreadId: () => "root-thread",
    getRolloutPath: () => rolloutPath,
    setContextSnapshot() {},
    setProviderSessionId() {},
    setRolloutPath() {},
    getRolloutObservedOffset: () => 0,
    rememberSummary: () => true,
    emitSummary() {},
    onTaskComplete(summary) {
      completedSummary = summary;
      settled = true;
    },
  });

  await sleep(50);
  assert.equal(completedSummary, null);

  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "new-turn",
        last_agent_message: "Fresh final from the current turn.",
      },
    })}\n`,
    "utf8",
  );

  const result = await watchPromise;
  assert.equal(result.completed, true);
  assert.equal(completedSummary?.text, "Fresh final from the current turn.");
});

test("runCodexTask turns an unexpected websocket disconnect into a resume path when a thread is known", async (t) => {
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
    transportReattachRetryDelayMs: 10,
    transportReattachTimeoutMs: 50,
  });

  emitListenBanner(child, 43124);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitClose({
    code: 1006,
    wasClean: false,
  });

  const result = await run.finished;
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGINT");
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptReason, "upstream");
  assert.equal(result.abortReason, "transport_lost");
  assert.deepEqual(result.resumeReplacement, {
    requestedThreadId: "root-thread",
    replacementThreadId: null,
    reason: "transport-disconnect",
  });
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("runCodexTask reattaches to the same app-server websocket before falling back to rollout recovery", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-reattach-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const firstWs = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const secondWs = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const sockets = [firstWs, secondWs];
  let openCallCount = 0;
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Проверь transport reattach.",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => sockets[openCallCount++],
    codexSessionsRoot,
    rolloutDiscoveryTimeoutMs: 50,
    transportReattachRetryDelayMs: 10,
    transportReattachTimeoutMs: 100,
  });

  emitListenBanner(child, 43124);
  await waitForCondition(
    () => firstWs.sentMessages.some((message) => message.method === "turn/start"),
  );

  firstWs.emitClose({
    code: 1006,
    wasClean: false,
  });

  await waitForCondition(
    () => secondWs.sentMessages.some((message) => message.method === "thread/resume"),
  );
  secondWs.emitNotification({
    method: "item/completed",
    params: {
      threadId: "root-thread",
      turnId: "root-turn",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "Финал после reattach.",
      },
    },
  });
  secondWs.emitNotification({
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
  assert.equal(result.resumeReplacement, null);
  assert.equal(openCallCount, 2);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("runCodexTask keeps watching rollout after reattach when resume returns a completed turn without the final output", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-reattach-completed-tail-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "04", "18");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-04-18T12-30-00-root-thread.jsonl",
  );
  await fs.writeFile(rolloutPath, "");

  const firstWs = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const secondWs = createMockWebSocket({
    requestHandlers: {
      ...createStandardRequestHandlers(),
      "thread/resume"(params) {
        assert.equal(params.threadId, "root-thread");
        return {
          thread: {
            id: "root-thread",
            turns: [
              {
                id: "root-turn",
                status: "completed",
              },
            ],
          },
        };
      },
    },
  });
  const sockets = [firstWs, secondWs];
  let openCallCount = 0;
  const summaries = [];
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Не теряй task_complete после reattach.",
    onEvent(summary) {
      summaries.push(summary);
    },
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => sockets[openCallCount++],
    codexSessionsRoot,
    rolloutPollIntervalMs: 20,
    transportReattachRetryDelayMs: 10,
    transportReattachTimeoutMs: 100,
  });

  emitListenBanner(child, 43132);
  await waitForCondition(
    () => firstWs.sentMessages.some((message) => message.method === "turn/start"),
  );

  firstWs.emitClose({
    code: 1006,
    wasClean: false,
  });

  await waitForCondition(
    () => secondWs.sentMessages.some((message) => message.method === "thread/resume"),
  );

  setTimeout(() => {
    void fs.appendFile(
      rolloutPath,
      `${JSON.stringify({
        timestamp: "2026-04-18T12:30:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "root-turn",
          last_agent_message: "Финал после reattach task_complete.",
        },
      })}\n`,
    );
  }, 80);

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
  assert.equal(result.threadId, "root-thread");
  assert.equal(result.resumeReplacement, null);
  assert.equal(openCallCount, 2);
  assert.equal(
    summaries.some((summary) => summary.text === "Финал после reattach task_complete."),
    true,
  );
});

test("runCodexTask uses official thread history to repair a stale stored thread id before resume", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/list"() {
        return {
          data: [
            {
              id: "history-thread",
              preview: [
                "Context:",
                "session_key: -1001234567890:2203",
              ].join("\n"),
            },
          ],
          nextCursor: null,
        };
      },
      "thread/resume"(params) {
        assert.equal(params.threadId, "history-thread");
        return {
          thread: {
            id: "history-thread",
          },
        };
      },
      "turn/start"() {
        return {
          turn: {
            id: "history-turn",
          },
        };
      },
    },
  });

  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: "/srv/codex-workspace",
    prompt: "Продолжай.",
    sessionKey: "-1001234567890:2203",
    sessionThreadId: "stale-thread",
    providerSessionId: "provider-session-2203",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
  });

  emitListenBanner(child, 43126);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitNotification({
    method: "item/completed",
    params: {
      threadId: "history-thread",
      turnId: "history-turn",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "Resume recovered from official history.",
      },
    },
  });
  ws.emitNotification({
    method: "turn/completed",
    params: {
      threadId: "history-thread",
      turn: {
        id: "history-turn",
      },
    },
  });

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
  assert.equal(result.threadId, "history-thread");
  assert.equal(result.resumeReplacement, null);
  assert.equal(
    ws.sentMessages.some(
      (message) => message.method === "thread/list",
    ),
    true,
  );
});

test("runCodexTask uses official thread history even when local continuity ids are gone", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/list"() {
        return {
          data: [
            {
              id: "history-only-thread",
              preview: [
                "Context:",
                "session_key: -1001234567890:2203",
              ].join("\n"),
            },
          ],
          nextCursor: null,
        };
      },
      "thread/resume"(params) {
        assert.equal(params.threadId, "history-only-thread");
        return {
          thread: {
            id: "history-only-thread",
          },
        };
      },
      "turn/start"() {
        return {
          turn: {
            id: "history-only-turn",
          },
        };
      },
    },
  });

  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: "/srv/codex-workspace",
    prompt: "Продолжай нативный resume.",
    sessionKey: "-1001234567890:2203",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
  });

  emitListenBanner(child, 43127);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitNotification({
    method: "item/completed",
    params: {
      threadId: "history-only-thread",
      turnId: "history-only-turn",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "History-only resume recovered.",
      },
    },
  });
  ws.emitNotification({
    method: "turn/completed",
    params: {
      threadId: "history-only-thread",
      turn: {
        id: "history-only-turn",
      },
    },
  });

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
  assert.equal(result.threadId, "history-only-thread");
  assert.equal(
    ws.sentMessages.some((message) => message.method === "thread/list"),
    true,
  );
  assert.equal(
    ws.sentMessages.some((message) => message.method === "thread/resume"),
    true,
  );
});

test("runCodexTask broadens history repair beyond cwd-scoped thread list when session history lives elsewhere", async () => {
  const child = createMockChild();
  const threadListCalls = [];
  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/list"(params) {
        threadListCalls.push(params);
        if (threadListCalls.length === 1) {
          assert.equal(params.cwd, "/srv/codex-workspace");
          return {
            data: [],
            nextCursor: null,
          };
        }

        assert.equal("cwd" in params, false);
        return {
          data: [
            {
              id: "global-history-thread",
              preview: [
                "Context:",
                "session_key: -1001234567890:2203",
              ].join("\n"),
            },
          ],
          nextCursor: null,
        };
      },
      "thread/resume"(params) {
        assert.equal(params.threadId, "global-history-thread");
        return {
          thread: {
            id: "global-history-thread",
          },
        };
      },
      "turn/start"() {
        return {
          turn: {
            id: "global-history-turn",
          },
        };
      },
    },
  });

  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: "/srv/codex-workspace",
    prompt: "Продолжай через глобальную историю.",
    sessionKey: "-1001234567890:2203",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
  });

  emitListenBanner(child, 43137);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitNotification({
    method: "item/completed",
    params: {
      threadId: "global-history-thread",
      turnId: "global-history-turn",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "Global history resume recovered.",
      },
    },
  });
  ws.emitNotification({
    method: "turn/completed",
    params: {
      threadId: "global-history-thread",
      turn: {
        id: "global-history-turn",
      },
    },
  });

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
  assert.equal(result.threadId, "global-history-thread");
  assert.equal(threadListCalls.length, 2);
});

test("runCodexTask fails fast when session-key-only history repair breaks", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/list"() {
        throw new Error("list unavailable");
      },
    },
  });

  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: "/srv/codex-workspace",
    prompt: "Продолжай.",
    sessionKey: "-1001234567890:2203",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
  });

  emitListenBanner(child, 43138);

  await assert.rejects(
    run.finished,
    /Codex thread history lookup failed before resume: list unavailable/u,
  );
  assert.equal(
    ws.sentMessages.some((message) => message.method === "thread/start"),
    false,
  );
});

test("runCodexTask does not start a duplicate turn when thread resume already exposes an in-progress turn", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/resume"(params) {
        assert.equal(params.threadId, "history-thread");
        return {
          thread: {
            id: "history-thread",
            turns: [
              {
                id: "history-turn",
                status: "inProgress",
              },
            ],
          },
        };
      },
    },
  });

  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: "/srv/codex-workspace",
    prompt: "Не дублируй turn.",
    sessionKey: "-1001234567890:2203",
    sessionThreadId: "history-thread",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
  });

  emitListenBanner(child, 43139);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "thread/resume"),
  );
  assert.equal(
    ws.sentMessages.some((message) => message.method === "turn/start"),
    false,
  );

  ws.emitNotification({
    method: "item/completed",
    params: {
      threadId: "history-thread",
      turnId: "history-turn",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "Reused the open turn.",
      },
    },
  });
  ws.emitNotification({
    method: "turn/completed",
    params: {
      threadId: "history-thread",
      turn: {
        id: "history-turn",
      },
    },
  });

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
  assert.equal(result.threadId, "history-thread");
});

test("runCodexTask skips thread history lookup during a deliberate fresh-start bootstrap", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/start"() {
        return {
          thread: {
            id: "fresh-start-thread",
          },
        };
      },
      "turn/start"() {
        return {
          turn: {
            id: "fresh-start-turn",
          },
        };
      },
    },
  });

  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: "/srv/codex-workspace",
    prompt: "Стартуй свежо после compact.",
    sessionKey: "-1001234567890:2203",
    skipThreadHistoryLookup: true,
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
  });

  emitListenBanner(child, 43128);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  ws.emitNotification({
    method: "item/completed",
    params: {
      threadId: "fresh-start-thread",
      turnId: "fresh-start-turn",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "Fresh start respected.",
      },
    },
  });
  ws.emitNotification({
    method: "turn/completed",
    params: {
      threadId: "fresh-start-thread",
      turn: {
        id: "fresh-start-turn",
      },
    },
  });

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
  assert.equal(result.threadId, "fresh-start-thread");
  assert.equal(
    ws.sentMessages.some((message) => message.method === "thread/list"),
    false,
  );
  assert.equal(
    ws.sentMessages.some((message) => message.method === "thread/resume"),
    false,
  );
  assert.equal(
    ws.sentMessages.some((message) => message.method === "thread/start"),
    true,
  );
});

test("runCodexTask fails fast when historical thread lookup breaks while continuity hints exist", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/list"() {
        throw new Error("list unavailable");
      },
    },
  });

  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: "/srv/codex-workspace",
    prompt: "Продолжай.",
    sessionKey: "-1001234567890:2203",
    sessionThreadId: "stale-thread",
    providerSessionId: "provider-session-2203",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
  });

  emitListenBanner(child, 43129);

  await assert.rejects(
    run.finished,
    /Codex thread history lookup failed before resume: list unavailable/u,
  );
});

test("runCodexTask surfaces transient resume errors instead of pretending the thread is gone", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/resume"() {
        throw new Error("network timeout");
      },
    },
  });

  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: "/srv/codex-workspace",
    prompt: "Продолжай.",
    sessionKey: "-1001234567890:2203",
    sessionThreadId: "stale-thread",
    skipThreadHistoryLookup: true,
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
  });

  emitListenBanner(child, 43130);

  await assert.rejects(run.finished, /network timeout/u);
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

test("runCodexTask ignores preexisting rollout finals when a known rollout path is already stored", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-known-path-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "04", "21");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-04-21T14-19-46-root-thread.jsonl",
  );
  await fs.writeFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-04-21T14:21:02.118Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        phase: "final_answer",
        message: "Старый финал из предыдущего turn.",
      },
    })}\n${JSON.stringify({
      timestamp: "2026-04-21T14:21:02.203Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "older-turn",
        last_agent_message: "Старый task_complete из предыдущего turn.",
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
    prompt: "Игнорируй старый финал и дождись текущего.",
    knownRolloutPath: rolloutPath,
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

  let settled = false;
  void run.finished.then(() => {
    settled = true;
  });

  emitListenBanner(child, 43130);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "turn/start"),
  );

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(settled, false);
  assert.equal(
    summaries.some((summary) => summary.text === "Старый финал из предыдущего turn."),
    false,
  );
  assert.equal(
    summaries.some((summary) => summary.text === "Старый task_complete из предыдущего turn."),
    false,
  );

  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-04-21T15:18:00.914Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "root-turn",
        last_agent_message: "Новый финал только для текущего turn.",
      },
    })}\n`,
  );

  const result = await run.finished;
  assert.equal(result.exitCode, 0);
  assert.equal(
    summaries.some((summary) => summary.text === "Новый финал только для текущего turn."),
    true,
  );
});

test("runCodexTask keeps app-server exit without a final answer on the resume path when a thread is known", async (t) => {
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

  const result = await run.finished;
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGINT");
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptReason, "upstream");
  assert.equal(result.abortReason, "transport_lost");
  assert.deepEqual(result.resumeReplacement, {
    requestedThreadId: "root-thread",
    replacementThreadId: null,
    reason: "transport-disconnect",
  });
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

test("runCodexTask keeps rollout turn_aborted on a transport resume path and reaps the child", async (t) => {
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
  assert.deepEqual(result.resumeReplacement, {
    requestedThreadId: "root-thread",
    replacementThreadId: null,
    reason: "transport-disconnect",
  });
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("runCodexTask preserves non-interrupted rollout turn_aborted as a terminal failure instead of transport resume", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-rollout-turn-failed-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "04", "15");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-04-15T19-20-41-root-thread.jsonl",
  );
  await fs.writeFile(rolloutPath, "");

  const ws = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Не маскируй failure как resume.",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
    codexSessionsRoot,
    rolloutDiscoveryTimeoutMs: 100,
    rolloutPollIntervalMs: 20,
    rolloutStallWithoutChildExitMs: 200,
  });

  emitListenBanner(child, 43140);
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
      timestamp: "2026-04-15T19:20:41.000Z",
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        turn_id: "root-turn",
        reason: "tool_error",
      },
    })}\n`,
  );

  const result = await run.finished;
  assert.equal(result.exitCode, 1);
  assert.equal(result.signal, null);
  assert.equal(result.interrupted, false);
  assert.equal(result.abortReason, "tool_error");
  assert.equal(result.resumeReplacement, null);
  assert.match(result.warnings.at(-1), /Codex turn aborted \(tool_error\)/u);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("runCodexTask turns stalled disconnect recovery into a transport resume path when a thread is known", async (t) => {
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

  const result = await run.finished;
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGINT");
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptReason, "upstream");
  assert.equal(result.abortReason, "transport_lost");
  assert.deepEqual(result.resumeReplacement, {
    requestedThreadId: "root-thread",
    replacementThreadId: null,
    reason: "transport-disconnect",
  });
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("runCodexTask buffers steer input while transport recovery is in progress", async (t) => {
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
    ok: true,
    reason: "steer-buffered",
    inputCount: 1,
  });

  child.exitCode = 1;
  child.emit("close", 1, null);
  const result = await run.finished;
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGINT");
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptReason, "upstream");
  assert.equal(result.abortReason, "transport_lost");
  assert.deepEqual(result.resumeReplacement, {
    requestedThreadId: "root-thread",
    replacementThreadId: null,
    reason: "transport-disconnect",
  });
});

test("runCodexTask finishes interrupted when reattach finds the resumed turn already interrupted", async (t) => {
  const child = createMockChild();
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-reattach-interrupted-"),
  );
  t.after(async () => {
    await fs.rm(codexSessionsRoot, { recursive: true, force: true });
  });

  const firstWs = createMockWebSocket({
    requestHandlers: createStandardRequestHandlers(),
  });
  const secondWs = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/resume"() {
        return {
          thread: {
            id: "root-thread",
            turns: [
              {
                id: "root-turn",
                status: "interrupted",
              },
            ],
          },
        };
      },
    },
  });
  const sockets = [firstWs, secondWs];
  let openCallCount = 0;
  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Проверь interrupted reattach.",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => sockets[openCallCount++],
    codexSessionsRoot,
    rolloutDiscoveryTimeoutMs: 50,
    transportReattachRetryDelayMs: 10,
    transportReattachTimeoutMs: 100,
  });

  emitListenBanner(child, 43141);
  await waitForCondition(
    () => firstWs.sentMessages.some((message) => message.method === "turn/start"),
  );

  firstWs.emitClose({
    code: 1006,
    wasClean: false,
  });

  const result = await run.finished;
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGINT");
  assert.equal(result.interrupted, true);
  assert.equal(result.abortReason, "transport_lost");
  assert.deepEqual(result.resumeReplacement, {
    requestedThreadId: "root-thread",
    replacementThreadId: null,
    reason: "transport-disconnect",
  });
});

test("runCodexTask preserves user interrupt semantics when startup dies before thread ids exist", async () => {
  const child = createMockChild();
  const ws = createMockWebSocket({
    requestHandlers: {
      initialize() {
        return { ok: true };
      },
      "thread/list"() {
        return new Promise(() => {});
      },
    },
  });

  const run = runCodexTask({
    codexBinPath: "codex",
    cwd: process.cwd(),
    prompt: "Остановись во время раннего startup.",
    sessionKey: "-1001234567890:2203",
    spawnImpl() {
      return child;
    },
    openWebSocketImpl: async () => ws,
  });

  emitListenBanner(child, 43142);
  await waitForCondition(
    () => ws.sentMessages.some((message) => message.method === "thread/list"),
  );

  await run.interrupt();
  ws.emitClose({
    code: 1006,
    wasClean: false,
  });
  child.emit("close", null, "SIGINT");

  const result = await run.finished;
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, "SIGINT");
  assert.equal(result.interrupted, true);
  assert.equal(result.interruptReason, "user");
});
