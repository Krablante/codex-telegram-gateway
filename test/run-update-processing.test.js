import test from "node:test";
import assert from "node:assert/strict";

import {
  bootstrapOffset,
  createForwardingRequestHandler,
  processUpdates,
} from "../src/cli/run-update-processing.js";
import { withSuppressedConsole } from "../test-support/console-fixtures.js";

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

test("createForwardingRequestHandler accepts legacy tokenless generation probes", async () => {
  const handler = createForwardingRequestHandler({
    generationId: "gen-new",
    instanceToken: "token-new",
  });

  assert.deepEqual(await handler({ type: "generation-probe" }), {
    generation_id: "gen-new",
    instance_token: "token-new",
  });
  assert.deepEqual(
    await handler({
      type: "generation-probe",
      instance_token: "token-new",
    }),
    {
      generation_id: "gen-new",
      instance_token: "token-new",
    },
  );
  await assert.rejects(
    handler({
      type: "generation-probe",
      instance_token: "wrong-token",
    }),
    /Unauthorized forwarded spike probe/u,
  );
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
              instance_token: "owner-token-41",
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
  assert.equal(forwarded[0].authToken, "owner-token-41");
  assert.equal(forwarded[0].payload.type, "spike-update");
  assert.equal(forwarded[0].payload.update.update_id, 41);
  assert.deepEqual(localUpdates, [42]);
});

test("processUpdates defers batch callback acks for control-panel callbacks", async () => {
  const ackedUpdateIds = [];

  await processUpdates({
    api: {
      async sendMessage() {
        return { ok: true };
      },
      async answerCallbackQuery() {
        return { ok: true };
      },
    },
    ackBatchCallbackQueriesImpl: async (_api, updates) => {
      ackedUpdateIds.push(...updates.map((update) => update.update_id));
    },
    botUsername: "gatewaybot",
    config: {},
    emergencyRouter: null,
    forwardUpdateImpl: async () => {},
    handleSpikeUpdateImpl: async () => {},
    lifecycleManager: null,
    promptFragmentAssembler: null,
    queuePromptAssembler: null,
    resolveSpikeUpdateRouteImpl: async () => ({ type: "local" }),
    runtimeObserver: null,
    offsetStore: {
      async save() {},
    },
    sessionStore: {},
    sessionService: {},
    globalControlPanelStore: {},
    generalMessageLedgerStore: {},
    topicControlPanelStore: {},
    zooService: {},
    workerPool: {},
    serviceState: {
      lastUpdateId: null,
      handledUpdates: 0,
    },
    generationId: "gen-new",
    generationStore: {},
    updates: [
      { update_id: 51, callback_query: { id: "cbq-global", data: "gcfg:s:input" } },
      { update_id: 52, callback_query: { id: "cbq-topic", data: "tcfg:n:root" } },
      { update_id: 53, callback_query: { id: "cbq-other", data: "zoo:refresh" } },
    ],
  });

  assert.deepEqual(ackedUpdateIds, [53]);
});

test("processUpdates recovers locally when forwarding to a retiring owner times out", async () => {
  const patchedSessions = [];
  const localUpdates = [];
  const savedOffsets = [];

  const nextOffset = await withSuppressedConsole("warn", () => processUpdates({
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
    forwardUpdateImpl: async () => {
      throw new Error("IPC request timed out");
    },
    dispatchSpikeUpdateLocallyImpl: async ({ update }) => {
      localUpdates.push(update.update_id);
    },
    handleSpikeUpdateImpl: async () => {},
    lifecycleManager: null,
    promptFragmentAssembler: null,
    queuePromptAssembler: null,
    resolveSpikeUpdateRouteImpl: async () => ({
      type: "forward",
      session: {
        chat_id: "-1001234567890",
        topic_id: "2203",
        session_owner_generation_id: "gen-old",
        session_owner_mode: "retiring",
      },
      ownerGeneration: {
        ipc_endpoint: "http://127.0.0.1:9",
      },
    }),
    runtimeObserver: null,
    offsetStore: {
      async save(value) {
        savedOffsets.push(value);
      },
    },
    sessionStore: {
      async patch(session, patch) {
        patchedSessions.push({ session, patch });
        return { ...session, ...patch };
      },
    },
    sessionService: {},
    globalControlPanelStore: {},
    generalMessageLedgerStore: {},
    topicControlPanelStore: {},
    zooService: {},
    workerPool: {},
    serviceState: {
      lastUpdateId: null,
      handledUpdates: 0,
    },
    generationId: "gen-new",
    generationStore: {},
    updates: [
      {
        update_id: 61,
        message: {
          chat: { id: -1001234567890 },
          message_thread_id: 2203,
        },
      },
    ],
  }));

  assert.equal(nextOffset, 62);
  assert.deepEqual(savedOffsets, [62]);
  assert.deepEqual(localUpdates, [61]);
  assert.equal(patchedSessions.length, 1);
  assert.deepEqual(patchedSessions[0].patch, {
    session_owner_generation_id: null,
    session_owner_mode: null,
    session_owner_claimed_at: null,
    spike_run_owner_generation_id: null,
  });
});

test("processUpdates terminates a stuck retiring owner before local takeover of a running session", async () => {
  const localUpdates = [];
  const patchedSessions = [];
  const terminatedOwners = [];

  await withSuppressedConsole("warn", () => processUpdates({
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
    forwardUpdateImpl: async () => {
      throw new Error("IPC request timed out");
    },
    dispatchSpikeUpdateLocallyImpl: async ({ update }) => {
      localUpdates.push(update.update_id);
    },
    handleSpikeUpdateImpl: async () => {},
    lifecycleManager: null,
    promptFragmentAssembler: null,
    queuePromptAssembler: null,
    resolveSpikeUpdateRouteImpl: async () => ({
      type: "forward",
      session: {
        chat_id: "-1001234567890",
        topic_id: "2203",
        last_run_status: "running",
        session_owner_generation_id: "gen-old",
        session_owner_mode: "retiring",
      },
      ownerGeneration: {
        generation_id: "gen-old",
        pid: 90210,
        ipc_endpoint: "http://127.0.0.1:9",
      },
    }),
    runtimeObserver: null,
    offsetStore: {
      async save() {},
    },
    sessionStore: {
      async patch(session, patch) {
        patchedSessions.push({ session, patch });
        return { ...session, ...patch };
      },
    },
    sessionService: {},
    globalControlPanelStore: {},
    generalMessageLedgerStore: {},
    topicControlPanelStore: {},
    zooService: {},
    workerPool: {},
    serviceState: {
      lastUpdateId: null,
      handledUpdates: 0,
    },
    generationId: "gen-new",
    generationStore: {},
    terminateRetiringOwnerImpl: async (ownerGeneration) => {
      terminatedOwners.push(ownerGeneration);
      return true;
    },
    updates: [
      {
        update_id: 62,
        message: {
          text: "/interrupt",
          entities: [{ type: "bot_command", offset: 0, length: 10 }],
          chat: { id: -1001234567890 },
          message_thread_id: 2203,
        },
      },
    ],
  }));

  assert.equal(terminatedOwners.length, 1);
  assert.equal(terminatedOwners[0].pid, 90210);
  assert.deepEqual(localUpdates, [62]);
  assert.equal(patchedSessions.length, 1);
});

test("processUpdates still allows safe topic-panel navigation callback takeover when a running retiring owner cannot be terminated", async () => {
  const localUpdates = [];

  await withSuppressedConsole("warn", () => processUpdates({
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
    forwardUpdateImpl: async () => {
      throw new Error("IPC request timed out");
    },
    dispatchSpikeUpdateLocallyImpl: async ({ update }) => {
      localUpdates.push(update.update_id);
    },
    handleSpikeUpdateImpl: async () => {},
    lifecycleManager: null,
    promptFragmentAssembler: null,
    queuePromptAssembler: null,
    resolveSpikeUpdateRouteImpl: async () => ({
      type: "forward",
      session: {
        chat_id: "-1001234567890",
        topic_id: "2203",
        last_run_status: "running",
        session_owner_generation_id: "gen-old",
        session_owner_mode: "retiring",
      },
      ownerGeneration: {
        generation_id: "gen-old",
        pid: 90212,
        ipc_endpoint: "http://127.0.0.1:9",
      },
    }),
    runtimeObserver: null,
    offsetStore: {
      async save() {},
    },
    sessionStore: {
      async patch(session, patch) {
        return { ...session, ...patch };
      },
    },
    sessionService: {},
    globalControlPanelStore: {},
    generalMessageLedgerStore: {},
    topicControlPanelStore: {},
    zooService: {},
    workerPool: {},
    serviceState: {
      lastUpdateId: null,
      handledUpdates: 0,
    },
    generationId: "gen-new",
    generationStore: {},
    terminateRetiringOwnerImpl: async () => false,
    updates: [
      {
        update_id: 64,
        callback_query: {
          id: "cbq-safe-topic-nav",
          data: "tcfg:n:root",
          from: { id: 123456789, is_bot: false },
          message: {
            chat: { id: -1001234567890 },
            message_thread_id: 2203,
          },
        },
      },
    ],
  }));

  assert.deepEqual(localUpdates, [64]);
});

test("processUpdates refuses unsafe local takeover when a running retiring owner cannot be terminated", async () => {
  await withSuppressedConsole("warn", () => assert.rejects(
    () =>
      processUpdates({
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
        forwardUpdateImpl: async () => {
          throw new Error("IPC request timed out");
        },
        dispatchSpikeUpdateLocallyImpl: async () => {
          throw new Error("should not recover locally");
        },
        handleSpikeUpdateImpl: async () => {},
        lifecycleManager: null,
        promptFragmentAssembler: null,
        queuePromptAssembler: null,
        resolveSpikeUpdateRouteImpl: async () => ({
          type: "forward",
          session: {
            chat_id: "-1001234567890",
            topic_id: "2203",
            last_run_status: "running",
            session_owner_generation_id: "gen-old",
            session_owner_mode: "retiring",
          },
          ownerGeneration: {
            generation_id: "gen-old",
            pid: 90211,
            ipc_endpoint: "http://127.0.0.1:9",
          },
        }),
        runtimeObserver: null,
        offsetStore: {
          async save() {
            throw new Error("should not save offset after failed takeover");
          },
        },
        sessionStore: {
          async patch() {
            throw new Error("should not clear ownership");
          },
        },
        sessionService: {},
        globalControlPanelStore: {},
        generalMessageLedgerStore: {},
        topicControlPanelStore: {},
        zooService: {},
        workerPool: {},
        serviceState: {
          lastUpdateId: null,
          handledUpdates: 0,
        },
        generationId: "gen-new",
        generationStore: {},
        terminateRetiringOwnerImpl: async () => false,
        updates: [
          {
            update_id: 63,
            message: {
              text: "plain user prompt",
              chat: { id: -1001234567890 },
              message_thread_id: 2203,
            },
          },
        ],
      }),
    /could not be terminated safely before local takeover/u,
  ));
});

test("processUpdates refuses unsafe callback takeover when a running retiring owner cannot be terminated", async () => {
  await withSuppressedConsole("warn", () => assert.rejects(
    () =>
      processUpdates({
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
        forwardUpdateImpl: async () => {
          throw new Error("IPC request timed out");
        },
        dispatchSpikeUpdateLocallyImpl: async () => {
          throw new Error("should not recover locally");
        },
        handleSpikeUpdateImpl: async () => {},
        lifecycleManager: null,
        promptFragmentAssembler: null,
        queuePromptAssembler: null,
        resolveSpikeUpdateRouteImpl: async () => ({
          type: "forward",
          session: {
            chat_id: "-1001234567890",
            topic_id: "2203",
            last_run_status: "running",
            session_owner_generation_id: "gen-old",
            session_owner_mode: "retiring",
          },
          ownerGeneration: {
            generation_id: "gen-old",
            pid: 90213,
            ipc_endpoint: "http://127.0.0.1:9",
          },
        }),
        runtimeObserver: null,
        offsetStore: {
          async save() {
            throw new Error("should not save offset after failed takeover");
          },
        },
        sessionStore: {
          async patch() {
            throw new Error("should not clear ownership");
          },
        },
        sessionService: {},
        globalControlPanelStore: {},
        generalMessageLedgerStore: {},
        topicControlPanelStore: {},
        zooService: {},
        workerPool: {},
        serviceState: {
          lastUpdateId: null,
          handledUpdates: 0,
        },
        generationId: "gen-new",
        generationStore: {},
        terminateRetiringOwnerImpl: async () => false,
        updates: [
          {
            update_id: 65,
            callback_query: {
              id: "cbq-unsafe-topic-purge",
              data: "tcfg:cmd:purge",
              from: { id: 123456789, is_bot: false },
              message: {
                chat: { id: -1001234567890 },
                message_thread_id: 2203,
              },
            },
          },
        ],
      }),
    /could not be terminated safely before local takeover/u,
  ));
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
    await handler({
      type: "generation-probe",
      instance_token: "token-123",
    }),
    {
      generation_id: "gen-current",
      instance_token: "token-123",
    },
  );
  await assert.rejects(
    handler({
      type: "generation-probe",
      instance_token: "wrong-token",
    }),
    /Unauthorized/u,
  );

  assert.deepEqual(
    await handler({
      type: "spike-update",
      auth_token: "token-123",
      update: { update_id: 77 },
    }),
    { handled: true },
  );
  await assert.rejects(
    handler({
      type: "spike-update",
      auth_token: "wrong-token",
      update: { update_id: 78 },
    }),
    /Unauthorized/u,
  );
  assert.deepEqual(handledUpdates, [77]);
});
