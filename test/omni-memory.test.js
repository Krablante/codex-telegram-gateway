import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OmniMemoryStore } from "../src/omni/memory.js";
import { SessionStore } from "../src/session-manager/session-store.js";

function buildBinding() {
  return {
    repo_root: "/workspace",
    cwd: "/workspace",
    branch: "main",
    worktree_path: "/workspace",
  };
}

async function ensureSession(sessionStore) {
  return sessionStore.ensure({
    chatId: -1003577434463,
    topicId: 551,
    topicName: "Omni memory test",
    createdVia: "test",
    workspaceBinding: buildBinding(),
  });
}

test("OmniMemoryStore writes, normalizes, and clears topic-scoped Omni memory", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-omni-memory-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const memoryStore = new OmniMemoryStore(sessionStore);
  const session = await ensureSession(sessionStore);

  const written = await memoryStore.write(session, {
    goal_constraints: ["Stay topic-scoped.", "Stay topic-scoped."],
    current_proof_line: "continuity refresh",
    side_work_queue: ["inspect queue boundary"],
    do_not_regress: ["keep manual /compact intact"],
  });

  assert.deepEqual(written.goal_constraints, ["Stay topic-scoped."]);
  assert.equal(written.current_proof_line, "continuity refresh");
  assert.deepEqual(written.side_work_queue, ["inspect queue boundary"]);

  const loaded = await memoryStore.load(session);
  assert.equal(loaded.current_proof_line, "continuity refresh");
  assert.deepEqual(loaded.do_not_regress, ["keep manual /compact intact"]);

  await memoryStore.clear(session);
  const cleared = await memoryStore.load(session);
  assert.equal(cleared.current_proof_line, null);
  assert.deepEqual(cleared.goal_constraints, []);
});

test("OmniMemoryStore quarantines malformed memory files and falls back to defaults", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-omni-memory-corrupt-"),
  );
  const sessionStore = new SessionStore(sessionsRoot);
  const memoryStore = new OmniMemoryStore(sessionStore);
  const session = await ensureSession(sessionStore);
  const memoryPath = memoryStore.getPath(session);

  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await fs.writeFile(memoryPath, "{not-json", "utf8");

  const loaded = await memoryStore.load(session);
  const entries = await fs.readdir(path.dirname(memoryPath));

  assert.equal(loaded.current_proof_line, null);
  assert.equal(entries.includes("omni-memory.json"), false);
  assert.ok(entries.some((entry) => entry.startsWith("omni-memory.json.corrupt-")));
});
