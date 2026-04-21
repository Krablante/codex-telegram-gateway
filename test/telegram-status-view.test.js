import test from "node:test";
import assert from "node:assert/strict";

import { buildStatusMessage } from "../src/telegram/status-view.js";

function buildWindowedLimitsSummary(overrides = {}) {
  return {
    available: true,
    capturedAt: "2026-04-04T13:10:00.000Z",
    source: "windows_rtx",
    planType: null,
    limitName: "codex",
    unlimited: false,
    windows: [
      {
        label: "5h",
        usedPercent: 11,
        remainingPercent: 89,
        windowMinutes: 300,
        resetsAt: 1775277000,
        resetsAtIso: "2026-04-03T03:10:00.000Z",
      },
      {
        label: "7d",
        usedPercent: 33,
        remainingPercent: 67,
        windowMinutes: 10080,
        resetsAt: 1775881800,
        resetsAtIso: "2026-04-10T03:10:00.000Z",
      },
    ],
    primary: {
      label: "5h",
      usedPercent: 11,
      remainingPercent: 89,
      windowMinutes: 300,
      resetsAt: 1775277000,
      resetsAtIso: "2026-04-03T03:10:00.000Z",
    },
    secondary: {
      label: "7d",
      usedPercent: 33,
      remainingPercent: 67,
      windowMinutes: 10080,
      resetsAt: 1775881800,
      resetsAtIso: "2026-04-10T03:10:00.000Z",
    },
    ...overrides,
  };
}

test("buildStatusMessage reports session state, binding, and run state", () => {
  const text = buildStatusMessage(
    {
      codexModel: "gpt-5.4",
      codexReasoningEffort: "xhigh",
      codexContextWindow: 320000,
      codexAutoCompactTokenLimit: 300000,
    },
    {
      chat: { id: -1003577434463 },
      message_thread_id: 7,
    },
    {
      session_key: "-1003577434463:7",
      topic_name: "Test topic 1",
      lifecycle_state: "active",
      codex_thread_id: "thread-1",
      last_run_status: "running",
      last_run_started_at: "2026-03-22T12:01:00.000Z",
      last_run_finished_at: null,
      last_token_usage: {
        input_tokens: 227200,
        cached_input_tokens: 180000,
        output_tokens: 1200,
        reasoning_tokens: 800,
        total_tokens: 228400,
      },
      workspace_binding: {
        repo_root: "/home/bloob/atlas",
        cwd: "/home/bloob/atlas",
        branch: "main",
        worktree_path: "/home/bloob/atlas",
      },
    },
    {
      state: {
        status: "running",
        threadId: "thread-1",
      },
    },
    null,
    null,
    "rus",
    buildWindowedLimitsSummary(),
  );

  assert.match(text, /тема: Test topic 1/u);
  assert.match(text, /run: running/u);
  assert.match(text, /папка: \/home\/bloob\/atlas/u);
  assert.match(text, /модель: gpt-5\.4/u);
  assert.match(text, /reasoning: Extra High \(xhigh\)/u);
  assert.match(text, /context window: 320000/u);
  assert.match(text, /язык: RUS/u);
  assert.match(text, /использование контекста: 71\.4%/u);
  assert.match(text, /токены контекста: 228400 \/ 320000/u);
  assert.match(text, /доступно токенов: 91600/u);
  assert.match(text, /вход\/кэш\/выход: 227200 \/ 180000 \/ 1200/u);
  assert.match(text, /reasoning tokens: 800/u);
  assert.match(text, /лимиты 5h: 89% осталось/u);
});

test("buildStatusMessage hides Omni lines when Omni is globally disabled", () => {
  const text = buildStatusMessage(
    {
      omniEnabled: false,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "xhigh",
      codexContextWindow: 320000,
      codexAutoCompactTokenLimit: 300000,
    },
    {
      chat: { id: -1003577434463 },
      message_thread_id: 7,
    },
    {
      session_key: "-1003577434463:7",
      topic_name: "Test topic 1",
      lifecycle_state: "active",
      last_run_status: "idle",
      workspace_binding: {
        repo_root: "/home/bloob/atlas",
        cwd: "/home/bloob/atlas",
        branch: "main",
        worktree_path: "/home/bloob/atlas",
      },
    },
    null,
  );

  assert.doesNotMatch(text, /omni model/u);
  assert.doesNotMatch(text, /omni reasoning/u);
});

test("buildStatusMessage prefers rollout context snapshot over static config", () => {
  const text = buildStatusMessage(
    {
      codexModel: "gpt-5.4",
      codexReasoningEffort: "xhigh",
      codexContextWindow: 320000,
      codexAutoCompactTokenLimit: 300000,
    },
    {
      chat: { id: -1003577434463 },
      message_thread_id: 7,
    },
    {
      session_key: "-1003577434463:7",
      topic_name: "Test topic 2",
      lifecycle_state: "active",
      codex_thread_id: "thread-2",
      last_run_status: "completed",
      last_token_usage: null,
      workspace_binding: {
        repo_root: "/home/bloob/atlas",
        cwd: "/home/bloob/atlas",
        branch: "main",
        worktree_path: "/home/bloob/atlas",
      },
    },
    null,
    {
      captured_at: "2026-03-23T23:14:19.000Z",
      model_context_window: 275500,
      last_token_usage: {
        input_tokens: 18220,
        cached_input_tokens: 5504,
        output_tokens: 42,
        reasoning_tokens: 30,
        total_tokens: 18262,
      },
      rollout_path:
        "/home/bloob/.codex/sessions/2026/03/23/rollout-2026-03-23T23-14-18-thread-2.jsonl",
    },
  );

  assert.match(text, /context window: 275500/u);
  assert.match(text, /язык: RUS/u);
  assert.match(text, /omni model: gpt-5\.4/u);
  assert.match(text, /использование контекста: 6\.6%/u);
  assert.match(text, /токены контекста: 18262 \/ 275500/u);
  assert.match(text, /доступно токенов: 257238/u);
  assert.match(text, /вход\/кэш\/выход: 18220 \/ 5504 \/ 42/u);
  assert.match(text, /reasoning tokens: 30/u);
});

test("buildStatusMessage can show configured limits separately from effective rollout window", () => {
  const text = buildStatusMessage(
    {
      codexModel: "gpt-5.4",
      codexReasoningEffort: "xhigh",
      codexContextWindow: 290000,
      codexAutoCompactTokenLimit: 270000,
    },
    {
      chat: { id: -1003577434463 },
      message_thread_id: 7,
    },
    {
      session_key: "-1003577434463:7",
      topic_name: "Configured vs effective",
      lifecycle_state: "active",
      codex_thread_id: "thread-3",
      last_run_status: "running",
      workspace_binding: {
        repo_root: "/home/bloob/atlas",
        cwd: "/home/bloob/atlas",
        branch: "main",
        worktree_path: "/home/bloob/atlas",
      },
    },
    null,
    {
      captured_at: "2026-04-21T12:00:00.000Z",
      model_context_window: 332500,
      last_token_usage: {
        input_tokens: 154531,
        cached_input_tokens: 154240,
        output_tokens: 60,
        reasoning_tokens: 0,
        total_tokens: 154591,
      },
    },
    null,
    "rus",
    buildWindowedLimitsSummary({ unlimited: true }),
    {
      contextWindow: 350000,
      autoCompactTokenLimit: 335000,
    },
  );

  assert.match(text, /context window: 350000/u);
  assert.match(text, /auto-compact: 335000/u);
  assert.match(text, /effective context window: 332500/u);
  assert.match(text, /токены контекста: 154591 \/ 332500/u);
});
