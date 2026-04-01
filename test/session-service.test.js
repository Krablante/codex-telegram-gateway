import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GlobalPromptSuffixStore } from "../src/session-manager/global-prompt-suffix-store.js";
import { SessionService } from "../src/session-manager/session-service.js";
import { SessionStore } from "../src/session-manager/session-store.js";

function buildBinding() {
  return {
    repo_root: "/home/example/workspace",
    cwd: "/home/example/workspace",
    branch: "main",
    worktree_path: "/home/example/workspace",
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
      atlasWorkspaceRoot: "/home/example/workspace",
      defaultSessionBindingPath: "/home/example/workspace",
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
      atlasWorkspaceRoot: "/home/example/workspace",
      defaultSessionBindingPath: "/home/example/workspace",
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
      atlasWorkspaceRoot: "/home/example/workspace",
      defaultSessionBindingPath: "/home/example/workspace",
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
      atlasWorkspaceRoot: "/home/example/workspace",
      defaultSessionBindingPath: "/home/example/workspace",
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
      atlasWorkspaceRoot: "/home/example/workspace",
      defaultSessionBindingPath: "/home/example/workspace",
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

test("SessionService buffers and clears pending prompt attachments", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-sessions-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const service = new SessionService({
    sessionStore,
    config: {
      atlasWorkspaceRoot: "/home/example/workspace",
      defaultSessionBindingPath: "/home/example/workspace",
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
