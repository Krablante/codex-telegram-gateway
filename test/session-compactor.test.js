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
    repo_root: "/home/bloob/atlas",
    cwd: "/home/bloob/atlas",
    branch: "main",
    worktree_path: "/home/bloob/atlas",
  };
}

function escapeForRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
              "session_key: -1003577434463:101",
              "cwd: /home/bloob/atlas",
              "",
              "## Active rules",
              "- Send finished APKs through the user's Telegram account into Saved Messages when explicitly requested.",
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
    chatId: -1003577434463,
    topicId: 101,
    topicName: "Compact test",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const withRun = await sessionStore.patch(session, {
    provider_session_id: "provider-before-compact",
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
  assert.match(runCalls[0].prompt, /## Active rules/u);
  assert.match(runCalls[0].prompt, /## Current state/u);
  assert.match(
    runCalls[0].prompt,
    /Latest exchange: capture the latest user ask and the latest assistant outcome in concrete terms\./u,
  );
  assert.match(
    runCalls[0].prompt,
    /Do not lose explicit user-specific rules that are still active just because they appeared only once earlier in the log\./u,
  );
  assert.match(
    runCalls[0].prompt,
    /Preserve concrete delivery, routing, account-usage, artifact-destination, and output-format instructions whenever they are still current\./u,
  );
  assert.match(
    runCalls[0].prompt,
    new RegExp(
      escapeForRegExp(
        sessionStore.getExchangeLogPath(withRun.chat_id, withRun.topic_id),
      ),
      "u",
    ),
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
  assert.match(
    briefText,
    /Send finished APKs through the user's Telegram account into Saved Messages/u,
  );
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
  assert.equal(updated.provider_session_id, null);
  assert.equal(updated.codex_thread_id, null);
  assert.equal(updated.codex_rollout_path, null);
  assert.equal(updated.last_context_snapshot, null);
  assert.equal(updated.last_token_usage, null);
});

test("SessionCompactor uses the global compact runtime profile for the summarizer", async () => {
  const sessionStore = await makeStore();
  const runCalls = [];
  const compactor = new SessionCompactor({
    sessionStore,
    config: {
      codexBinPath: "codex",
      codexConfigPath: "/tmp/codex-telegram-gateway-tests-missing-config.toml",
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore: {
      async load() {
        return {
          schema_version: 1,
          updated_at: null,
          spike_model: null,
          spike_reasoning_effort: null,
          omni_model: null,
          omni_reasoning_effort: null,
          compact_model: "gpt-5.4-mini",
          compact_reasoning_effort: "high",
        };
      },
    },
    runTask: ({ model, reasoningEffort, onEvent }) => {
      runCalls.push({ model, reasoningEffort });
      return {
        child: { kill() {} },
        finished: (async () => {
          await onEvent({
            kind: "agent_message",
            text: [
              "# Active brief",
              "",
              "updated_from_reason: command/compact",
              "session_key: -1003577434463:106",
              "cwd: /home/bloob/atlas",
              "",
              "## Completed work",
              "- Applied compact profile.",
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
    chatId: -1003577434463,
    topicId: 106,
    topicName: "Compact profile test",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await sessionStore.appendExchangeLogEntry(session, {
    created_at: "2026-04-07T15:00:00.000Z",
    status: "completed",
    user_prompt: "Refresh the brief",
    assistant_reply: "The brief is refreshed.",
  });

  await compactor.compact(session, {
    reason: "command/compact",
  });

  assert.equal(runCalls.length, 1);
  assert.equal(runCalls[0].model, "gpt-5.4-mini");
  assert.equal(runCalls[0].reasoningEffort, "high");
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
    chatId: -1003577434463,
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
  assert.match(briefText, /## Active rules/u);
  assert.match(briefText, /No exchange log entries yet/u);
  const updated = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(updated.provider_session_id, null);
  assert.equal(updated.codex_thread_id, null);
  assert.equal(updated.codex_rollout_path, null);
  assert.equal(updated.last_context_snapshot, null);
  assert.equal(updated.last_token_usage, null);
});

test("SessionCompactor does not invent an active-rules placeholder when the summarizer omits that section", async () => {
  const sessionStore = await makeStore();
  const compactor = new SessionCompactor({
    sessionStore,
    config: {
      codexBinPath: "codex",
    },
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent({
          kind: "agent_message",
          text: [
            "# Active brief",
            "",
            "updated_from_reason: command/compact",
            "session_key: -1003577434463:107",
            "cwd: /home/bloob/atlas",
            "",
            "## User preferences",
            "- concise",
            "",
            "## Current state",
            "- Ready for a fresh continuation.",
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
    }),
  });
  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 107,
    topicName: "Missing active rules compact test",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await sessionStore.appendExchangeLogEntry(session, {
    created_at: "2026-04-18T16:30:00.000Z",
    status: "completed",
    user_prompt: "Keep my delivery rule in the next chat.",
    assistant_reply: "Delivery rule noted.",
  });

  await compactor.compact(session, {
    reason: "command/compact",
  });

  const briefText = await fs.readFile(
    sessionStore.getActiveBriefPath(session.chat_id, session.topic_id),
    "utf8",
  );

  assert.doesNotMatch(briefText, /## Active rules/u);
  assert.doesNotMatch(briefText, /No active user-specific rules captured yet/u);
});

test("SessionCompactor resets Omni auto-compact counters but preserves active auto mode", async () => {
  const sessionStore = await makeStore();
  const compactor = new SessionCompactor({
    sessionStore,
    config: {
      codexBinPath: "codex",
    },
    runTask: ({ onEvent }) => ({
      child: { kill() {} },
      finished: (async () => {
        await onEvent({
          kind: "agent_message",
          text: [
            "# Active brief",
            "",
            "updated_from_reason: auto-compact:omni-cycle-boundary",
            "session_key: -1003577434463:105",
            "cwd: /home/bloob/atlas",
            "",
            "## Open work",
            "- Continue the Omni loop.",
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
    }),
  });
  let session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 105,
    topicName: "Auto compact state test",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  session = await sessionStore.patch(session, {
    auto_mode: {
      enabled: true,
      phase: "running",
      omni_bot_id: "8603043042",
      spike_bot_id: "8537834861",
      continuation_count_since_compact: 33,
      first_omni_prompt_at: "2026-04-03T10:00:00.000Z",
    },
  });
  await sessionStore.appendExchangeLogEntry(session, {
    created_at: "2026-04-03T18:00:00.000Z",
    status: "completed",
    user_prompt: "Continue the Omni loop",
    assistant_reply: "The next move is ready.",
  });

  const compacted = await compactor.compact(session, {
    reason: "auto-compact:omni-cycle-boundary",
  });

  assert.equal(compacted.reason, "auto-compact:omni-cycle-boundary");
  const updated = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(updated.auto_mode.phase, "running");
  assert.equal(updated.auto_mode.continuation_count_since_compact, 0);
  assert.equal(
    updated.auto_mode.last_auto_compact_at,
    updated.last_compacted_at,
  );
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
              "session_key: -1003577434463:104",
              "cwd: /home/bloob/atlas",
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
    chatId: -1003577434463,
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
    chatId: -1003577434463,
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
  const parked = await sessionStore.park(session, "test/purge");
  const purged = await sessionStore.purge(parked, "test/purge");
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
    chatId: -1003577434463,
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
