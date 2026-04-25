import test from "node:test";
import assert from "node:assert/strict";

import { handleIncomingMessage } from "../src/telegram/command-router.js";
import {
  buildIdleWorkerPool,
  config,
  createGlobalControlSessionService,
  createServiceState,
  createTopicSession,
  createTopicSessionService,
} from "../test-support/control-panel-fixtures.js";

test("handleIncomingMessage reports known hosts with /hosts", async () => {
  const sent = [];

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/hosts",
      entities: [{ type: "bot_command", offset: 0, length: 6 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
    },
    serviceState: createServiceState(),
    sessionService: createGlobalControlSessionService(),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "hosts");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^Хосты/u);
  assert.match(sent[0].text, /- controller: ready/u);
  assert.match(sent[0].text, /- worker-b: недоступен \(codex-auth\)/u);
});

test("handleIncomingMessage reports the bound topic host with /host", async () => {
  const sent = [];
  const session = createTopicSession();

  const result = await handleIncomingMessage({
    api: {
      async sendMessage(payload) {
        sent.push(payload);
      },
    },
    botUsername: "gatewaybot",
    config,
    message: {
      text: "/host",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
      from: { id: 123456789, is_bot: false },
      chat: { id: -1001234567890 },
      message_thread_id: 55,
    },
    serviceState: createServiceState(),
    sessionService: createTopicSessionService(session),
    workerPool: buildIdleWorkerPool(),
  });

  assert.equal(result.command, "host");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^Хост worker-a/u);
  assert.match(sent[0].text, /topic_binding: worker-a/u);
  assert.match(sent[0].text, /binding_immutable: yes/u);
});
