import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GlobalCodexSettingsStore } from "../src/session-manager/global-codex-settings-store.js";
import { GlobalPromptSuffixStore } from "../src/session-manager/global-prompt-suffix-store.js";
import { SessionService } from "../src/session-manager/session-service.js";
import { SessionStore } from "../src/session-manager/session-store.js";

function buildBinding() {
  return {
    repo_root: "/workspace",
    cwd: "/workspace",
    branch: "main",
    worktree_path: "/workspace",
  };
}

test("SessionService purgeSession emits runtime lifecycle audit", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const lifecycleEvents = [];
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRoot: "/workspace",
      defaultSessionBindingPath: "/workspace",
    },
    runtimeObserver: {
      async noteSessionLifecycle(event) {
        lifecycleEvents.push(event);
      },
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 301,
    topicName: "Purge audit",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const purged = await service.purgeSession(session);
  assert.equal(purged.lifecycle_state, "purged");
  assert.equal(lifecycleEvents.length, 1);
  assert.equal(lifecycleEvents[0].action, "purged");
  assert.equal(lifecycleEvents[0].reason, "command/purge");
});

test("SessionService resolveContextSnapshot backfills rollout snapshot into session metadata", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const codexSessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-rollouts-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRoot: "/workspace",
      defaultSessionBindingPath: "/workspace",
      codexContextWindow: 290000,
      codexSessionsRoot,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 302,
    topicName: "Context snapshot",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const threadedSession = await sessionStore.patch(session, {
    codex_thread_id: "thread-context-1",
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "03", "23");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-03-23T23-14-18-thread-context-1.jsonl",
  );
  await fs.writeFile(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: "2026-03-23T23:14:18.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-1",
          model_context_window: 275500,
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-23T23:14:19.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 18220,
              cached_input_tokens: 5504,
              output_tokens: 42,
              reasoning_output_tokens: 30,
              total_tokens: 18262,
            },
            last_token_usage: {
              input_tokens: 18220,
              cached_input_tokens: 5504,
              output_tokens: 42,
              reasoning_output_tokens: 30,
              total_tokens: 18262,
            },
            model_context_window: 275500,
          },
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const resolved = await service.resolveContextSnapshot(threadedSession);
  assert.equal(resolved.snapshot.model_context_window, 275500);
  assert.deepEqual(resolved.snapshot.last_token_usage, {
    input_tokens: 18220,
    cached_input_tokens: 5504,
    output_tokens: 42,
    reasoning_tokens: 30,
    total_tokens: 18262,
  });

  const reloaded = await sessionStore.load(
    threadedSession.chat_id,
    threadedSession.topic_id,
  );
  assert.equal(reloaded.codex_rollout_path, rolloutPath);
  assert.deepEqual(reloaded.last_token_usage, {
    input_tokens: 18220,
    cached_input_tokens: 5504,
    output_tokens: 42,
    reasoning_tokens: 30,
    total_tokens: 18262,
  });
  assert.deepEqual(reloaded.last_context_snapshot, {
    captured_at: "2026-03-23T23:14:19.000Z",
    model_context_window: 275500,
    last_token_usage: {
      input_tokens: 18220,
      cached_input_tokens: 5504,
      output_tokens: 42,
      reasoning_tokens: 30,
      total_tokens: 18262,
    },
    rollout_path: rolloutPath,
  });
});

test("SessionService updatePromptSuffix and clearPromptSuffix persist topic-level prompt suffix state", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRoot: "/workspace",
      defaultSessionBindingPath: "/workspace",
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 303,
    topicName: "Prompt suffix",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const updated = await service.updatePromptSuffix(session, {
    text: "P.S.\nKeep it short.",
    enabled: true,
  });
  assert.equal(updated.prompt_suffix_enabled, true);
  assert.equal(updated.prompt_suffix_text, "P.S.\nKeep it short.");

  const cleared = await service.clearPromptSuffix(updated);
  assert.equal(cleared.prompt_suffix_enabled, false);
  assert.equal(cleared.prompt_suffix_text, null);
});

test("SessionService updatePromptSuffixTopicState persists topic suffix routing state", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRoot: "/workspace",
      defaultSessionBindingPath: "/workspace",
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 304,
    topicName: "Prompt suffix routing",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const disabled = await service.updatePromptSuffixTopicState(session, {
    enabled: false,
  });
  assert.equal(disabled.prompt_suffix_topic_enabled, false);

  const enabled = await service.updatePromptSuffixTopicState(disabled, {
    enabled: true,
  });
  assert.equal(enabled.prompt_suffix_topic_enabled, true);
});

test("SessionService updateGlobalPromptSuffix and clearGlobalPromptSuffix persist global prompt suffix state", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-settings-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const globalPromptSuffixStore = new GlobalPromptSuffixStore(settingsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRoot: "/workspace",
      defaultSessionBindingPath: "/workspace",
    },
    globalPromptSuffixStore,
  });

  const updated = await service.updateGlobalPromptSuffix({
    text: "P.S.\nKeep it short everywhere.",
    enabled: true,
  });
  assert.equal(updated.prompt_suffix_enabled, true);
  assert.equal(updated.prompt_suffix_text, "P.S.\nKeep it short everywhere.");

  const reloaded = await globalPromptSuffixStore.load({ force: true });
  assert.equal(reloaded.prompt_suffix_enabled, true);
  assert.equal(reloaded.prompt_suffix_text, "P.S.\nKeep it short everywhere.");

  const cleared = await service.clearGlobalPromptSuffix();
  assert.equal(cleared.prompt_suffix_enabled, false);
  assert.equal(cleared.prompt_suffix_text, null);
});

test("SessionService persists global and topic Codex runtime settings with topic precedence", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-settings-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(settingsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRoot: "/workspace",
      defaultSessionBindingPath: "/workspace",
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore,
  });

  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 306,
    topicName: "Codex runtime settings",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await service.updateGlobalCodexSetting("spike", "model", "gpt-5.4-mini");
  await service.updateGlobalCodexSetting("spike", "reasoning", "high");
  let profile = await service.resolveCodexRuntimeProfile(session, {
    target: "spike",
  });
  assert.equal(profile.model, "gpt-5.4-mini");
  assert.equal(profile.modelSource, "global");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.reasoningSource, "global");

  const overridden = await service.updateSessionCodexSetting(
    session,
    "spike",
    "model",
    "gpt-5.2",
  );
  profile = await service.resolveCodexRuntimeProfile(overridden, {
    target: "spike",
  });
  assert.equal(profile.model, "gpt-5.2");
  assert.equal(profile.modelSource, "topic");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.reasoningSource, "global");

  const cleared = await service.clearSessionCodexSetting(
    overridden,
    "spike",
    "model",
  );
  profile = await service.resolveCodexRuntimeProfile(cleared, {
    target: "spike",
  });
  assert.equal(profile.model, "gpt-5.4-mini");
  assert.equal(profile.modelSource, "global");
});

test("SessionService clamps inherited reasoning to a value supported by the resolved model", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-settings-"),
  );
  const codexConfigRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-config-"),
  );
  const codexConfigPath = path.join(codexConfigRoot, "config.toml");
  await fs.writeFile(codexConfigPath, 'model = "gpt-5.4"\n', "utf8");
  await fs.writeFile(
    path.join(codexConfigRoot, "models_cache.json"),
    `${JSON.stringify({
      models: [
        {
          slug: "gpt-5.4",
          display_name: "GPT-5.4",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
            { effort: "xhigh" },
          ],
        },
        {
          slug: "gpt-5.1-codex-mini",
          display_name: "GPT-5.1-Codex-Mini",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "medium" },
            { effort: "high" },
          ],
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const sessionStore = new SessionStore(sessionsRoot);
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(settingsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRoot: "/workspace",
      defaultSessionBindingPath: "/workspace",
      codexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "high",
    },
    globalCodexSettingsStore,
  });

  let session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 307,
    topicName: "Codex runtime compatibility",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  await service.updateGlobalCodexSetting("spike", "reasoning", "xhigh");
  session = await service.updateSessionCodexSetting(
    session,
    "spike",
    "model",
    "gpt-5.1-codex-mini",
  );

  const profile = await service.resolveCodexRuntimeProfile(session, {
    target: "spike",
  });
  assert.equal(profile.model, "gpt-5.1-codex-mini");
  assert.equal(profile.modelSource, "topic");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.reasoningSource, "default");
});

test("SessionService keeps Omni reasoning high by default while preserving explicit Omni overrides", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-settings-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(settingsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRoot: "/workspace",
      defaultSessionBindingPath: "/workspace",
      codexModel: "gpt-5.4",
      codexReasoningEffort: "xhigh",
    },
    globalCodexSettingsStore,
  });

  let session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 308,
    topicName: "Omni runtime defaults",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  let profile = await service.resolveCodexRuntimeProfile(session, {
    target: "omni",
  });
  assert.equal(profile.model, "gpt-5.4");
  assert.equal(profile.modelSource, "default");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.reasoningSource, "default");

  await service.updateGlobalCodexSetting("omni", "reasoning", "high");
  profile = await service.resolveCodexRuntimeProfile(session, {
    target: "omni",
  });
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.reasoningSource, "global");

  session = await service.updateSessionCodexSetting(
    session,
    "omni",
    "reasoning",
    "low",
  );
  profile = await service.resolveCodexRuntimeProfile(session, {
    target: "omni",
  });
  assert.equal(profile.reasoningEffort, "low");
  assert.equal(profile.reasoningSource, "topic");
});

test("SessionService scheduleAutoSleep ignores stale disabled snapshots and keeps active auto mode alive", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRoot: "/workspace",
      defaultSessionBindingPath: "/workspace",
    },
  });

  const staleSession = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 307,
    topicName: "Auto stale sleep",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  let liveSession = await service.activateAutoMode(staleSession, {
    activatedByUserId: "123456789",
    omniBotId: "222333444",
    spikeBotId: "333444555",
  });
  liveSession = await service.captureAutoGoal(liveSession, "Ship Omni auto mode safely.");
  liveSession = await service.captureAutoInitialPrompt(
    liveSession,
    "Initial Spike prompt",
  );
  liveSession = await service.markAutoDecision(liveSession, {
    phase: "running",
    resultSummary: "Still active",
  });

  const sleeping = await service.scheduleAutoSleep(staleSession, {
    sleepMinutes: 10,
    nextPrompt: "Keep monitoring the active proof line.",
    resultSummary: "Healthy run; wake later.",
  });

  assert.equal(sleeping.auto_mode.enabled, true);
  assert.equal(sleeping.auto_mode.phase, "sleeping");
  assert.equal(
    sleeping.auto_mode.sleep_next_prompt,
    "Keep monitoring the active proof line.",
  );
  assert.match(sleeping.auto_mode.sleep_until, /^\d{4}-\d{2}-\d{2}T/u);
});

test("SessionService markAutoDecision ignores stale disabled snapshots when recording done", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRoot: "/workspace",
      defaultSessionBindingPath: "/workspace",
    },
  });

  const staleSession = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 308,
    topicName: "Auto stale done",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  let liveSession = await service.activateAutoMode(staleSession, {
    activatedByUserId: "123456789",
    omniBotId: "222333444",
    spikeBotId: "333444555",
  });
  liveSession = await service.captureAutoGoal(liveSession, "Ship Omni auto mode safely.");
  liveSession = await service.captureAutoInitialPrompt(
    liveSession,
    "Initial Spike prompt",
  );

  const done = await service.markAutoDecision(staleSession, {
    phase: "done",
    resultSummary: "One bounded cycle is complete.",
    clearPendingUserInput: true,
  });

  assert.equal(done.auto_mode.enabled, true);
  assert.equal(done.auto_mode.phase, "done");
  assert.equal(done.auto_mode.last_result_summary, "One bounded cycle is complete.");
});

test("SessionService buffers and clears pending prompt attachments", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRoot: "/workspace",
      defaultSessionBindingPath: "/workspace",
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 305,
    topicName: "Pending attachments",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const buffered = await service.bufferPendingPromptAttachments(
    session,
    [
      {
        file_path: "/tmp/doc.txt",
        relative_path: "incoming/doc.txt",
        mime_type: "text/plain",
        size_bytes: 12,
        is_image: false,
      },
    ],
  );
  assert.equal(buffered.pending_prompt_attachments.length, 1);
  assert.ok(buffered.pending_prompt_attachments_expires_at);

  const pending = await service.getPendingPromptAttachments(buffered);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].file_path, "/tmp/doc.txt");

  const cleared = await service.clearPendingPromptAttachments(buffered);
  assert.deepEqual(cleared.pending_prompt_attachments, []);
  assert.equal(cleared.pending_prompt_attachments_expires_at, null);
});

test("SessionService keeps queued attachments separate from direct prompt attachments", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      workspaceRoot: "/workspace",
      defaultSessionBindingPath: "/workspace",
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 306,
    topicName: "Scoped pending attachments",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  const withPromptAttachment = await service.bufferPendingPromptAttachments(
    session,
    [{ file_path: "/tmp/direct.txt", is_image: false }],
  );
  const withQueuedAttachment = await service.bufferPendingPromptAttachments(
    withPromptAttachment,
    [{ file_path: "/tmp/queued.txt", is_image: false }],
    { scope: "queue" },
  );

  const promptPending = await service.getPendingPromptAttachments(withQueuedAttachment);
  const queuePending = await service.getPendingPromptAttachments(withQueuedAttachment, {
    scope: "queue",
  });
  assert.deepEqual(
    promptPending.map((entry) => entry.file_path),
    ["/tmp/direct.txt"],
  );
  assert.deepEqual(
    queuePending.map((entry) => entry.file_path),
    ["/tmp/queued.txt"],
  );

  const clearedQueue = await service.clearPendingPromptAttachments(withQueuedAttachment, {
    scope: "queue",
  });
  assert.equal(clearedQueue.pending_queue_attachments.length, 0);
  assert.equal(clearedQueue.pending_prompt_attachments.length, 1);
});
