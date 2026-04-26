import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRunFailureText,
  buildProgressText,
  buildThreadDeveloperInstructions,
  isCodexThreadCorruptionError,
  isContextWindowExceededText,
  isTransientModelCapacityError,
} from "../src/pty-worker/worker-pool-common.js";

function buildSession(overrides = {}) {
  return {
    session_key: "-1001234567890:2203",
    chat_id: "-1001234567890",
    topic_id: "2203",
    topic_name: "codex-telegram",
    execution_host_id: "controller",
    workspace_binding: {
      workspace_root: "/srv/codex-workspace",
      cwd: "/srv/codex-workspace",
      worktree_path: "/srv/codex-workspace",
    },
    ...overrides,
  };
}

test("buildProgressText keeps meaningful commentary visible", () => {
  const text = buildProgressText({
    status: "running",
    latestProgressMessage: "Сначала сверяю фактический lifecycle run, потом чиню точечный race.",
  }, "rus");

  assert.match(text, /Сначала сверяю фактический lifecycle run/u);
  assert.match(text, /\n\n\.\.\.$/u);
});

test("buildProgressText ignores internal orchestration leakage and keeps the last visible thought", () => {
  const rusText = buildProgressText({
    status: "running",
    latestProgressMessage: "Запускаю сабагента для проверки репозитория.",
    latestSummaryKind: "agent_message",
    latestSummary: "Сначала сверяю фактический lifecycle run, потом чиню race в финализации.",
  }, "rus");
  assert.match(rusText, /Сначала сверяю фактический lifecycle run/u);
  assert.doesNotMatch(rusText, /сабагента/u);

  const engText = buildProgressText({
    status: "running",
    latestProgressMessage: "Spawning a subagent to inspect the repo before I continue.",
    latestSummaryKind: "agent_message",
    latestSummary: "First I will verify the real lifecycle path, then patch the stale owner handoff.",
  }, "eng");
  assert.match(engText, /First I will verify the real lifecycle path/u);
  assert.doesNotMatch(engText, /subagent|inspect the repo/u);
});

test("buildProgressText falls back to a bare spinner when internal leakage is all that remains", () => {
  const text = buildProgressText({
    status: "running",
    latestProgressMessage: "Spawning a subagent to inspect the repo before I continue.",
    latestSummaryKind: "agent_message",
    latestSummary: "Spawning a subagent to inspect the repo before I continue.",
  }, "eng");

  assert.equal(text, "...");
});

test("buildProgressText keeps generic natural-language progress visible", () => {
  const text = buildProgressText({
    status: "running",
    latestProgressMessage: "Анализирую код и текущее состояние.",
    latestSummaryKind: "agent_message",
    latestSummary: "Анализирую код и текущее состояние.",
  }, "rus");

  assert.match(text, /Анализирую код и текущее состояние/u);
  assert.match(text, /\n\n\.\.\.$/u);
});

test("buildProgressText keeps a long silent run on a bare spinner", () => {
  const text = buildProgressText({
    status: "running",
    startedAtMs: Date.now() - 20_000,
  }, "rus");

  assert.equal(text, "...");
});

test("buildProgressText keeps startup on a bare spinner", () => {
  const text = buildProgressText({
    status: "starting",
  }, "rus");

  assert.equal(text, "...");
});

test("buildProgressText hides internal live-steer restart labels", () => {
  const text = buildProgressText({
    status: "running",
    latestSummaryKind: "rebuild",
    latestSummary: "live-steer-restart",
  }, "eng");

  assert.equal(text, "...");
  assert.doesNotMatch(text, /live-steer-restart/u);
});

test("buildProgressText keeps the previous thought while live steer rebuilds", () => {
  const text = buildProgressText({
    status: "rebuilding",
    resumeMode: "live-steer-restart",
    threadId: "thread-1",
    holdProgressUntilNaturalUpdate: true,
    latestProgressMessage: "Сохраняю эту мысль до следующего события Codex.",
    latestSummaryKind: "rebuild",
    latestSummary: "live-steer-restart",
  }, "rus");

  assert.match(text, /Сохраняю эту мысль/u);
  assert.doesNotMatch(text, /Продолжаю тот же Codex thread/u);
  assert.doesNotMatch(text, /live-steer-restart/u);
});

test("buildRunFailureText does not present graceful code 0 exit as a crash", () => {
  const text = buildRunFailureText({
    exitCode: 0,
    signal: null,
    warnings: [],
  }, "rus");

  assert.match(text, /Codex app-server ended without a final reply/u);
  assert.doesNotMatch(text, /exited with code 0/u);
});

test("buildRunFailureText keeps raw exec stderr out of user-visible failures", () => {
  const text = buildRunFailureText({
    backend: "exec-json",
    exitCode: 1,
    signal: null,
    abortReason: "exec_stream_incomplete",
    warnings: [
      "codex exec stderr:\nsecret-ish runtime detail",
    ],
  }, "eng");

  assert.match(text, /Codex turn aborted \(exec_stream_incomplete\)/u);
  assert.doesNotMatch(text, /secret-ish runtime detail/u);
  assert.doesNotMatch(text, /codex exec stderr/u);
});

test("buildThreadDeveloperInstructions appends the effective topic work style", () => {
  const instructions = buildThreadDeveloperInstructions(
    buildSession({
      prompt_suffix_enabled: true,
      prompt_suffix_text: "TOPIC\nKeep it short in this thread.",
    }),
    {
      getTopicContextPath() {
        return "/srv/codex-workspace/state/codex-telegram-gateway/sessions/-1001234567890/2203/telegram-topic-context.md";
      },
    },
    {
      globalPromptSuffix: {
        prompt_suffix_enabled: true,
        prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
      },
    },
  );

  assert.match(instructions, /Context:/u);
  assert.match(instructions, /You are operating inside Telegram topic 2203/u);
  assert.match(instructions, /Runtime:\n- bound host: controller/u);
  assert.match(instructions, /do not silently rebind/u);
  assert.match(instructions, /Telegram delivery:\n- keep Telegram as the delivery surface/u);
  assert.match(instructions, /Extra context:/u);
  assert.match(instructions, /\n\nWork Style:\nTOPIC\nKeep it short in this thread\./u);
  assert.doesNotMatch(instructions, /GLOBAL/u);
});

test("buildThreadDeveloperInstructions suppresses work style when topic suffix routing is off", () => {
  const instructions = buildThreadDeveloperInstructions(
    buildSession({
      prompt_suffix_topic_enabled: false,
      prompt_suffix_enabled: true,
      prompt_suffix_text: "TOPIC\nKeep it short in this thread.",
    }),
    {
      getTopicContextPath() {
        return "/srv/codex-workspace/state/codex-telegram-gateway/sessions/-1001234567890/2203/telegram-topic-context.md";
      },
    },
    {
      globalPromptSuffix: {
        prompt_suffix_enabled: true,
        prompt_suffix_text: "GLOBAL\nNever overcomplicate.",
      },
    },
  );

  assert.doesNotMatch(instructions, /Work Style:/u);
  assert.doesNotMatch(instructions, /Never overcomplicate/u);
});


test("isTransientModelCapacityError matches upstream model-capacity errors", () => {
  assert.equal(
    isTransientModelCapacityError(
      new Error("Selected model is at capacity. Please try a different model."),
    ),
    true,
  );
  assert.equal(isTransientModelCapacityError(new Error("permission denied")), false);
});

test("isContextWindowExceededText matches known upstream context-window failures", () => {
  assert.equal(
    isContextWindowExceededText(
      "Codex ran out of room in the model's context window. Start a new thread.",
    ),
    true,
  );
  assert.equal(
    isContextWindowExceededText("400 context_length_exceeded: input too large"),
    true,
  );
  assert.equal(
    isContextWindowExceededText("The request exceeds the token limit for this model."),
    true,
  );
  assert.equal(isContextWindowExceededText("Selected model is at capacity."), false);
});

test("isCodexThreadCorruptionError matches orphan tool-output failures", () => {
  assert.equal(
    isCodexThreadCorruptionError(
      `Codex exec failed: {
        "error": {
          "type": "invalid_request_error",
          "message": "No tool call found for function call output with call_id call_123."
        },
        "status": 400
      }`,
    ),
    true,
  );
  assert.equal(isCodexThreadCorruptionError("Selected model is at capacity."), false);
});
