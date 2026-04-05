import { markBootstrapDrop, markUpdateSeen } from "../runtime/service-state.js";
import { forwardUpdate } from "../runtime/update-forwarding-ipc.js";
import { ackBatchCallbackQueriesBestEffort } from "../telegram/callback-batch-ack.js";
import { handleSpikeUpdate } from "../telegram/spike-update-dispatch.js";
import { resolveSpikeUpdateRoute } from "../telegram/spike-update-routing.js";

const MESSAGE_UPDATES_ONLY = ["message"];

export async function ensureLongPollingReady(api, webhookInfo) {
  if (webhookInfo?.url) {
    await api.deleteWebhook({ drop_pending_updates: false });
  }
}

export async function bootstrapOffset({ api, offsetStore, serviceState }) {
  const existingOffset = await offsetStore.load();
  if (existingOffset !== null) {
    return existingOffset;
  }

  const bootstrapUpdates = await api.getUpdates({
    offset: -1,
    limit: 1,
    timeout: 0,
    allowed_updates: MESSAGE_UPDATES_ONLY,
  });

  if (bootstrapUpdates.length === 0) {
    return null;
  }

  const lastUpdate = bootstrapUpdates.at(-1);
  const nextOffset = lastUpdate.update_id + 1;
  markBootstrapDrop(serviceState, lastUpdate.update_id);
  await offsetStore.save(nextOffset);
  return nextOffset;
}

export async function noteOffsetSafe(runtimeObserver, nextOffset) {
  try {
    await runtimeObserver?.noteOffset(nextOffset);
  } catch (error) {
    console.warn(`offset heartbeat update failed: ${error.message}`);
  }
}

export async function dispatchSpikeUpdateLocally({
  api,
  botUsername,
  config,
  emergencyRouter,
  lifecycleManager,
  promptFragmentAssembler,
  queuePromptAssembler,
  runtimeObserver,
  sessionService,
  globalControlPanelStore,
  generalMessageLedgerStore,
  topicControlPanelStore,
  zooService,
  workerPool,
  serviceState,
  update,
  handleSpikeUpdateImpl = handleSpikeUpdate,
}) {
  await handleSpikeUpdateImpl({
    api,
    botUsername,
    config,
    emergencyRouter,
    lifecycleManager,
    promptFragmentAssembler,
    queuePromptAssembler,
    runtimeObserver,
    sessionService,
    globalControlPanelStore,
    generalMessageLedgerStore,
    topicControlPanelStore,
    zooService,
    workerPool,
    serviceState,
    update,
  });
}

export function createForwardingRequestHandler({
  api,
  botUsername,
  config,
  emergencyRouter,
  lifecycleManager,
  promptFragmentAssembler,
  queuePromptAssembler,
  runtimeObserver,
  sessionService,
  globalControlPanelStore,
  generalMessageLedgerStore,
  topicControlPanelStore,
  zooService,
  workerPool,
  serviceState,
  generationId,
  instanceToken,
  dispatchSpikeUpdateLocallyImpl = dispatchSpikeUpdateLocally,
}) {
  return async (payload) => {
    if (payload?.type === "generation-probe") {
      return {
        generation_id: generationId,
        instance_token: instanceToken,
      };
    }

    if (payload?.type !== "spike-update" || !payload?.update) {
      throw new Error("Unsupported forwarded spike request");
    }

    await dispatchSpikeUpdateLocallyImpl({
      api,
      botUsername,
      config,
      emergencyRouter,
      lifecycleManager,
      promptFragmentAssembler,
      queuePromptAssembler,
      runtimeObserver,
      sessionService,
      globalControlPanelStore,
      generalMessageLedgerStore,
      topicControlPanelStore,
      zooService,
      workerPool,
      serviceState,
      update: payload.update,
    });

    return { handled: true };
  };
}

export async function processUpdates({
  api,
  botUsername,
  config,
  ackBatchCallbackQueriesImpl = ackBatchCallbackQueriesBestEffort,
  emergencyRouter,
  forwardUpdateImpl = forwardUpdate,
  dispatchSpikeUpdateLocallyImpl = dispatchSpikeUpdateLocally,
  handleSpikeUpdateImpl = handleSpikeUpdate,
  lifecycleManager,
  promptFragmentAssembler,
  queuePromptAssembler,
  resolveSpikeUpdateRouteImpl = resolveSpikeUpdateRoute,
  runtimeObserver,
  offsetStore,
  sessionStore,
  sessionService,
  globalControlPanelStore,
  generalMessageLedgerStore,
  topicControlPanelStore,
  zooService,
  workerPool,
  serviceState,
  generationId,
  generationStore,
  updates,
}) {
  let nextOffset = null;
  await ackBatchCallbackQueriesImpl(api, updates);

  for (const update of updates) {
    const updateId = update.update_id;
    markUpdateSeen(serviceState, updateId);
    nextOffset = updateId + 1;

    const route = await resolveSpikeUpdateRouteImpl({
      update,
      generationId,
      generationStore,
      sessionStore,
    });

    if (route.type === "forward") {
      await forwardUpdateImpl({
        endpoint: route.ownerGeneration.ipc_endpoint,
        payload: {
          type: "spike-update",
          update,
        },
      });
    } else {
      await dispatchSpikeUpdateLocallyImpl({
        api,
        botUsername,
        config,
        emergencyRouter,
        lifecycleManager,
        promptFragmentAssembler,
        queuePromptAssembler,
        runtimeObserver,
        sessionService,
        globalControlPanelStore,
        generalMessageLedgerStore,
        topicControlPanelStore,
        zooService,
        workerPool,
        serviceState,
        update,
        handleSpikeUpdateImpl,
      });
    }

    await offsetStore.save(nextOffset);
    await noteOffsetSafe(runtimeObserver, nextOffset);
  }

  return nextOffset;
}
