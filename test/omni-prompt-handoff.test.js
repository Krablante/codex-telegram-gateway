import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  OmniPromptHandoffStore,
  buildSyntheticOmniPromptMessage,
  drainPendingOmniPrompts,
} from "../src/omni/prompt-handoff.js";
import { SessionStore } from "../src/session-manager/session-store.js";

function buildBinding() {
  return {
    repo_root: "/home/bloob/atlas",
    cwd: "/home/bloob/atlas",
    branch: "main",
    worktree_path: "/home/bloob/atlas",
  };
}

async function ensureSession(sessionStore) {
  let session = await sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 991,
    topicName: "Omni handoff test",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
  session = await sessionStore.patch(session, {
    auto_mode: {
      enabled: true,
      phase: "running",
      omni_bot_id: "8603043042",
      spike_bot_id: "8537834861",
    },
  });
  return session;
}

test("OmniPromptHandoffStore queues and clears pending prompts", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-handoff-store-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const handoffStore = new OmniPromptHandoffStore(sessionStore);
  const session = await ensureSession(sessionStore);

  await handoffStore.queue(session, {
    mode: "initial",
    prompt: "queued prompt",
  });
  const loaded = await handoffStore.load(session);
  assert.equal(loaded.mode, "initial");
  assert.equal(loaded.prompt, "queued prompt");

  await handoffStore.clear(session);
  assert.equal(await handoffStore.load(session), null);
});

test("buildSyntheticOmniPromptMessage emits a bot-authored forum topic message", () => {
  const message = buildSyntheticOmniPromptMessage(
    {
      chat_id: "-1003577434463",
      topic_id: "991",
      topic_name: "Omni handoff test",
    },
    {
      prompt: "queued prompt",
      synthetic_message_id: 123,
    },
    "8603043042",
  );

  assert.equal(message.message_thread_id, 991);
  assert.equal(message.from.id, 8603043042);
  assert.equal(message.from.is_bot, true);
  assert.equal(message.is_internal_omni_handoff, true);
  assert.equal(message.text, "queued prompt");
});

test("drainPendingOmniPrompts injects queued Omni prompts into Spike handling", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-handoff-drain-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const handoffStore = new OmniPromptHandoffStore(sessionStore);
  const session = await ensureSession(sessionStore);
  await handoffStore.queue(session, {
    mode: "initial",
    prompt: "queued prompt",
  });

  const captured = [];
  const results = await drainPendingOmniPrompts({
    api: {},
    botUsername: "spikebot",
    config: {},
    lifecycleManager: null,
    promptFragmentAssembler: null,
    serviceState: {},
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return session;
      },
    },
    sessionStore,
    workerPool: {
      canStart() {
        return { ok: true };
      },
    },
    promptHandoffStore: handoffStore,
    handleMessageImpl: async ({ message }) => {
      captured.push(message);
      return { handled: true, reason: "prompt-started" };
    },
  });

  assert.equal(results.length, 1);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].text, "queued prompt");
  assert.equal(captured[0].from.id, 8603043042);
  assert.equal(await handoffStore.load(session), null);
});

test("drainPendingOmniPrompts starts queued Omni prompts directly through the worker pool", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-handoff-direct-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const handoffStore = new OmniPromptHandoffStore(sessionStore);
  const session = await ensureSession(sessionStore);
  await handoffStore.queue(session, {
    mode: "initial",
    prompt: "queued prompt",
  });

  const started = [];
  const results = await drainPendingOmniPrompts({
    api: {},
    botUsername: "spikebot",
    config: {},
    lifecycleManager: null,
    promptFragmentAssembler: null,
    serviceState: {},
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return session;
      },
    },
    sessionStore,
    workerPool: {
      canStart() {
        return { ok: true };
      },
      async startPromptRun(args) {
        started.push(args);
        return { ok: true };
      },
    },
    promptHandoffStore: handoffStore,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].result.reason, "prompt-started");
  assert.equal(started.length, 1);
  assert.equal(started[0].prompt, "queued prompt");
  assert.equal(started[0].rawPrompt, "queued prompt");
  assert.equal(started[0].message.is_internal_omni_handoff, true);
  assert.equal(await handoffStore.load(session), null);
});

test("drainPendingOmniPrompts keeps the queue when Spike cannot really start yet", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-handoff-busy-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const handoffStore = new OmniPromptHandoffStore(sessionStore);
  const session = await ensureSession(sessionStore);
  await handoffStore.queue(session, {
    mode: "continuation",
    prompt: "queued prompt",
  });

  const results = await drainPendingOmniPrompts({
    api: {},
    botUsername: "spikebot",
    config: {},
    lifecycleManager: null,
    promptFragmentAssembler: null,
    serviceState: {},
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return session;
      },
    },
    sessionStore,
    workerPool: {
      canStart() {
        return { ok: true };
      },
    },
    promptHandoffStore: handoffStore,
    handleMessageImpl: async () => ({
      handled: true,
      reason: "capacity",
    }),
  });

  assert.equal(results.length, 1);
  assert.equal((await handoffStore.load(session))?.prompt, "queued prompt");
});

test("drainPendingOmniPrompts preserves parked-session queue until the topic is active again", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-handoff-parked-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const handoffStore = new OmniPromptHandoffStore(sessionStore);
  let session = await ensureSession(sessionStore);
  session = await sessionStore.park(session, "telegram/topic-unavailable");
  await handoffStore.queue(session, {
    mode: "continuation",
    prompt: "queued prompt",
  });

  const results = await drainPendingOmniPrompts({
    api: {},
    botUsername: "spikebot",
    config: {},
    lifecycleManager: null,
    promptFragmentAssembler: null,
    serviceState: {},
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return session;
      },
    },
    sessionStore,
    workerPool: {
      canStart() {
        return { ok: true };
      },
    },
    promptHandoffStore: handoffStore,
    handleMessageImpl: async () => {
      throw new Error("parked sessions should not reach Spike");
    },
  });

  assert.equal(results.length, 0);
  assert.equal((await handoffStore.load(session))?.prompt, "queued prompt");
});

test("drainPendingOmniPrompts skips a running session owned by another generation", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-handoff-foreign-owner-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const handoffStore = new OmniPromptHandoffStore(sessionStore);
  let session = await ensureSession(sessionStore);
  session = await sessionStore.claimSessionOwner(session, {
    generationId: "gen-old",
    mode: "retiring",
  });
  session = await sessionStore.patch(session, {
    last_run_status: "running",
  });
  await handoffStore.queue(session, {
    mode: "continuation",
    prompt: "queued prompt",
  });

  let startCalls = 0;
  const results = await drainPendingOmniPrompts({
    api: {},
    botUsername: "spikebot",
    config: {},
    currentGenerationId: "gen-new",
    lifecycleManager: null,
    promptFragmentAssembler: null,
    serviceState: {},
    sessionService: {
      async ensureRunnableSessionForMessage() {
        return session;
      },
    },
    sessionStore,
    workerPool: {
      canStart() {
        return { ok: true };
      },
      async startPromptRun() {
        startCalls += 1;
        return { ok: true };
      },
    },
    promptHandoffStore: handoffStore,
  });

  assert.equal(results.length, 0);
  assert.equal(startCalls, 0);
  assert.equal((await handoffStore.load(session))?.prompt, "queued prompt");
});

test("OmniPromptHandoffStore quarantines malformed handoff files", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-handoff-corrupt-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const handoffStore = new OmniPromptHandoffStore(sessionStore);
  const session = await ensureSession(sessionStore);
  const handoffPath = handoffStore.getPath(session);

  await fs.mkdir(path.dirname(handoffPath), { recursive: true });
  await fs.writeFile(handoffPath, "{\"mode\":\"continuation\"}", "utf8");

  const loaded = await handoffStore.load(session);
  const entries = await fs.readdir(path.dirname(handoffPath));

  assert.equal(loaded, null);
  assert.equal(entries.includes("omni-pending-prompt.json"), false);
  assert.ok(
    entries.some((entry) => entry.startsWith("omni-pending-prompt.json.corrupt-")),
  );
});
