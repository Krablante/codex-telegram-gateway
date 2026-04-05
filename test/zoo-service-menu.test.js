import test from "node:test";
import assert from "node:assert/strict";

import { ZooService } from "../src/zoo/service.js";
import { ZooStore } from "../src/zoo/store.js";
import {
  buildConfig,
  createApiStub,
  createStateRoot,
} from "../test-support/zoo-fixtures.js";

test("ZooService respawn menu deletes the previous Zoo menu message", async () => {
  const stateRoot = await createStateRoot();
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 777,
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {},
    zooStore,
  });

  const result = await service.handleCallbackQuery({
    api,
    callbackQuery: {
      id: "cb-respawn",
      data: "zoo:m:respawn",
      from: { id: 1234567890, is_bot: false },
      message: {
        chat: { id: -1001234567890 },
        message_thread_id: 700,
      },
    },
  });

  assert.equal(result.reason, "zoo-menu-respawned");
  assert.equal(api.calls.deleteMessage.length, 3);
  assert.equal(api.calls.deleteMessage[0].message_id, 777);
  assert.equal(api.calls.deleteMessage[1].message_id, 778);
  assert.equal(api.calls.deleteMessage[2].message_id, 902);
  assert.equal(api.calls.sendMessage.length, 1);
  assert.equal(api.calls.pinChatMessage.length, 1);

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.menu_message_id, 901);
});

test("ZooService does not respawn the menu on transient edit failures", async () => {
  const stateRoot = await createStateRoot();
  const api = createApiStub();
  api.editMessageText = async (params) => {
    api.calls.editMessageText.push(params);
    throw new Error("Too Many Requests: retry later");
  };
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 901,
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {},
    zooStore,
  });

  await assert.rejects(
    service.ensureZooMenu(api),
    /Too Many Requests/u,
  );
  assert.equal(api.calls.sendMessage.length, 0);

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.menu_message_id, 901);
});

test("ZooService starts idle pet animation on pet screen and stops it on root", async () => {
  const stateRoot = await createStateRoot();
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  const petId = "pet-idle";
  await zooStore.savePet({
    pet_id: petId,
    display_name: "project-a",
    resolved_path: "/workspace/project-a",
    repo_root: "/workspace/project-a",
    cwd: "/workspace/project-a",
    creature_kind: "cat",
  });
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 901,
    active_screen: "root",
    selected_pet_id: null,
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {},
    zooStore,
  });

  await service.handleCallbackQuery({
    api,
    callbackQuery: {
      id: "cb-view",
      data: `zoo:v:${petId}`,
      from: { id: 1234567890, is_bot: false },
      message: {
        chat: { id: -1001234567890 },
        message_thread_id: 700,
      },
    },
  });

  assert.equal(service.petTickerByPetId.has(petId), true);
  assert.equal(service.petTickerIntervalByPetId.get(petId), 20000);

  await service.handleCallbackQuery({
    api,
    callbackQuery: {
      id: "cb-root",
      data: "zoo:n:root",
      from: { id: 1234567890, is_bot: false },
      message: {
        chat: { id: -1001234567890 },
        message_thread_id: 700,
      },
    },
  });

  assert.equal(service.petTickerByPetId.has(petId), false);
  assert.equal(service.petTickerIntervalByPetId.has(petId), false);
});

test("ZooService buildMenuPayload does not scan the full stable on a pet screen redraw", async () => {
  const stateRoot = await createStateRoot();
  const zooStore = new ZooStore(stateRoot);
  const petId = "pet-detail";
  await zooStore.savePet({
    pet_id: petId,
    display_name: "project-a",
    resolved_path: "/workspace/project-a",
    repo_root: "/workspace/project-a",
    cwd: "/workspace/project-a",
    creature_kind: "cat",
  });
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "eng",
    menu_message_id: 901,
    active_screen: "pet",
    selected_pet_id: petId,
  });
  zooStore.listPets = async () => {
    throw new Error("pet screen redraw should not list all pets");
  };
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {},
    zooStore,
  });

  const payload = await service.buildMenuPayload();

  assert.match(payload.text, /project: project-a/u);
  assert.equal(payload.animationPetId, petId);
});

test("ZooService buildMenuPayload clears stale selected pet state when the pet is missing", async () => {
  const stateRoot = await createStateRoot();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 901,
    active_screen: "pet",
    selected_pet_id: "pet-missing",
    refreshing_pet_id: "pet-missing",
    refresh_status_text: "Анализирую весь проект...",
    last_refresh_error_text: "старый сбой",
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {},
    zooStore,
  });

  const payload = await service.buildMenuPayload();
  const topicState = await zooStore.loadTopic({ force: true });

  assert.equal(topicState.active_screen, "root");
  assert.equal(topicState.selected_pet_id, null);
  assert.equal(topicState.refreshing_pet_id, null);
  assert.equal(topicState.refresh_status_text, null);
  assert.equal(topicState.last_refresh_error_text, null);
  assert.match(payload.text, /Стойло пусто/u);
});

test("ZooService switches root pages through pagination callbacks", async () => {
  const stateRoot = await createStateRoot();
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  for (let index = 0; index < 8; index += 1) {
    await zooStore.savePet({
      pet_id: `pet-${index + 1}`,
      display_name: `project-${index + 1}`,
      resolved_path: `/workspace/project-${index + 1}`,
      repo_root: `/workspace/project-${index + 1}`,
      cwd: `/workspace/project-${index + 1}`,
      creature_kind: "cat",
    });
  }
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "eng",
    menu_message_id: 901,
    active_screen: "root",
    root_page: 0,
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {},
    zooStore,
  });

  const firstPayload = await service.buildMenuPayload();
  assert.match(firstPayload.text, /pets: 8/u);
  assert.match(firstPayload.text, /page: 1\/2/u);
  assert.deepEqual(
    firstPayload.reply_markup.inline_keyboard.at(-2).map((button) => button.text),
    ["Next ›"],
  );

  const result = await service.handleCallbackQuery({
    api,
    callbackQuery: {
      id: "cb-page-2",
      data: "zoo:p:1",
      from: { id: 1234567890, is_bot: false },
      message: {
        chat: { id: -1001234567890 },
        message_thread_id: 700,
      },
    },
  });

  assert.equal(result.reason, "zoo-root-page-opened");
  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.root_page, 1);
  assert.match(api.calls.editMessageText.at(-1).text, /page: 2\/2/u);
  const pagedButtons = api.calls.editMessageText.at(-1).reply_markup.inline_keyboard
    .flat()
    .map((button) => button.text);
  assert.ok(pagedButtons.includes("project-7"));
  assert.ok(pagedButtons.includes("project-8"));
  assert.equal(pagedButtons.includes("project-1"), false);
  assert.deepEqual(
    api.calls.editMessageText.at(-1).reply_markup.inline_keyboard.at(-2).map((button) => button.text),
    ["‹ Back"],
  );
});

test("ZooService auto-reconciles existing duplicate public/private pet names in the root menu", async () => {
  const stateRoot = await createStateRoot();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.savePet({
    pet_id: "pet-private",
    display_name: "Codex Telegram Gateway",
    resolved_path: "/workspace/codex-telegram-gateway",
    repo_root: "/workspace/codex-telegram-gateway",
    cwd: "/workspace/codex-telegram-gateway",
    cwd_relative_to_workspace_root: "codex-telegram-gateway",
    creature_kind: "cat",
  });
  await zooStore.savePet({
    pet_id: "pet-public",
    display_name: "codex-telegram-gateway",
    resolved_path: "/workspace/work/public/personal/automation/codex-telegram-gateway",
    repo_root: "/workspace/work/public/personal/automation/codex-telegram-gateway",
    cwd: "/workspace/work/public/personal/automation/codex-telegram-gateway",
    cwd_relative_to_workspace_root:
      "work/public/personal/automation/codex-telegram-gateway",
    creature_kind: "fox",
  });
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "eng",
    menu_message_id: 901,
    active_screen: "root",
    root_page: 0,
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {},
    zooStore,
  });

  const payload = await service.buildMenuPayload();
  const pets = await zooStore.listPets();

  assert.deepEqual(
    pets.map((pet) => pet.display_name),
    [
      "codex-telegram-gateway [priv]",
      "codex-telegram-gateway [pub]",
    ],
  );
  const buttonLabels = payload.reply_markup.inline_keyboard
    .flat()
    .map((button) => button.text);
  assert.ok(buttonLabels.some((label) => label.endsWith("[priv]")));
  assert.ok(buttonLabels.some((label) => label.endsWith("[pub]")));
});

test("ZooService recovers missing Zoo topic state from a live menu callback", async () => {
  const stateRoot = await createStateRoot();
  const api = createApiStub();
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("ordinary session routing should stay out of recovered Zoo flow");
      },
    },
  });

  let capturedDescription = null;
  service.beginLookup = async ({
    api: zooApi,
    description,
    message,
  }) => {
    capturedDescription = description;
    await zooApi.deleteMessage({
      chat_id: message.chat.id,
      message_id: message.message_id,
    });
  };

  const callbackResult = await service.handleCallbackQuery({
    api,
    callbackQuery: {
      id: "cb-recover",
      data: "zoo:a:start",
      from: { id: 1234567890, is_bot: false },
      message: {
        chat: { id: -1001234567890 },
        message_thread_id: 700,
        message_id: 901,
      },
    },
  });

  assert.equal(callbackResult.reason, "zoo-add-started");
  const recoveredTopicState = await service.zooStore.loadTopic({ force: true });
  assert.equal(recoveredTopicState.chat_id, "-1001234567890");
  assert.equal(recoveredTopicState.topic_id, "700");
  assert.equal(recoveredTopicState.menu_message_id, 901);
  assert.equal(recoveredTopicState.pending_add?.stage, "await_description");
  assert.equal(api.calls.createForumTopic.length, 0);
  assert.equal(api.calls.sendMessage.length, 0);
  assert.equal(api.calls.editMessageText.length, 1);

  const replyResult = await service.maybeHandleIncomingMessage({
    api,
    botUsername: "gatewaybot",
    message: {
      text: "my private telegram to codex gateway",
      from: { id: 1234567890, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 700,
      message_id: 5,
    },
  });

  assert.equal(replyResult.reason, "zoo-lookup-started");
  assert.equal(capturedDescription, "my private telegram to codex gateway");
});

test("ZooService does not let a stale Zoo callback replace the active menu message id", async () => {
  const stateRoot = await createStateRoot();
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 901,
    active_screen: "root",
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {},
    zooStore,
  });

  const result = await service.handleCallbackQuery({
    api,
    callbackQuery: {
      id: "cb-stale-root",
      data: "zoo:n:root",
      from: { id: 1234567890, is_bot: false },
      message: {
        chat: { id: -1001234567890 },
        message_thread_id: 700,
        message_id: 777,
      },
    },
  });

  assert.equal(result.reason, "zoo-root-opened");
  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.menu_message_id, 901);
  assert.equal(api.calls.editMessageText.at(-1).message_id, 901);
});
