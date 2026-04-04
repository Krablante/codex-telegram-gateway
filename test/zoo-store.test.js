import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ZooStore, buildPetIdFromPath } from "../src/zoo/store.js";

test("ZooStore persists topic state, pets, and latest snapshot history", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-"),
  );
  const store = new ZooStore(stateRoot);

  const topic = await store.patchTopic({
    chat_id: "-1003577434463",
    topic_id: "777",
    topic_name: "Zoo",
    selected_pet_id: null,
    root_page: 2,
  });
  assert.equal(topic.topic_id, "777");
  assert.equal(topic.root_page, 2);

  const petId = buildPetIdFromPath("/workspace/project-a");
  const pet = await store.savePet({
    pet_id: petId,
    display_name: "project-a",
    resolved_path: "/workspace/project-a",
    repo_root: "/workspace/project-a",
    cwd: "/workspace/project-a",
    cwd_relative_to_workspace_root: "project-a",
    character_name: "Rainbow Dash",
    temperament_id: "paladin",
  });
  assert.equal(pet.pet_id, petId);
  assert.equal(pet.character_name, "Rainbow Dash");
  assert.equal(pet.temperament_id, "paladin");

  const pets = await store.listPets();
  assert.equal(pets.length, 1);
  assert.equal(pets[0].display_name, "project-a");
  assert.equal(pets[0].character_name, "Rainbow Dash");
  assert.equal(pets[0].temperament_id, "paladin");

  const snapshot = await store.saveLatestSnapshot(petId, {
    pet_id: petId,
    display_name: "project-a",
    resolved_path: "/workspace/project-a",
    creature_kind: "rabbit",
    mood: "alert",
    stats: {
      security: 70,
      shitcode: 40,
      junk: 20,
      tests: 50,
      structure: 60,
      docs: 30,
      operability: 80,
    },
    trends: {
      security: "up",
      shitcode: "same",
      junk: "down",
      tests: "same",
      structure: "same",
      docs: "same",
      operability: "up",
    },
    findings: ["one", "two"],
  });
  assert.equal(snapshot.stats.security, 70);

  const reloaded = await store.loadLatestSnapshot(petId);
  assert.equal(reloaded.mood, "alert");

  const historyDir = store.getSnapshotHistoryDir(petId);
  const historyEntries = await fs.readdir(historyDir);
  assert.equal(historyEntries.length, 1);
});
