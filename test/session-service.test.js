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
    repo_root: "/home/bloob/atlas",
    cwd: "/home/bloob/atlas",
    branch: "main",
    worktree_path: "/home/bloob/atlas",
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
    },
    runtimeObserver: {
      async noteSessionLifecycle(event) {
        lifecycleEvents.push(event);
      },
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1003577434463,
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

test("SessionService purgeSession does not mutate owner-held sessions before rejecting", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 303,
    topicName: "Owned purge reject",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const owned = await sessionStore.patch(session, {
    session_owner_generation_id: "spike-gen-1",
    session_owner_mode: "active",
  });

  await assert.rejects(
    service.purgeSession(owned),
    /still active and not purge-eligible/u,
  );

  const reloaded = await sessionStore.load(owned.chat_id, owned.topic_id);
  assert.equal(reloaded.lifecycle_state, "active");
  assert.equal(reloaded.session_owner_generation_id, "spike-gen-1");
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
      codexContextWindow: 290000,
      codexSessionsRoot,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 302,
    topicName: "Context snapshot",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const threadedSession = await sessionStore.patch(session, {
    provider_session_id: "session-context-1",
    codex_thread_id: "thread-context-1",
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "03", "23");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-03-23T23-14-18-session-context-1.jsonl",
  );
  await fs.writeFile(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: "2026-03-23T23:14:17.500Z",
        type: "session_meta",
        payload: {
          id: "session-context-1",
        },
      }),
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
  assert.equal(reloaded.provider_session_id, "session-context-1");
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
    session_id: "session-context-1",
    thread_id: "thread-context-1",
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

test("SessionService resolveContextSnapshot resolves rollout state from provider session id without stored thread id", async () => {
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
      codexContextWindow: 290000,
      codexSessionsRoot,
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 3021,
    topicName: "Provider-only context snapshot",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  const providerSession = await sessionStore.patch(session, {
    provider_session_id: "session-context-provider-only",
    codex_thread_id: null,
  });

  const rolloutDir = path.join(codexSessionsRoot, "2026", "03", "24");
  await fs.mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    "rollout-2026-03-24T10-00-00-session-context-provider-only.jsonl",
  );
  await fs.writeFile(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: "2026-03-24T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-context-provider-only",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          model_context_window: 199999,
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-24T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 11,
              cached_input_tokens: 2,
              output_tokens: 3,
              reasoning_output_tokens: 1,
              total_tokens: 14,
            },
            model_context_window: 199999,
          },
        },
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const resolved = await service.resolveContextSnapshot(providerSession);
  assert.equal(resolved.snapshot.session_id, "session-context-provider-only");
  assert.equal(resolved.snapshot.thread_id, null);
  assert.equal(resolved.snapshot.model_context_window, 199999);

  const reloaded = await sessionStore.load(
    providerSession.chat_id,
    providerSession.topic_id,
  );
  assert.equal(reloaded.codex_rollout_path, rolloutPath);
  assert.deepEqual(reloaded.last_context_snapshot, {
    captured_at: "2026-03-24T10:00:02.000Z",
    session_id: "session-context-provider-only",
    thread_id: null,
    model_context_window: 199999,
    last_token_usage: {
      input_tokens: 11,
      cached_input_tokens: 2,
      output_tokens: 3,
      reasoning_tokens: 1,
      total_tokens: 14,
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1003577434463,
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1003577434463,
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore,
  });

  const session = await sessionStore.ensure({
    chatId: -1003577434463,
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

test("SessionService resolves compact runtime settings from global defaults", async () => {
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore,
  });

  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 3061,
    topicName: "Compact runtime settings",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await service.updateGlobalCodexSetting("compact", "model", "gpt-5.4-mini");
  await service.updateGlobalCodexSetting("compact", "reasoning", "high");

  const profile = await service.resolveCodexRuntimeProfile(session, {
    target: "compact",
  });
  assert.equal(profile.model, "gpt-5.4-mini");
  assert.equal(profile.modelSource, "global");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.reasoningSource, "global");
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
      codexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "high",
    },
    globalCodexSettingsStore,
  });

  let session = await sessionStore.ensure({
    chatId: -1003577434463,
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

test("SessionService falls back from unavailable stored models to an available default", async () => {
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
          ],
        },
        {
          slug: "gpt-5.4-mini",
          display_name: "GPT-5.4-Mini",
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
      codexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore,
  });

  const session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 3071,
    topicName: "Unavailable model fallback",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await service.updateGlobalCodexSetting("compact", "model", "gpt-ghost");
  await service.updateGlobalCodexSetting("compact", "reasoning", "high");

  const profile = await service.resolveCodexRuntimeProfile(session, {
    target: "compact",
  });
  assert.equal(profile.model, "gpt-5.4");
  assert.equal(profile.modelSource, "default");
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.reasoningSource, "global");
});

test("SessionService clears stale global reasoning when the global model changes", async () => {
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
      codexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore,
  });

  let session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 308,
    topicName: "Compact runtime cleanup",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  await service.updateGlobalCodexSetting("compact", "reasoning", "xhigh");
  const cleanedSettings = await service.updateGlobalCodexSetting(
    "compact",
    "model",
    "gpt-5.1-codex-mini",
  );
  assert.equal(cleanedSettings.compact_model, "gpt-5.1-codex-mini");
  assert.equal(cleanedSettings.compact_reasoning_effort, null);

  const profile = await service.resolveCodexRuntimeProfile(session, {
    target: "compact",
  });
  assert.equal(profile.model, "gpt-5.1-codex-mini");
  assert.equal(profile.reasoningEffort, "medium");
  assert.equal(profile.reasoningSource, "default");
});

test("SessionService clears stale topic reasoning when the topic model changes", async () => {
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
      codexConfigPath,
      codexModel: "gpt-5.4",
      codexReasoningEffort: "medium",
    },
    globalCodexSettingsStore,
  });

  let session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 309,
    topicName: "Topic runtime cleanup",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  session = await service.updateSessionCodexSetting(
    session,
    "spike",
    "reasoning",
    "xhigh",
  );
  session = await service.updateSessionCodexSetting(
    session,
    "spike",
    "model",
    "gpt-5.1-codex-mini",
  );
  assert.equal(session.spike_model_override, "gpt-5.1-codex-mini");
  assert.equal(session.spike_reasoning_effort_override, null);

  const profile = await service.resolveCodexRuntimeProfile(session, {
    target: "spike",
  });
  assert.equal(profile.model, "gpt-5.1-codex-mini");
  assert.equal(profile.reasoningEffort, "medium");
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
      codexModel: "gpt-5.4",
      codexReasoningEffort: "xhigh",
    },
    globalCodexSettingsStore,
  });

  let session = await sessionStore.ensure({
    chatId: -1003577434463,
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
    },
  });

  const staleSession = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 307,
    topicName: "Auto stale sleep",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  let liveSession = await service.activateAutoMode(staleSession, {
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
    },
  });

  const staleSession = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 308,
    topicName: "Auto stale done",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  let liveSession = await service.activateAutoMode(staleSession, {
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
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

test("SessionService preserves overlapping auto-mode updates across concurrent callers", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
    },
  });

  let session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 309,
    topicName: "Auto overlap",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  session = await service.activateAutoMode(session, {
    activatedByUserId: "5825672398",
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
  });
  session = await service.captureAutoGoal(session, "Ship Omni auto mode safely.");
  session = await service.captureAutoInitialPrompt(
    session,
    "Initial Spike prompt",
  );
  session = await service.markAutoDecision(session, {
    phase: "running",
    resultSummary: "Still active",
  });

  const originalPatchWithCurrent = sessionStore.patchWithCurrent.bind(sessionStore);
  let firstPatchHeld = false;
  let enteredFirstPatch;
  const firstPatchEnteredPromise = new Promise((resolve) => {
    enteredFirstPatch = resolve;
  });
  let releaseFirstPatch;
  const releaseFirstPatchPromise = new Promise((resolve) => {
    releaseFirstPatch = resolve;
  });

  sessionStore.patchWithCurrent = async (meta, patch) => {
    if (firstPatchHeld) {
      return originalPatchWithCurrent(meta, patch);
    }

    firstPatchHeld = true;
    return originalPatchWithCurrent(meta, async (current) => {
      enteredFirstPatch();
      await releaseFirstPatchPromise;
      return typeof patch === "function"
        ? patch(current)
        : patch;
    });
  };

  try {
    const blockedPromise = service.markAutoDecision(session, {
      phase: "blocked",
      blockedReason: "Need fresh logs",
      resultSummary: "Waiting on operator input.",
    });
    await firstPatchEnteredPromise;

    let secondFinished = false;
    const inputPromise = service.queueAutoUserInput(
      session,
      "Upload the latest logs.",
    ).then((value) => {
      secondFinished = true;
      return value;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      secondFinished,
      false,
      "second auto-mode update should wait for the locked first mutation",
    );

    releaseFirstPatch();
    await Promise.all([blockedPromise, inputPromise]);
  } finally {
    sessionStore.patchWithCurrent = originalPatchWithCurrent;
  }

  const loaded = await sessionStore.load(session.chat_id, session.topic_id);
  assert.equal(loaded.auto_mode.enabled, true);
  assert.equal(loaded.auto_mode.phase, "blocked");
  assert.equal(loaded.auto_mode.blocked_reason, "Need fresh logs");
  assert.equal(loaded.auto_mode.pending_user_input, "Upload the latest logs.");
  assert.equal(
    loaded.auto_mode.last_result_summary,
    "Waiting on operator input.",
  );
});

test("SessionService buffers and clears pending prompt attachments", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1003577434463,
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
      atlasWorkspaceRoot: "/home/bloob/atlas",
      defaultSessionBindingPath: "/home/bloob/atlas",
    },
  });

  const session = await sessionStore.ensure({
    chatId: -1003577434463,
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
