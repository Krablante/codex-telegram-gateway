import process from "node:process";

import { markBootstrapDrop, markUpdateSeen } from "../runtime/service-state.js";
import { isProcessAlive } from "../runtime/service-generation-store.js";
import { forwardUpdate } from "../runtime/update-forwarding-ipc.js";
import {
  clearSessionOwnershipPatch,
  resolveSessionOwnerGenerationId,
} from "../rollout/session-ownership.js";
import { ackBatchCallbackQueriesBestEffort } from "../telegram/callback-batch-ack.js";
import { isGlobalControlCallbackQuery } from "../telegram/global-control-panel.js";
import { parseGlobalControlCallbackData } from "../telegram/global-control-panel-view.js";
import { handleSpikeUpdate } from "../telegram/spike-update-dispatch.js";
import { resolveSpikeUpdateRoute } from "../telegram/spike-update-routing.js";
import { isTopicControlCallbackQuery } from "../telegram/topic-control-panel.js";
import { parseTopicControlCallbackData } from "../telegram/topic-control-panel-view.js";

const MESSAGE_UPDATES_ONLY = ["message"];
const RETIRING_OWNER_TERM_GRACE_MS = 1500;
const RETIRING_OWNER_TERM_POLL_MS = 50;
const SAFE_GLOBAL_RECOVERY_CALLBACK_KINDS = new Set([
  "guide_show",
  "help_show",
  "navigate",
  "zoo_show",
]);
const SAFE_TOPIC_RECOVERY_CALLBACK_KINDS = new Set([
  "help_show",
  "navigate",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldDeferCallbackAck(update) {
  const callbackQuery = update?.callback_query;
  if (!callbackQuery) {
    return false;
  }

  return (
    isGlobalControlCallbackQuery(callbackQuery) ||
    isTopicControlCallbackQuery(callbackQuery)
  );
}

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

function isRecoverableForwardingError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return (
    message.includes("ipc request timed out")
    || message.includes("econnrefused")
    || message.includes("socket hang up")
    || message.includes("fetch failed")
  );
}

function extractCommandName(update) {
  const message = update?.message;
  const text = typeof message?.text === "string" ? message.text : null;
  const entity = Array.isArray(message?.entities)
    ? message.entities.find((candidate) =>
      candidate?.type === "bot_command" && Number(candidate?.offset) === 0)
    : null;
  if (!text || !entity || !Number.isInteger(entity.length) || entity.length <= 1) {
    return null;
  }

  const rawCommand = text.slice(1, entity.length).trim();
  if (!rawCommand) {
    return null;
  }

  return rawCommand.split("@", 1)[0].toLowerCase();
}

function isSafeLocalRecoveryUpdate(update) {
  const callbackQuery = update?.callback_query;
  if (callbackQuery) {
    if (isGlobalControlCallbackQuery(callbackQuery)) {
      const parsed = parseGlobalControlCallbackData(callbackQuery.data);
      return SAFE_GLOBAL_RECOVERY_CALLBACK_KINDS.has(parsed?.kind);
    }

    if (isTopicControlCallbackQuery(callbackQuery)) {
      const parsed = parseTopicControlCallbackData(callbackQuery.data);
      return SAFE_TOPIC_RECOVERY_CALLBACK_KINDS.has(parsed?.kind);
    }

    return false;
  }

  const commandName = extractCommandName(update);
  return commandName === "menu" || commandName === "status";
}

async function terminateRetiringOwnerGeneration(
  ownerGeneration,
  {
    processImpl = process,
    processAliveImpl = isProcessAlive,
    graceMs = RETIRING_OWNER_TERM_GRACE_MS,
    pollMs = RETIRING_OWNER_TERM_POLL_MS,
  } = {},
) {
  const pid = Number.isInteger(ownerGeneration?.pid) && ownerGeneration.pid > 0
    ? ownerGeneration.pid
    : null;
  if (!pid) {
    return false;
  }

  const waitForExit = async () => {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (!processAliveImpl(pid)) {
        return true;
      }
      await sleep(pollMs);
    }
    return !processAliveImpl(pid);
  };

  try {
    processImpl.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") {
      return true;
    }
  }
  if (await waitForExit()) {
    return true;
  }

  try {
    processImpl.kill(pid, "SIGKILL");
  } catch (error) {
    if (error?.code === "ESRCH") {
      return true;
    }
  }

  return waitForExit();
}

async function recoverForwardedUpdateLocally({
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
  dispatchSpikeUpdateLocallyImpl,
  sessionStore,
  route,
  error,
  terminateRetiringOwnerImpl = terminateRetiringOwnerGeneration,
}) {
  const session = route?.session ?? null;
  const ownerMode = String(session?.session_owner_mode ?? "").trim().toLowerCase();
  if (
    ownerMode !== "retiring"
    || !session
    || !isRecoverableForwardingError(error)
  ) {
    throw error;
  }

  console.warn(
    [
      `forwarding update ${update?.update_id ?? "unknown"} to retiring owner`,
      `${session.session_owner_generation_id || "unknown-owner"} failed: ${error.message}`,
      "recovering locally",
    ].join(" "),
  );

  const runStillMarkedRunning =
    String(session?.last_run_status ?? "").trim().toLowerCase() === "running";
  if (runStillMarkedRunning) {
    const ownerTerminated = await terminateRetiringOwnerImpl(route?.ownerGeneration);
    if (!ownerTerminated) {
      if (!isSafeLocalRecoveryUpdate(update)) {
        throw new Error(
          "Retiring owner stalled and could not be terminated safely before local takeover",
        );
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
        update,
        handleSpikeUpdateImpl,
      });
      return;
    }
  }

  await clearRetiringOwnerIfCurrent(sessionStore, session, route?.ownerGeneration);

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

async function clearRetiringOwnerIfCurrent(sessionStore, session, ownerGeneration = null) {
  if (!sessionStore || !session) {
    return;
  }

  const expectedOwnerId =
    String(ownerGeneration?.generation_id || "").trim()
    || resolveSessionOwnerGenerationId(session);
  const clearPatch = {
    ...clearSessionOwnershipPatch(),
    spike_run_owner_generation_id: null,
  };

  if (typeof sessionStore.patchWithCurrent === "function") {
    await sessionStore.patchWithCurrent(session, (current) => {
      const currentOwnerId = resolveSessionOwnerGenerationId(current);
      if (expectedOwnerId && currentOwnerId && currentOwnerId !== expectedOwnerId) {
        return {};
      }
      return clearPatch;
    });
    return;
  }

  if (typeof sessionStore.patch === "function") {
    await sessionStore.patch(session, clearPatch);
  }
}

async function dispatchSpikeUpdateLocally({
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
      const providedInstanceToken =
        typeof payload?.instance_token === "string"
        && payload.instance_token.trim()
          ? payload.instance_token.trim()
          : null;
      if (
        instanceToken
        && providedInstanceToken
        && providedInstanceToken !== instanceToken
      ) {
        throw new Error("Unauthorized forwarded spike probe");
      }
      return {
        generation_id: generationId,
        instance_token: instanceToken || null,
      };
    }

    if (payload?.type !== "spike-update" || !payload?.update) {
      throw new Error("Unsupported forwarded spike request");
    }
    if (instanceToken && payload?.auth_token !== instanceToken) {
      throw new Error("Unauthorized forwarded spike request");
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
  terminateRetiringOwnerImpl = terminateRetiringOwnerGeneration,
}) {
  let nextOffset = null;
  await ackBatchCallbackQueriesImpl(
    api,
    updates.filter((update) => !shouldDeferCallbackAck(update)),
  );

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
      try {
        await forwardUpdateImpl({
          endpoint: route.ownerGeneration.ipc_endpoint,
          authToken: route.ownerGeneration.instance_token,
          payload: {
            type: "spike-update",
            update,
          },
        });
      } catch (error) {
        await recoverForwardedUpdateLocally({
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
          dispatchSpikeUpdateLocallyImpl,
          sessionStore,
          route,
          error,
          terminateRetiringOwnerImpl,
        });
      }
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
