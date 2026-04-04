import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ZooService } from "../src/zoo/service.js";
import { buildPetIdFromPath, ZooStore } from "../src/zoo/store.js";

function buildConfig(stateRoot) {
  return {
    stateRoot,
    workspaceRoot: "/workspace",
    codexBinPath: "codex",
    telegramAllowedUserId: "5825672398",
    telegramAllowedUserIds: ["5825672398"],
    telegramAllowedBotIds: ["8603043042"],
    telegramForumChatId: "-1003577434463",
  };
}

function createApiStub() {
  const calls = {
    createForumTopic: [],
    sendMessage: [],
    editMessageText: [],
    pinChatMessage: [],
    deleteMessage: [],
    answerCallbackQuery: [],
  };

  return {
    calls,
    async createForumTopic(params) {
      calls.createForumTopic.push(params);
      return {
        message_thread_id: 700,
        name: "Zoo",
      };
    },
    async sendMessage(params) {
      calls.sendMessage.push(params);
      return {
        message_id: 900 + calls.sendMessage.length,
      };
    },
    async editMessageText(params) {
      calls.editMessageText.push(params);
      return true;
    },
    async pinChatMessage(params) {
      calls.pinChatMessage.push(params);
      return true;
    },
    async deleteMessage(params) {
      calls.deleteMessage.push(params);
      return true;
    },
    async answerCallbackQuery(params) {
      calls.answerCallbackQuery.push(params);
      return true;
    },
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("ZooService /zoo creates the dedicated topic and menu", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const api = createApiStub();
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async ensureSessionForMessage() {
        return null;
      },
    },
  });

  const result = await service.maybeHandleIncomingMessage({
    api,
    botUsername: "gatewaybot",
    message: {
      text: "/zoo",
      entities: [{ type: "bot_command", offset: 0, length: 4 }],
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
    },
  });

  assert.equal(result.command, "zoo");
  assert.equal(api.calls.createForumTopic.length, 1);
  assert.equal(api.calls.sendMessage.length, 1);
  assert.equal(api.calls.sendMessage[0].message_thread_id, 700);
  assert.equal(api.calls.pinChatMessage.length, 1);
  assert.equal(api.calls.deleteMessage.length, 1);
  assert.equal(api.calls.deleteMessage[0].message_id, 902);

  const topicState = await service.zooStore.loadTopic({ force: true });
  assert.equal(topicState.topic_id, "700");
  assert.equal(topicState.menu_message_id, 901);
});

test("ZooService respawn menu deletes the previous Zoo menu message", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1003577434463",
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
      from: { id: 5825672398, is_bot: false },
      message: {
        chat: { id: -1003577434463 },
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
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const api = createApiStub();
  api.editMessageText = async (params) => {
    api.calls.editMessageText.push(params);
    throw new Error("Too Many Requests: retry later");
  };
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1003577434463",
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
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
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
    chat_id: "-1003577434463",
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
      from: { id: 5825672398, is_bot: false },
      message: {
        chat: { id: -1003577434463 },
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
      from: { id: 5825672398, is_bot: false },
      message: {
        chat: { id: -1003577434463 },
        message_thread_id: 700,
      },
    },
  });

  assert.equal(service.petTickerByPetId.has(petId), false);
  assert.equal(service.petTickerIntervalByPetId.has(petId), false);
});

test("ZooService buildMenuPayload does not scan the full stable on a pet screen redraw", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
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
    chat_id: "-1003577434463",
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
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1003577434463",
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
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
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
    chat_id: "-1003577434463",
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
      from: { id: 5825672398, is_bot: false },
      message: {
        chat: { id: -1003577434463 },
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

test("ZooService rejects normal prompts inside the Zoo topic", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1003577434463",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("normal session flow should not be used for Zoo topic prompts");
      },
    },
    zooStore,
  });

  const result = await service.maybeHandleIncomingMessage({
    api,
    botUsername: "gatewaybot",
    message: {
      text: "hello there",
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
      message_thread_id: 700,
      message_id: 1,
    },
  });

  assert.equal(result.reason, "zoo-topic-unsupported-prompt");
  assert.match(api.calls.sendMessage[0].text, /Zoo/u);
  assert.equal(api.calls.deleteMessage[0].message_id, 1);
});

test("ZooService add-project flow captures the description reply", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1003577434463",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 901,
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async ensureSessionForMessage() {
        throw new Error("normal sessions should stay out of Zoo reply flow");
      },
    },
    zooStore,
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

  await service.handleCallbackQuery({
    api,
    callbackQuery: {
      id: "cb1",
      data: "zoo:a:start",
      from: { id: 5825672398, is_bot: false },
      message: {
        chat: { id: -1003577434463 },
        message_thread_id: 700,
      },
    },
  });

  const topicState = await service.zooStore.loadTopic({ force: true });
  assert.equal(topicState.pending_add.stage, "await_description");
  assert.equal(api.calls.sendMessage.length, 0);
  assert.match(topicState.pending_add.prompt_hint_text, /найти/u);

  const replyResult = await service.maybeHandleIncomingMessage({
    api,
    botUsername: "gatewaybot",
    message: {
      text: "my private telegram to codex gateway",
      from: { id: 5825672398, is_bot: false },
      chat: { id: -1003577434463 },
      message_thread_id: 700,
      message_id: 5,
    },
  });

  assert.equal(replyResult.reason, "zoo-lookup-started");
  assert.equal(capturedDescription, "my private telegram to codex gateway");
  assert.equal(api.calls.deleteMessage.at(-1).message_id, 5);
});

test("ZooService ignores stale lookup completions from an older add flow", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1003577434463",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 901,
    pending_add: {
      kind: "add_project",
      stage: "await_description",
      busy: true,
      requested_by_user_id: "5825672398",
      lookup_request_id: "lookup-old",
      cleanup_message_ids: [],
    },
  });
  const lookup = createDeferred();
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async resolveBindingPath(requestedPath) {
        return {
          cwd: requestedPath,
          repo_root: requestedPath,
          cwd_relative_to_workspace_root:
            path.relative("/workspace", requestedPath) || ".",
        };
      },
    },
    zooStore,
    lookupRunner: async () => lookup.promise,
  });

  const runPromise = service.runLookup({
    api,
    description: "gateway",
    requestedByUserId: "5825672398",
    language: "rus",
    lookupRequestId: "lookup-old",
  });

  await zooStore.patchTopic({
    pending_add: {
      kind: "add_project",
      stage: "await_description",
      busy: true,
      requested_by_user_id: "5825672398",
      lookup_request_id: "lookup-new",
      cleanup_message_ids: [],
    },
  });

  lookup.resolve({
    candidatePath: "/workspace/project-a",
    candidateDisplayName: "project-a",
    needsMoreDetail: false,
    reason: "best match",
    question: "Is this the right project?",
  });
  await runPromise;

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.pending_add.lookup_request_id, "lookup-new");
  assert.equal(api.calls.sendMessage.length, 0);
});

test("ZooService stores lookup confirmation in menu state instead of sending a chat message", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1003577434463",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 901,
    pending_add: {
      kind: "add_project",
      stage: "await_description",
      busy: true,
      requested_by_user_id: "5825672398",
      lookup_request_id: "lookup-1",
      cleanup_message_ids: [],
    },
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async resolveBindingPath(requestedPath) {
        return {
          cwd: requestedPath,
          repo_root: requestedPath,
          cwd_relative_to_workspace_root:
            path.relative("/workspace", requestedPath) || ".",
        };
      },
    },
    zooStore,
    lookupRunner: async () => ({
      candidatePath: "/workspace/project-a",
      candidateDisplayName: "project-a",
      needsMoreDetail: false,
      reason: "Похоже на нужный проект.",
      question: "Это он?",
    }),
  });

  await service.runLookup({
    api,
    description: "gateway",
    requestedByUserId: "5825672398",
    language: "rus",
    lookupRequestId: "lookup-1",
  });

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.pending_add.stage, "await_confirmation");
  assert.equal(topicState.pending_add.candidate_path, "/workspace/project-a");
  assert.equal(topicState.pending_add.candidate_reason, "Похоже на нужный проект.");
  assert.equal(topicState.pending_add.candidate_question, "Это он?");
  assert.equal(topicState.pending_add.candidate_display_name, "project-a");
  assert.equal(api.calls.sendMessage.length, 0);
});

test("ZooService canonicalizes public/private duplicate names during lookup confirmation", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.savePet({
    pet_id: "pet-private",
    display_name: "Codex Telegram Gateway",
    resolved_path: "/workspace/projects/codex-telegram-gateway",
    repo_root: "/workspace/projects/codex-telegram-gateway",
    cwd: "/workspace/projects/codex-telegram-gateway",
    cwd_relative_to_workspace_root: "projects/codex-telegram-gateway",
    creature_kind: "cat",
  });
  await zooStore.patchTopic({
    chat_id: "-1003577434463",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "eng",
    menu_message_id: 901,
    pending_add: {
      kind: "add_project",
      stage: "await_description",
      busy: true,
      requested_by_user_id: "5825672398",
      lookup_request_id: "lookup-pub",
      cleanup_message_ids: [],
    },
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async resolveBindingPath(requestedPath) {
        return {
          cwd: requestedPath,
          repo_root: requestedPath,
          cwd_relative_to_workspace_root:
            path.relative("/workspace", requestedPath) || ".",
        };
      },
    },
    zooStore,
    lookupRunner: async () => ({
      candidatePath: "/workspace/work/public/personal/automation/codex-telegram-gateway",
      candidateDisplayName: "Codex Telegram Gateway OSS",
      needsMoreDetail: false,
      reason: "Best match in the public workspace.",
      question: "Is this the right project?",
    }),
  });

  await service.runLookup({
    api,
    description: "public codex telegram gateway",
    requestedByUserId: "5825672398",
    language: "eng",
    lookupRequestId: "lookup-pub",
  });

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(
    topicState.pending_add.candidate_display_name,
    "codex-telegram-gateway [pub]",
  );
  const privatePet = await zooStore.loadPet("pet-private");
  assert.equal(privatePet.display_name, "codex-telegram-gateway [priv]");
});

test("ZooService stores Zoo pets at project root even if lookup resolved a nested path", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1003577434463",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    pending_add: {
      kind: "add_project",
      stage: "await_confirmation",
      busy: false,
      requested_by_user_id: "5825672398",
      candidate_path: "/workspace/project-a/src",
      candidate_display_name: "project-a",
      cleanup_message_ids: [],
    },
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async resolveBindingPath() {
        return {
          cwd: "/workspace/project-a/src",
          repo_root: "/workspace/project-a",
          cwd_relative_to_workspace_root: "project-a/src",
        };
      },
    },
    zooStore,
  });

  await service.confirmPendingAdd({
    api,
    message: { message_id: 42 },
    topicState: await zooStore.loadTopic({ force: true }),
  });

  const pets = await zooStore.listPets();
  assert.equal(pets.length, 1);
  assert.equal(pets[0].cwd, "/workspace/project-a");
  assert.equal(pets[0].repo_root, "/workspace/project-a");
  assert.equal(pets[0].resolved_path, "/workspace/project-a");
});

test("ZooService resets add-project flow when the confirmed candidate path is gone", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1003577434463",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 901,
    pending_add: {
      kind: "add_project",
      stage: "await_confirmation",
      busy: false,
      requested_by_user_id: "5825672398",
      candidate_path: "/workspace/project-gone",
      candidate_display_name: "project-gone",
      cleanup_message_ids: [41],
    },
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async resolveBindingPath() {
        throw new Error("Path is gone");
      },
    },
    zooStore,
  });

  await service.confirmPendingAdd({
    api,
    message: { message_id: 42 },
    topicState: await zooStore.loadTopic({ force: true }),
  });

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.pending_add.stage, "await_description");
  assert.equal(topicState.pending_add.candidate_path, null);
  assert.equal(topicState.pending_add.candidate_display_name, null);
  assert.deepEqual(topicState.pending_add.cleanup_message_ids, [41, 42]);
  assert.match(api.calls.sendMessage[0].text, /Добавление проекта не удалось/u);
  assert.equal(
    api.calls.deleteMessage.some((call) => call.message_id === 42),
    true,
  );
});

test("ZooService assigns random unused identity fields to new pets", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.savePet({
    pet_id: "pet-existing-a",
    display_name: "project-a",
    resolved_path: "/workspace/project-a",
    repo_root: "/workspace/project-a",
    cwd: "/workspace/project-a",
    creature_kind: "cat",
    temperament_id: "paladin",
    character_name: "Rainbow Dash",
  });
  await zooStore.savePet({
    pet_id: "pet-existing-b",
    display_name: "project-b",
    resolved_path: "/workspace/project-b",
    repo_root: "/workspace/project-b",
    cwd: "/workspace/project-b",
    creature_kind: "rabbit",
    temperament_id: "gremlin",
    character_name: "Pinkie Pie",
  });
  await zooStore.patchTopic({
    chat_id: "-1003577434463",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    pending_add: {
      kind: "add_project",
      stage: "await_confirmation",
      busy: false,
      requested_by_user_id: "5825672398",
      candidate_path: "/workspace/project-c",
      candidate_display_name: "project-c",
      cleanup_message_ids: [],
    },
  });
  const randomValues = [0, 0, 0];
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async resolveBindingPath() {
        return {
          cwd: "/workspace/project-c",
          repo_root: "/workspace/project-c",
          cwd_relative_to_workspace_root: "project-c",
        };
      },
    },
    zooStore,
    randomSource: () => randomValues.shift() ?? 0,
  });

  await service.confirmPendingAdd({
    api,
    message: { message_id: 42 },
    topicState: await zooStore.loadTopic({ force: true }),
  });

  const pet = await zooStore.loadPet(buildPetIdFromPath("/workspace/project-c"));
  assert.equal(pet.display_name, "project-c");
  assert.equal(pet.creature_kind, "fox");
  assert.equal(pet.temperament_id, "scout");
  assert.equal(pet.character_name, "Twilight Sparkle");
});

test("ZooService auto-reconciles existing duplicate public/private pet names in the root menu", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const zooStore = new ZooStore(stateRoot);
  await zooStore.savePet({
    pet_id: "pet-private",
    display_name: "Codex Telegram Gateway",
    resolved_path: "/workspace/projects/codex-telegram-gateway",
    repo_root: "/workspace/projects/codex-telegram-gateway",
    cwd: "/workspace/projects/codex-telegram-gateway",
    cwd_relative_to_workspace_root: "projects/codex-telegram-gateway",
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
    chat_id: "-1003577434463",
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

test("ZooService does not save a snapshot for a pet deleted during refresh", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  const petId = "pet-refresh";
  await zooStore.savePet({
    pet_id: petId,
    display_name: "project-a",
    resolved_path: "/workspace/project-a",
    repo_root: "/workspace/project-a",
    cwd: "/workspace/project-a",
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
    resolved_path: "/workspace/project-a",
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
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-zoo-service-"),
  );
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  const petId = "pet-refresh-fail";
  await zooStore.savePet({
    pet_id: petId,
    display_name: "project-a",
    resolved_path: "/workspace/project-a",
    repo_root: "/workspace/project-a",
    cwd: "/workspace/project-a",
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
