import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionCompactor } from "../src/session-manager/session-compactor.js";
import { SessionStore } from "../src/session-manager/session-store.js";

async function makeStore() {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  return new SessionStore(sessionsRoot);
}

function buildBinding() {
  return {
    repo_root: "/home/example/workspace",
    cwd: "/home/example/workspace",
    branch: "main",
    worktree_path: "/home/example/workspace",
  };
}

test("SessionCompactor builds active brief from exchange log via Codex summarizer", async () => {
  const sessionStore = await makeStore();
  const runCalls = [];
  const compactor = new SessionCompactor({
    sessionStore,
    config: {
      codexBinPath: "codex",
    },
    runTask: ({
      prompt,
      onEvent,
      appServerBootTimeoutMs,
      rolloutDiscoveryTimeoutMs,
      rolloutStallAfterChildExitMs,
    }) => {
      runCalls.push({
        prompt,
        appServerBootTimeoutMs,
        rolloutDiscoveryTimeoutMs,
        rolloutStallAfterChildExitMs,
      });
      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent({
            kind: "agent_message",
            text: [
              "# Active brief",
              "",
              "updated_from_reason: command/compact",
              "session_key: -1001234567890:101",
              "cwd: /home/example/workspace",
              "",
              "## User preferences",
              "- concise",
              "",
              "## Completed work",
              "- Built sentinel flow.",
              "",
              "## Open work",
              "- None.",
              "",
              "## Latest exchange",
              "- User asked about sentinel.",
            ].join("\n"),
          });
          return {
            exitCode: 0,
            signal: null,
            threadId: "compact-thread",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 101,
    topicName: "Compact test",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const withRun = await sessionStore.patch(session, {
    codex_thread_id: "thread-before-compact",
    codex_rollout_path:
      "/home/bloob/.codex/sessions/2026/03/22/rollout-before-compact.jsonl",
    last_user_prompt: "Inspect compact state",
    last_agent_reply: "Workspace is clean and ready.",
    last_run_status: "completed",
    last_run_started_at: "2026-03-22T12:00:00.000Z",
    last_run_finished_at: "2026-03-22T12:01:00.000Z",
    last_token_usage: {
      input_tokens: 120000,
      cached_input_tokens: 30000,
      output_tokens: 400,
      reasoning_tokens: 50,
      total_tokens: 120450,
    },
    last_context_snapshot: {
      captured_at: "2026-03-22T12:01:00.000Z",
      model_context_window: 275500,
      last_token_usage: {
        input_tokens: 120000,
        cached_input_tokens: 30000,
        output_tokens: 400,
        reasoning_tokens: 50,
        total_tokens: 120450,
      },
      rollout_path:
        "/home/bloob/.codex/sessions/2026/03/22/rollout-before-compact.jsonl",
    },
    parked_reason: "telegram/forum-topic-closed",
    lifecycle_state: "parked",
  });
  await sessionStore.appendExchangeLogEntry(withRun, {
    created_at: "2026-03-22T12:01:00.000Z",
    status: "completed",
    user_prompt: "Inspect compact state",
    assistant_reply: "Workspace is clean and ready.",
  });
  await sessionStore.writeArtifact(withRun, {
    kind: "diff",
    extension: "txt",
    content: "diff artifact",
  });
  await sessionStore.writeSessionText(withRun, "raw-log.ndjson", "{\"type\":\"run.started\"}\n");
  await sessionStore.writeSessionJson(withRun, "task-ledger.json", {
    schema_version: 1,
    runs: [],
  });
  await sessionStore.writeSessionJson(withRun, "pinned-facts.json", {
    schema_version: 1,
    facts: [],
  });

  const compacted = await compactor.compact(withRun, {
    reason: "command/compact",
  });

  assert.equal(compacted.reason, "command/compact");
  assert.equal(compacted.exchangeLogEntries, 1);
  assert.equal(compacted.generatedWithCodex, true);
  assert.equal(runCalls.length, 1);
  assert.match(runCalls[0].prompt, /The exchange log file contains only user prompts and final agent replies/u);
  assert.match(
    runCalls[0].prompt,
    /Write a dense but readable markdown brief that lets a fresh Codex run continue work without rereading the full exchange log\./u,
  );
  assert.match(runCalls[0].prompt, /## Workspace context/u);
  assert.match(runCalls[0].prompt, /## Current state/u);
  assert.match(
    runCalls[0].prompt,
    /Latest exchange: capture the latest user ask and the latest assistant outcome in concrete terms\./u,
  );
  assert.match(
    runCalls[0].prompt,
    new RegExp(sessionStore.getExchangeLogPath(withRun.chat_id, withRun.topic_id)),
  );
  assert.doesNotMatch(runCalls[0].prompt, /Inspect compact state/u);
  assert.doesNotMatch(runCalls[0].prompt, /Workspace is clean and ready/u);
  assert.equal(runCalls[0].appServerBootTimeoutMs, 60000);
  assert.equal(runCalls[0].rolloutDiscoveryTimeoutMs, 30000);
  assert.equal(runCalls[0].rolloutStallAfterChildExitMs, 30000);

  const briefText = await fs.readFile(
    sessionStore.getActiveBriefPath(withRun.chat_id, withRun.topic_id),
    "utf8",
  );

  assert.match(briefText, /# Active brief/u);
  assert.match(briefText, /Built sentinel flow/u);
  await assert.rejects(
    fs.access(path.join(sessionStore.getSessionDir(withRun.chat_id, withRun.topic_id), "raw-log.ndjson")),
  );
  await assert.rejects(
    fs.access(path.join(sessionStore.getSessionDir(withRun.chat_id, withRun.topic_id), "task-ledger.json")),
  );
  await assert.rejects(
    fs.access(path.join(sessionStore.getSessionDir(withRun.chat_id, withRun.topic_id), "pinned-facts.json")),
  );

  const updated = await sessionStore.load(withRun.chat_id, withRun.topic_id);
  assert.equal(updated.last_compaction_reason, "command/compact");
  assert.equal(updated.exchange_log_entries, 1);
  assert.equal(updated.codex_thread_id, null);
  assert.equal(updated.codex_rollout_path, null);
  assert.equal(updated.last_context_snapshot, null);
  assert.equal(updated.last_token_usage, null);
});

test("SessionCompactor writes a stub brief when exchange log is empty", async () => {
  const sessionStore = await makeStore();
  const compactor = new SessionCompactor({
    sessionStore,
    config: {
      codexBinPath: "codex",
    },
  });
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 103,
    topicName: "Empty compact test",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const compacted = await compactor.compact(session, {
    reason: "command/compact",
  });
  const briefText = await fs.readFile(
    sessionStore.getActiveBriefPath(session.chat_id, session.topic_id),
    "utf8",
  );

  assert.equal(compacted.exchangeLogEntries, 0);
  assert.equal(compacted.generatedWithCodex, false);
  assert.match(briefText, /No exchange log entries yet/u);
  const updated = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(updated.codex_thread_id, null);
  assert.equal(updated.codex_rollout_path, null);
  assert.equal(updated.last_context_snapshot, null);
  assert.equal(updated.last_token_usage, null);
});

test("SessionCompactor retries the temporary Codex summarizer once before failing", async () => {
  const sessionStore = await makeStore();
  const runCalls = [];
  const compactor = new SessionCompactor({
    sessionStore,
    config: {
      codexBinPath: "codex",
    },
    runTask: ({ onEvent }) => {
      runCalls.push("attempt");
      if (runCalls.length === 1) {
        return {
          child: { kill() {} },
          finished: Promise.resolve({
            exitCode: 1,
            signal: null,
            threadId: "compact-thread-1",
            warnings: [],
            resumeReplacement: null,
          }),
        };
      }

      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent({
            kind: "agent_message",
            text: [
              "# Active brief",
              "",
              "updated_from_reason: resume-fallback:stale-thread",
              "session_key: -1001234567890:104",
              "cwd: /home/example/workspace",
              "",
              "## User preferences",
              "- concise",
              "",
              "## Completed work",
              "- Retry succeeded.",
              "",
              "## Open work",
              "- Continue.",
              "",
              "## Latest exchange",
              "- User asked for retry protection.",
            ].join("\n"),
          });
          return {
            exitCode: 0,
            signal: null,
            threadId: "compact-thread-2",
            warnings: [],
            resumeReplacement: null,
          };
        })(),
      };
    },
  });
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 104,
    topicName: "Retry compact test",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await sessionStore.appendExchangeLogEntry(session, {
    created_at: "2026-03-24T09:20:00.000Z",
    status: "completed",
    user_prompt: "Remember retry protection",
    assistant_reply: "Retry protection noted.",
  });

  const compacted = await compactor.compact(session, {
    reason: "resume-fallback:stale-thread",
  });
  const briefText = await fs.readFile(
    sessionStore.getActiveBriefPath(session.chat_id, session.topic_id),
    "utf8",
  );

  assert.equal(runCalls.length, 2);
  assert.equal(compacted.exchangeLogEntries, 1);
  assert.match(briefText, /Retry succeeded/u);
});

test("SessionCompactor skips purged sessions", async () => {
  const sessionStore = await makeStore();
  const compactor = new SessionCompactor({
    sessionStore,
    config: {
      codexBinPath: "codex",
    },
  });
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 102,
    topicName: "Purged compact test",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await sessionStore.appendExchangeLogEntry(session, {
    created_at: "2026-03-22T12:00:01.000Z",
    status: "completed",
    user_prompt: "hello",
    assistant_reply: "hello",
  });
  const purged = await sessionStore.purge(session, "test/purge");
  const compacted = await compactor.compact(purged, {
    reason: "command/compact",
  });

  assert.equal(compacted.skipped, "purged");
  await assert.rejects(
    fs.access(sessionStore.getActiveBriefPath(session.chat_id, session.topic_id)),
  );
});

test("SessionCompactor fails loudly on malformed exchange logs instead of compacting empty history", async () => {
  const sessionStore = await makeStore();
  const compactor = new SessionCompactor({
    sessionStore,
    config: {
      codexBinPath: "codex",
    },
  });
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 105,
    topicName: "Corrupt compact test",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await sessionStore.writeSessionText(session, "exchange-log.jsonl", "{\n");

  await assert.rejects(
    compactor.compact(session, { reason: "command/compact" }),
    /Malformed exchange log/u,
  );
  await assert.rejects(
    fs.access(sessionStore.getActiveBriefPath(session.chat_id, session.topic_id)),
  );
});
