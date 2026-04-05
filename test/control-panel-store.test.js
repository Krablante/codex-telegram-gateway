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
    repo_root: "/workspace",
    cwd: "/workspace",
    branch: "main",
    worktree_path: "/workspace",
  };
}

test("GlobalControlPanelStore patchWithCurrent serializes overlapping patches", async () => {
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-global-panel-"),
  );
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
        requested_by_user_id: "5825672398",
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

test("TopicControlPanelStore patchWithCurrent serializes overlapping patches per session", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-topic-panel-"),
  );
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
        requested_by_user_id: "5825672398",
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
