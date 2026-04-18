import test from "node:test";
import assert from "node:assert/strict";

import { ZooService } from "../src/zoo/service.js";
import { ZooStore } from "../src/zoo/store.js";
import {
  buildConfig,
  createApiStub,
  createDeferred,
  createStateRoot,
} from "../test-support/zoo-fixtures.js";

test("ZooService does not save a snapshot for a pet deleted during refresh", async () => {
  const stateRoot = await createStateRoot();
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  const petId = "pet-refresh";
  await zooStore.savePet({
    pet_id: petId,
    display_name: "project-a",
    resolved_path: "/home/bloob/atlas/project-a",
    repo_root: "/home/bloob/atlas/project-a",
    cwd: "/home/bloob/atlas/project-a",
    creature_kind: "rabbit",
  });
  await zooStore.patchTopic({
    chat_id: "-1003577434463",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 901,
    active_screen: "pet",
    selected_pet_id: petId,
    refreshing_pet_id: petId,
    refresh_status_text: "Анализирую весь проект...",
  });
  const analysis = createDeferred();
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {},
    zooStore,
    analysisRunner: async () => analysis.promise,
  });

  const pet = await zooStore.loadPet(petId);
  const refreshPromise = service.runRefresh({
    api,
    pet,
    language: "rus",
  });
  await zooStore.deletePet(petId);

  analysis.resolve({
    pet_id: petId,
    display_name: "project-a",
    resolved_path: "/home/bloob/atlas/project-a",
    creature_kind: "rabbit",
    mood: "alert",
    findings: ["one"],
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
      security: "same",
      shitcode: "same",
      junk: "same",
      tests: "same",
      structure: "same",
      docs: "same",
      operability: "same",
    },
  });
  await refreshPromise;

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.refreshing_pet_id, null);
  assert.equal(topicState.selected_pet_id, null);
  assert.equal(topicState.active_screen, "root");
  assert.equal(await zooStore.loadLatestSnapshot(petId), null);
  assert.equal(
    api.calls.sendMessage.some((call) => /Снимок обновлён/u.test(call.text)),
    false,
  );
});

test("ZooService clears stale pet selection when a deleted pet refresh fails", async () => {
  const stateRoot = await createStateRoot();
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  const petId = "pet-refresh-fail";
  await zooStore.savePet({
    pet_id: petId,
    display_name: "project-a",
    resolved_path: "/home/bloob/atlas/project-a",
    repo_root: "/home/bloob/atlas/project-a",
    cwd: "/home/bloob/atlas/project-a",
    creature_kind: "rabbit",
  });
  await zooStore.patchTopic({
    chat_id: "-1003577434463",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 901,
    active_screen: "pet",
    selected_pet_id: petId,
    refreshing_pet_id: petId,
    refresh_status_text: "Анализирую весь проект...",
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {},
    zooStore,
    analysisRunner: async () => {
      await zooStore.deletePet(petId);
      throw new Error("analysis exploded");
    },
  });

  const pet = await zooStore.loadPet(petId);
  await service.runRefresh({
    api,
    pet,
    language: "rus",
  });

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.refreshing_pet_id, null);
  assert.equal(topicState.selected_pet_id, null);
  assert.equal(topicState.active_screen, "root");
  assert.equal(topicState.last_refresh_error_text, null);
});
