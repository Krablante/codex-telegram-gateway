import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GlobalControlPanelStore } from "../src/session-manager/global-control-panel-store.js";
import { SessionStore } from "../src/session-manager/session-store.js";
import { TopicControlPanelStore } from "../src/session-manager/topic-control-panel-store.js";

function buildBinding() {
  return {
    repo_root: "/srv/codex-workspace",
    cwd: "/srv/codex-workspace",
    branch: "main",
    worktree_path: "/srv/codex-workspace",
  };
}

test("GlobalControlPanelStore patchWithCurrent serializes overlapping patches", async (t) => {
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-global-panel-"),
  );
  t.after(() => fs.rm(settingsRoot, { recursive: true, force: true }));
  const store = new GlobalControlPanelStore(settingsRoot);

  let enteredFirstPatch;
  let releaseFirstPatch;
  const firstPatchEnteredPromise = new Promise((resolve) => {
    enteredFirstPatch = resolve;
  });
  const releaseFirstPatchPromise = new Promise((resolve) => {
    releaseFirstPatch = resolve;
  });

  const firstPatch = store.patchWithCurrent(async () => {
    enteredFirstPatch();
    await releaseFirstPatchPromise;
    return {
      menu_message_id: 91,
      pending_input: {
        kind: "suffix_text",
        requested_at: "2026-04-04T21:00:00.000Z",
        requested_by_user_id: "123456789",
        menu_message_id: 91,
        screen: "suffix",
      },
    };
  });

  await firstPatchEnteredPromise;
  let secondFinished = false;
  const secondPatch = store.patchWithCurrent((current) => ({
    active_screen: current.pending_input?.screen || "root",
  })).then(() => {
    secondFinished = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    secondFinished,
    false,
    "second global panel patch should wait for the first writer",
  );

  releaseFirstPatch();
  await Promise.all([firstPatch, secondPatch]);

  const loaded = await store.load({ force: true });
  assert.equal(loaded.menu_message_id, 91);
  assert.equal(loaded.pending_input?.kind, "suffix_text");
  assert.equal(loaded.active_screen, "suffix");
});

test("GlobalControlPanelStore preserves all menu screens across reload", async (t) => {
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-global-panel-screens-"),
  );
  t.after(() => fs.rm(settingsRoot, { recursive: true, force: true }));
  const store = new GlobalControlPanelStore(settingsRoot);

  for (const screen of [
    "root",
    "hosts",
    "new_topic",
    "wait",
    "suffix",
    "language",
    "bot_settings",
    "spike_model",
    "spike_reasoning",
    "compact_model",
    "compact_reasoning",
  ]) {
    await store.patch({ active_screen: screen });
    const loaded = await store.load({ force: true });
    assert.equal(loaded.active_screen, screen);
  }
});

test("TopicControlPanelStore patchWithCurrent serializes overlapping patches per session", async (t) => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-topic-panel-"),
  );
  t.after(() => fs.rm(sessionsRoot, { recursive: true, force: true }));
  const sessionStore = new SessionStore(sessionsRoot);
  const panelStore = new TopicControlPanelStore(sessionStore);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 340,
    topicName: "Topic control store",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  let enteredFirstPatch;
  let releaseFirstPatch;
  const firstPatchEnteredPromise = new Promise((resolve) => {
    enteredFirstPatch = resolve;
  });
  const releaseFirstPatchPromise = new Promise((resolve) => {
    releaseFirstPatch = resolve;
  });

  const firstPatch = panelStore.patchWithCurrent(session, async () => {
    enteredFirstPatch();
    await releaseFirstPatchPromise;
    return {
      menu_message_id: 77,
      pending_input: {
        kind: "wait_custom",
        requested_at: "2026-04-04T21:01:00.000Z",
        requested_by_user_id: "123456789",
        menu_message_id: 77,
        screen: "wait",
      },
    };
  });

  await firstPatchEnteredPromise;
  let secondFinished = false;
  const secondPatch = panelStore.patchWithCurrent(session, (current) => ({
    active_screen: current.pending_input?.screen || "root",
  })).then(() => {
    secondFinished = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(
    secondFinished,
    false,
    "second topic panel patch should wait for the first writer",
  );

  releaseFirstPatch();
  await Promise.all([firstPatch, secondPatch]);

  const loaded = await panelStore.load(session, { force: true });
  assert.equal(loaded.menu_message_id, 77);
  assert.equal(loaded.pending_input?.kind, "wait_custom");
  assert.equal(loaded.active_screen, "wait");
});

test("TopicControlPanelStore preserves all topic menu screens across reload", async (t) => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-topic-panel-screens-"),
  );
  t.after(() => fs.rm(sessionsRoot, { recursive: true, force: true }));
  const sessionStore = new SessionStore(sessionsRoot);
  const panelStore = new TopicControlPanelStore(sessionStore);
  const session = await sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 341,
    topicName: "Topic control screen persistence",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });

  for (const screen of [
    "root",
    "status",
    "wait",
    "suffix",
    "language",
    "bot_settings",
    "spike_model",
    "spike_reasoning",
  ]) {
    await panelStore.patch(session, { active_screen: screen });
    const loaded = await panelStore.load(session, { force: true });
    assert.equal(loaded.active_screen, screen);
  }
});
