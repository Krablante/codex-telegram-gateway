import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { CodexWorkerPool } from "../src/pty-worker/worker-pool.js";
import {
  createServiceState,
  createSession,
  createTelegramApiRecorder,
  createTempSessionStore,
  waitForRunToFinish,
} from "../test-support/worker-pool-fixtures.js";

const INITIAL_PROGRESS_TEXT = "...";

test("CodexWorkerPool mirrors the exec-json live smoke through a local runner contract", async (t) => {
  // This preserves the worker-pool live-smoke contract without spawning external Codex.
  const smokePrompt = "Reply with exactly WORKER_EXEC_JSON_SMOKE_OK and nothing else.";
  const smokeReply = "WORKER_EXEC_JSON_SMOKE_OK";
  const smokeThreadId = "local-contract-thread";
  const { sessionStore, cleanup } = await createTempSessionStore(
    "codex-telegram-gateway-exec-json-contract-",
  );
  const telegram = createTelegramApiRecorder();
  const serviceState = createServiceState();
  const session = await createSession(sessionStore, {
    topicId: 4301,
    topicName: "Exec JSON Contract",
    createdVia: "test/exec-json-contract",
  });
  const runCalls = [];
  let workerPool = null;

  t.after(async () => {
    await workerPool?.shutdown({
      drainTimeoutMs: 1000,
      interruptActiveRuns: true,
    }).catch(() => null);
    await cleanup();
  });

  workerPool = new CodexWorkerPool({
    api: telegram.api,
    config: {
      codexBinPath: "codex",
      codexGatewayBackend: "exec-json",
      maxParallelSessions: 1,
    },
    sessionStore,
    serviceState,
    runTask: ({
      codexBinPath,
      cwd,
      prompt,
      developerInstructions,
      baseInstructions,
      imagePaths,
      sessionThreadId,
      jsonlLogPath,
      onEvent,
    }) => {
      runCalls.push({
        codexBinPath,
        cwd,
        prompt,
        developerInstructions,
        baseInstructions,
        imagePaths,
        sessionThreadId,
        jsonlLogPath,
      });

      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent({
            kind: "thread",
            eventType: "thread.started",
            text: `Codex thread started: ${smokeThreadId}`,
            threadId: smokeThreadId,
          });
          await onEvent({
            kind: "agent_message",
            text: smokeReply,
            messagePhase: "final_answer",
          });

          return {
            backend: "exec-json",
            ok: true,
            exitCode: 0,
            signal: null,
            threadId: smokeThreadId,
            warnings: [],
          };
        })(),
      };
    },
  });

  const started = await workerPool.startPromptRun({
    session,
    prompt: smokePrompt,
    message: {
      message_id: 4301,
      message_thread_id: 4301,
    },
  });

  assert.equal(started.ok, true);
  await waitForRunToFinish(workerPool, session.session_key);

  const expectedJsonlLogPath = sessionStore.getExecJsonRunLogPath(
    session.chat_id,
    session.topic_id,
  );
  assert.equal(runCalls.length, 1);
  const [runCall] = runCalls;
  assert.equal(runCall.codexBinPath, "codex");
  assert.equal(runCall.cwd, "/srv/codex-workspace");
  assert.equal(runCall.prompt, smokePrompt);
  assert.deepEqual(runCall.imagePaths, []);
  assert.equal(runCall.sessionThreadId, null);
  assert.equal(runCall.jsonlLogPath, expectedJsonlLogPath);
  assert.match(runCall.developerInstructions, /^Context:/u);
  assert.match(
    runCall.developerInstructions,
    /Telegram topic 4301 \(-1001234567890:4301\)/u,
  );
  assert.equal(runCall.baseInstructions, runCall.developerInstructions);
  assert.equal(await fs.readFile(expectedJsonlLogPath, "utf8"), "");

  const reloaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(reloaded.last_run_backend, "exec-json");
  assert.equal(reloaded.last_run_status, "completed");
  assert.equal(reloaded.codex_thread_id, smokeThreadId);
  assert.equal(reloaded.last_agent_reply, smokeReply);
  assert.equal(reloaded.last_user_prompt, smokePrompt);
  assert.equal(serviceState.activeRunCount, 0);

  const exchangeLog = await sessionStore.loadExchangeLog(reloaded);
  assert.equal(exchangeLog.length, 1);
  assert.equal(exchangeLog[0].status, "completed");
  assert.equal(exchangeLog[0].user_prompt, smokePrompt);
  assert.equal(exchangeLog[0].assistant_reply, smokeReply);

  assert.equal(telegram.sentMessages[0]?.text, INITIAL_PROGRESS_TEXT);
  assert.equal(telegram.sentMessages.at(-1)?.text, smokeReply);
  assert.equal(telegram.sentMessages.at(-1)?.reply_to_message_id, 4301);
});
