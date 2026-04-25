import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { ZooService } from "../src/zoo/service.js";
import { buildPetIdFromPath, ZooStore } from "../src/zoo/store.js";
import {
  buildConfig,
  createApiStub,
  createDeferred,
  createStateRoot,
} from "../test-support/zoo-fixtures.js";

test("ZooService add-project flow captures the description reply", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
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
      from: { id: 123456789, is_bot: false },
      message: {
        chat: { id: -1001234567890 },
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
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 700,
      message_id: 5,
    },
  });

  assert.equal(replyResult.reason, "zoo-lookup-started");
  assert.equal(capturedDescription, "my private telegram to codex gateway");
  assert.equal(api.calls.deleteMessage.at(-1).message_id, 5);
});

test("ZooService ignores stale lookup completions from an older add flow", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 901,
    pending_add: {
      kind: "add_project",
      stage: "await_description",
      busy: true,
      requested_by_user_id: "123456789",
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
            path.relative("/srv/codex-workspace", requestedPath) || ".",
        };
      },
    },
    zooStore,
    lookupRunner: async (_t) => lookup.promise,
  });

  const runPromise = service.runLookup({
    api,
    description: "gateway",
    requestedByUserId: "123456789",
    language: "rus",
    lookupRequestId: "lookup-old",
  });

  await zooStore.patchTopic({
    pending_add: {
      kind: "add_project",
      stage: "await_description",
      busy: true,
      requested_by_user_id: "123456789",
      lookup_request_id: "lookup-new",
      cleanup_message_ids: [],
    },
  });

  lookup.resolve({
    candidatePath: "/srv/codex-workspace/project-a",
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

test("ZooService stores lookup confirmation in menu state instead of sending a chat message", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 901,
    pending_add: {
      kind: "add_project",
      stage: "await_description",
      busy: true,
      requested_by_user_id: "123456789",
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
            path.relative("/srv/codex-workspace", requestedPath) || ".",
        };
      },
    },
    zooStore,
    lookupRunner: async (_t) => ({
      candidatePath: "/srv/codex-workspace/project-a",
      candidateDisplayName: "project-a",
      needsMoreDetail: false,
      reason: "Похоже на нужный проект.",
      question: "Это он?",
    }),
  });

  await service.runLookup({
    api,
    description: "gateway",
    requestedByUserId: "123456789",
    language: "rus",
    lookupRequestId: "lookup-1",
  });

  const topicState = await zooStore.loadTopic({ force: true });
  assert.equal(topicState.pending_add.stage, "await_confirmation");
  assert.equal(topicState.pending_add.candidate_path, "/srv/codex-workspace/project-a");
  assert.equal(topicState.pending_add.candidate_reason, "Похоже на нужный проект.");
  assert.equal(topicState.pending_add.candidate_question, "Это он?");
  assert.equal(topicState.pending_add.candidate_display_name, "project-a");
  assert.equal(api.calls.sendMessage.length, 0);
});

test("ZooService canonicalizes public/private duplicate names during lookup confirmation", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.savePet({
    pet_id: "pet-private",
    display_name: "Codex Telegram Gateway",
    resolved_path: "/srv/codex-workspace/internal/codex-telegram-gateway",
    repo_root: "/srv/codex-workspace/internal/codex-telegram-gateway",
    cwd: "/srv/codex-workspace/internal/codex-telegram-gateway",
    cwd_relative_to_workspace_root: "internal/codex-telegram-gateway",
    creature_kind: "cat",
  });
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "eng",
    menu_message_id: 901,
    pending_add: {
      kind: "add_project",
      stage: "await_description",
      busy: true,
      requested_by_user_id: "123456789",
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
            path.relative("/srv/codex-workspace", requestedPath) || ".",
        };
      },
    },
    zooStore,
    lookupRunner: async (_t) => ({
      candidatePath: "/srv/codex-workspace/work/public/personal/automation/codex-telegram-gateway",
      candidateDisplayName: "Codex Telegram Gateway OSS",
      needsMoreDetail: false,
      reason: "Best match in the public workspace.",
      question: "Is this the right project?",
    }),
  });

  await service.runLookup({
    api,
    description: "public codex telegram gateway",
    requestedByUserId: "123456789",
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

test("ZooService stores Zoo pets at project root even if lookup resolved a nested path", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    pending_add: {
      kind: "add_project",
      stage: "await_confirmation",
      busy: false,
      requested_by_user_id: "123456789",
      candidate_path: "/srv/codex-workspace/project-a/src",
      candidate_display_name: "project-a",
      cleanup_message_ids: [],
    },
  });
  const service = new ZooService({
    config: buildConfig(stateRoot),
    sessionService: {
      async resolveBindingPath() {
        return {
          cwd: "/srv/codex-workspace/project-a/src",
          repo_root: "/srv/codex-workspace/project-a",
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
  assert.equal(pets[0].cwd, "/srv/codex-workspace/project-a");
  assert.equal(pets[0].repo_root, "/srv/codex-workspace/project-a");
  assert.equal(pets[0].resolved_path, "/srv/codex-workspace/project-a");
});

test("ZooService resets add-project flow when the confirmed candidate path is gone", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: 901,
    pending_add: {
      kind: "add_project",
      stage: "await_confirmation",
      busy: false,
      requested_by_user_id: "123456789",
      candidate_path: "/srv/codex-workspace/project-gone",
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

test("ZooService assigns random unused identity fields to new pets", async (t) => {
  const stateRoot = await createStateRoot(t);
  const api = createApiStub();
  const zooStore = new ZooStore(stateRoot);
  await zooStore.savePet({
    pet_id: "pet-existing-a",
    display_name: "project-a",
    resolved_path: "/srv/codex-workspace/project-a",
    repo_root: "/srv/codex-workspace/project-a",
    cwd: "/srv/codex-workspace/project-a",
    creature_kind: "cat",
    temperament_id: "paladin",
    character_name: "Rainbow Dash",
  });
  await zooStore.savePet({
    pet_id: "pet-existing-b",
    display_name: "project-b",
    resolved_path: "/srv/codex-workspace/project-b",
    repo_root: "/srv/codex-workspace/project-b",
    cwd: "/srv/codex-workspace/project-b",
    creature_kind: "rabbit",
    temperament_id: "gremlin",
    character_name: "Pinkie Pie",
  });
  await zooStore.patchTopic({
    chat_id: "-1001234567890",
    topic_id: "700",
    topic_name: "Zoo",
    ui_language: "rus",
    pending_add: {
      kind: "add_project",
      stage: "await_confirmation",
      busy: false,
      requested_by_user_id: "123456789",
      candidate_path: "/srv/codex-workspace/project-c",
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
          cwd: "/srv/codex-workspace/project-c",
          repo_root: "/srv/codex-workspace/project-c",
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

  const pet = await zooStore.loadPet(buildPetIdFromPath("/srv/codex-workspace/project-c"));
  assert.equal(pet.display_name, "project-c");
  assert.equal(pet.creature_kind, "fox");
  assert.equal(pet.temperament_id, "scout");
  assert.equal(pet.character_name, "Twilight Sparkle");
});
