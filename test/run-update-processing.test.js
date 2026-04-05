import test from "node:test";
import assert from "node:assert/strict";

import {
  bootstrapOffset,
  createForwardingRequestHandler,
  noteOffsetSafe,
  processUpdates,
} from "../src/cli/run-update-processing.js";

test("bootstrapOffset returns the stored offset without probing Telegram again", async () => {
  const result = await bootstrapOffset({
    api: {
      async getUpdates() {
        throw new Error("should not probe Telegram when offset already exists");
      },
    },
    offsetStore: {
      async load() {
        return 123;
      },
      async save() {
        throw new Error("should not save when offset already exists");
      },
    },
    serviceState: {},
  });

  assert.equal(result, 123);
});

test("bootstrapOffset drops the latest pending update when no offset exists yet", async () => {
  const savedOffsets = [];
  const serviceState = {
    bootstrapDroppedUpdateId: null,
  };

  const result = await bootstrapOffset({
    api: {
      async getUpdates(params) {
        assert.equal(params.offset, -1);
        return [{ update_id: 9001 }];
      },
    },
    offsetStore: {
      async load() {
        return null;
      },
      async save(value) {
        savedOffsets.push(value);
      },
    },
    serviceState,
  });

  assert.equal(result, 9002);
  assert.deepEqual(savedOffsets, [9002]);
  assert.equal(serviceState.bootstrapDroppedUpdateId, 9001);
});

test("processUpdates forwards foreign-owned updates and handles local ones in order", async () => {
  const savedOffsets = [];
  const notedOffsets = [];
  const forwarded = [];
  const localUpdates = [];
  const serviceState = {
    lastUpdateId: null,
    handledUpdates: 0,
  };

  const nextOffset = await processUpdates({
    api: {
      async sendMessage() {
        return { ok: true };
      },
      async answerCallbackQuery() {
        return { ok: true };
      },
    },
    ackBatchCallbackQueriesImpl: async () => {},
    botUsername: "gatewaybot",
    config: {},
    emergencyRouter: null,
    forwardUpdateImpl: async (payload) => {
      forwarded.push(payload);
    },
    handleSpikeUpdateImpl: async ({ update }) => {
      localUpdates.push(update.update_id);
    },
    lifecycleManager: null,
    promptFragmentAssembler: null,
    queuePromptAssembler: null,
    resolveSpikeUpdateRouteImpl: async ({ update }) =>
      update.update_id === 41
        ? {
            type: "forward",
            ownerGeneration: {
              ipc_endpoint: "http://127.0.0.1:9",
            },
          }
        : { type: "local" },
    runtimeObserver: {
      async noteOffset(offset) {
        notedOffsets.push(offset);
      },
    },
    offsetStore: {
      async save(value) {
        savedOffsets.push(value);
      },
    },
    sessionStore: {},
    sessionService: {},
    globalControlPanelStore: {},
    generalMessageLedgerStore: {},
    topicControlPanelStore: {},
    zooService: {},
    workerPool: {},
    serviceState,
    generationId: "gen-new",
    generationStore: {},
    updates: [
      {
        update_id: 41,
        message: {
          chat: { id: -1001234567890 },
          message_thread_id: 700,
        },
      },
      {
        update_id: 42,
        message: {
          chat: { id: -1001234567890 },
          message_thread_id: 701,
        },
      },
    ],
  });

  assert.equal(nextOffset, 43);
  assert.deepEqual(savedOffsets, [42, 43]);
  assert.deepEqual(notedOffsets, [42, 43]);
  assert.equal(serviceState.lastUpdateId, 42);
  assert.equal(serviceState.handledUpdates, 2);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].payload.type, "spike-update");
  assert.equal(forwarded[0].payload.update.update_id, 41);
  assert.deepEqual(localUpdates, [42]);
});

test("createForwardingRequestHandler serves probes and dispatches forwarded updates locally", async () => {
  const handledUpdates = [];
  const handler = createForwardingRequestHandler({
    api: {},
    botUsername: "gatewaybot",
    config: {},
    emergencyRouter: null,
    lifecycleManager: null,
    promptFragmentAssembler: null,
    queuePromptAssembler: null,
    runtimeObserver: null,
    sessionService: null,
    globalControlPanelStore: null,
    generalMessageLedgerStore: null,
    topicControlPanelStore: null,
    zooService: null,
    workerPool: null,
    serviceState: {},
    generationId: "gen-current",
    instanceToken: "token-123",
    dispatchSpikeUpdateLocallyImpl: async ({ update }) => {
      handledUpdates.push(update.update_id);
    },
  });

  assert.deepEqual(
    await handler({ type: "generation-probe" }),
    {
      generation_id: "gen-current",
      instance_token: "token-123",
    },
  );

  assert.deepEqual(
    await handler({
      type: "spike-update",
      update: { update_id: 77 },
    }),
    { handled: true },
  );
  assert.deepEqual(handledUpdates, [77]);
});
