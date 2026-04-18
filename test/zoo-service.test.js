import test from "node:test";
import assert from "node:assert/strict";
import { ZooService } from "../src/zoo/service.js";
import { ZooStore } from "../src/zoo/store.js";
import {
  buildConfig,
  createApiStub,
  createStateRoot,
} from "../test-support/zoo-fixtures.js";

test("ZooService /zoo creates the dedicated topic and menu", async () => {
  const stateRoot = await createStateRoot();
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

test("ZooService rejects normal prompts inside the Zoo topic", async () => {
  const stateRoot = await createStateRoot();
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
