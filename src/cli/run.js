import crypto from "node:crypto";
import process from "node:process";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { CodexLimitsService } from "../codex-runtime/limits.js";
import { CodexWorkerPool } from "../pty-worker/worker-pool.js";
import { createServiceState, markBootstrapDrop, markPollError, markUpdateSeen } from "../runtime/service-state.js";
import { RuntimeObserver } from "../runtime/runtime-observer.js";
import { SessionCompactor } from "../session-manager/session-compactor.js";
import { SpikeFinalEventStore } from "../session-manager/spike-final-event-store.js";
import { GlobalCodexSettingsStore } from "../session-manager/global-codex-settings-store.js";
import { GlobalControlPanelStore } from "../session-manager/global-control-panel-store.js";
import { GeneralMessageLedgerStore } from "../session-manager/general-message-ledger-store.js";
import { GlobalPromptSuffixStore } from "../session-manager/global-prompt-suffix-store.js";
import { SessionLifecycleManager } from "../session-manager/session-lifecycle-manager.js";
import { SpikePromptQueueStore } from "../session-manager/prompt-queue.js";
import { RolloutCoordinationStore } from "../session-manager/rollout-coordination-store.js";
import { SessionService } from "../session-manager/session-service.js";
import { SessionStore } from "../session-manager/session-store.js";
import { TopicControlPanelStore } from "../session-manager/topic-control-panel-store.js";
import { UpdateOffsetStore } from "../session-manager/update-offset-store.js";
import { ensureStateLayout } from "../state/layout.js";
import { TelegramBotApiClient } from "../telegram/bot-api-client.js";
import { ackBatchCallbackQueriesBestEffort } from "../telegram/callback-batch-ack.js";
import { syncTelegramCommandCatalog } from "../telegram/command-catalog.js";
import { createTrackedGeneralApi } from "../telegram/general-message-cleanup.js";
import { PromptFragmentAssembler } from "../telegram/prompt-fragment-assembler.js";
import { runTelegramProbe } from "../telegram/probe.js";
import { EmergencyPrivateChatRouter } from "../emergency/private-chat-router.js";
import { OmniPromptHandoffStore, drainPendingOmniPrompts } from "../omni/prompt-handoff.js";
import { disableOmniStateAcrossSessions } from "../omni/disabled-state.js";
import { ZooService } from "../zoo/service.js";
import { ServiceGenerationStore } from "../runtime/service-generation-store.js";
import {
  buildForwardingEndpoint,
  forwardUpdate,
  UpdateForwardingServer,
} from "../runtime/update-forwarding-ipc.js";
import {
  collectOwnedSessionKeys,
  markOwnedSessionsRetiring,
  spawnReplacementGeneration,
  waitForGenerationReady,
} from "../runtime/service-rollout.js";
import { handleSpikeUpdate } from "../telegram/spike-update-dispatch.js";
import { resolveSpikeUpdateRoute } from "../telegram/spike-update-routing.js";

const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"];
const MESSAGE_UPDATES_ONLY = ["message"];
const RUN_ONCE = process.env.RUN_ONCE === "1";
const LEADER_WAIT_MS = 1000;
const GENERATION_HEARTBEAT_MS = 3000;
const ROLLOUT_READY_TIMEOUT_MS = 15000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGenerationId() {
  const explicit = String(process.env.SERVICE_GENERATION_ID ?? "").trim();
  if (explicit) {
    return explicit;
  }

  return `spike-${process.pid}-${crypto.randomUUID()}`;
}

async function ensureLongPollingReady(api, webhookInfo) {
  if (webhookInfo?.url) {
    await api.deleteWebhook({ drop_pending_updates: false });
  }
}

async function bootstrapOffset({ api, offsetStore, serviceState }) {
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

async function noteOffsetSafe(runtimeObserver, nextOffset) {
  try {
    await runtimeObserver?.noteOffset(nextOffset);
  } catch (error) {
    console.warn(`offset heartbeat update failed: ${error.message}`);
  }
}

async function processUpdates({
  api,
  botUsername,
  config,
  emergencyRouter,
  lifecycleManager,
  promptFragmentAssembler,
  queuePromptAssembler,
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
  await ackBatchCallbackQueriesBestEffort(api, updates);

  for (const update of updates) {
    const updateId = update.update_id;
    markUpdateSeen(serviceState, updateId);
    nextOffset = updateId + 1;

    const route = await resolveSpikeUpdateRoute({
      update,
      generationId,
      generationStore,
      sessionStore,
    });

    if (route.type === "forward") {
      await forwardUpdate({
        endpoint: route.ownerGeneration.ipc_endpoint,
        payload: {
          type: "spike-update",
          update,
        },
      });
    } else {
      await handleSpikeUpdate({
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

    await offsetStore.save(nextOffset);
    await noteOffsetSafe(runtimeObserver, nextOffset);
  }

  return nextOffset;
}

async function main() {
  const config = await loadRuntimeConfig();
  const layout = await ensureStateLayout(config.stateRoot);
  const api = new TelegramBotApiClient({
    token: config.telegramBotToken,
    baseUrl: config.telegramApiBaseUrl,
  });
  const probe = await runTelegramProbe(config, api);
  const serviceState = createServiceState(config, probe);
  serviceState.generationId = createGenerationId();
  serviceState.isLeader = false;
  serviceState.retiring = false;
  const runtimeObserver = new RuntimeObserver({
    logsDir: layout.logs,
    config,
    serviceState,
    probe,
    mode: RUN_ONCE ? "smoke" : "poller",
  });
  const offsetStore = new UpdateOffsetStore(layout.indexes);
  const globalPromptSuffixStore = new GlobalPromptSuffixStore(layout.settings);
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(layout.settings);
  const globalControlPanelStore = new GlobalControlPanelStore(layout.settings);
  const generalMessageLedgerStore = new GeneralMessageLedgerStore(layout.settings);
  const codexLimitsService = new CodexLimitsService({
    sessionsRoot: config.codexLimitsSessionsRoot,
    command: config.codexLimitsCommand,
    cacheTtlMs: config.codexLimitsCacheTtlSecs * 1000,
    commandTimeoutMs: config.codexLimitsCommandTimeoutSecs * 1000,
  });
  const trackedApi = createTrackedGeneralApi(
    api,
    config,
    generalMessageLedgerStore,
  );
  const sessionStore = new SessionStore(layout.sessions);
  const generationStore = new ServiceGenerationStore({
    indexesRoot: layout.indexes,
    tmpRoot: layout.tmp,
    serviceKind: "spike",
    generationId: serviceState.generationId,
  });
  const rolloutCoordinationStore = new RolloutCoordinationStore(layout.settings);
  const forwardingEndpoint = buildForwardingEndpoint({
    stateRoot: config.stateRoot,
    serviceKind: "spike",
    generationId: serviceState.generationId,
  });
  const getForwardingEndpoint = () =>
    forwardingServer?.endpoint || forwardingEndpoint;
  const promptQueueStore = new SpikePromptQueueStore(sessionStore);
  const topicControlPanelStore = new TopicControlPanelStore(sessionStore);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const promptHandoffStore = new OmniPromptHandoffStore(sessionStore);
  const sessionCompactor = new SessionCompactor({ sessionStore, config });
  const sessionLifecycleManager = new SessionLifecycleManager({
    config,
    sessionStore,
    sessionCompactor,
    runtimeObserver,
  });
  const sessionService = new SessionService({
    sessionStore,
    config,
    sessionCompactor,
    runtimeObserver,
    globalPromptSuffixStore,
    globalCodexSettingsStore,
    promptQueueStore,
    codexLimitsService,
  });
  void sessionService.getCodexLimitsSummary({ force: true }).catch((error) => {
    console.warn(`Codex limits warmup failed: ${error.message}`);
  });
  const zooService = new ZooService({
    config,
    sessionService,
    globalControlPanelStore,
  });
  let forwardingServer = null;
  let workerPool = null;
  const handleRunTerminated = async ({ session }) => {
    if (!session) {
      return;
    }

    if (serviceState.retiring) {
      return;
    }

    await sessionService.drainPromptQueue(workerPool, {
      session,
      currentGenerationId: serviceState.generationId,
    });
  };
  workerPool = new CodexWorkerPool({
    api: trackedApi,
    config,
    sessionStore,
    serviceState,
    sessionCompactor,
    sessionLifecycleManager,
    spikeFinalEventStore,
    globalCodexSettingsStore,
    serviceGenerationId: serviceState.generationId,
    onRunTerminated: handleRunTerminated,
  });
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const queuePromptAssembler = new PromptFragmentAssembler();
  const emergencyRouter = new EmergencyPrivateChatRouter({
    api: trackedApi,
    botUsername: serviceState.botUsername,
    config,
    normalRunState: {
      hasActiveRuns: () => workerPool.hasActiveOrStartingRuns(),
      getRunCount: () => workerPool.getActiveOrStartingRunCount(),
    },
  });
  sessionLifecycleManager.workerPool = workerPool;
  forwardingServer = new UpdateForwardingServer({
    endpoint: forwardingEndpoint,
    onRequest: async (payload) => {
      if (payload?.type === "generation-probe") {
        return {
          generation_id: serviceState.generationId,
          instance_token: generationStore.instanceToken,
        };
      }

      if (payload?.type !== "spike-update" || !payload?.update) {
        throw new Error("Unsupported forwarded spike request");
      }

      await handleSpikeUpdate({
        api: trackedApi,
        botUsername: serviceState.botUsername,
        config,
        emergencyRouter,
        lifecycleManager: sessionLifecycleManager,
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
    },
  });
  await forwardingServer.start();
  await generationStore.pruneStaleGenerations().catch(() => {});
  await generationStore.heartbeat({
    mode: "standby",
    ipcEndpoint: getForwardingEndpoint(),
  });
  serviceState.rolloutStatus = (await rolloutCoordinationStore.load()).status;

  if (config.omniEnabled === false) {
    const disabledSummary = await disableOmniStateAcrossSessions({
      sessionStore,
      promptHandoffStore,
    });
    if (disabledSummary.autoSessionsDisarmed > 0 || disabledSummary.handoffsCleared > 0) {
      console.log(
        `omni disabled: disarmed ${disabledSummary.autoSessionsDisarmed} session(s) and cleared ${disabledSummary.handoffsCleared} queued handoff(s)`,
      );
    }
  }

  let currentOffset = null;
  await runtimeObserver.start({ currentOffset });
  let lastRetentionSweepAt = 0;
  let pollAbortController = null;
  let shutdownPromise = null;
  let stopRequested = false;
  let rolloutRequested = false;
  let rolloutPromise = null;
  const scriptPath = process.argv[1];
  const heartbeatTimer = setInterval(() => {
    void runtimeObserver.writeHeartbeat().catch(() => {});
  }, 15000);
  heartbeatTimer.unref();
  const reconcileRolloutState = async () => {
    const currentState = await rolloutCoordinationStore.load({ force: true });
    if (
      currentState.status === "in_progress"
      && currentState.target_generation_id === serviceState.generationId
    ) {
      const retiringGeneration =
        currentState.retiring_generation_id
          ? await generationStore.loadGeneration(currentState.retiring_generation_id)
          : null;
      if (
        !currentState.retiring_generation_id
        || !await generationStore.isGenerationRecordVerifiablyLive(retiringGeneration)
      ) {
        const completed = await rolloutCoordinationStore.completeRollout({
          currentGenerationId: serviceState.generationId,
        });
        serviceState.rolloutStatus = completed.status;
        return completed;
      }
    }

    serviceState.rolloutStatus = currentState.status;
    return currentState;
  };
  const generationHeartbeatTimer = setInterval(() => {
    const mode = serviceState.retiring
      ? "retiring"
      : serviceState.isLeader
        ? "leader"
        : "standby";
    void generationStore.heartbeat({
      mode,
      ipcEndpoint: getForwardingEndpoint(),
    }).catch(() => {});
    if (serviceState.isLeader) {
      void reconcileRolloutState().catch(() => {});
      void generationStore.renewLeadership()
        .then((renewed) => {
          if (!renewed && !serviceState.retiring && !stopRequested) {
            serviceState.isLeader = false;
            pollAbortController?.abort();
          }
        })
        .catch(() => {});
    }
  }, GENERATION_HEARTBEAT_MS);
  generationHeartbeatTimer.unref();
  let retentionSweepInFlight = false;
  let promptHandoffScanInFlight = false;
  let promptQueueScanInFlight = false;
  const scanPendingOmniPrompts = async () => {
    if (config.omniEnabled === false) {
      return;
    }
    if (promptHandoffScanInFlight || !serviceState.isLeader || serviceState.retiring) {
      return;
    }

    promptHandoffScanInFlight = true;
    await drainPendingOmniPrompts({
      api,
      botUsername: serviceState.botUsername,
      config,
      lifecycleManager: sessionLifecycleManager,
      promptFragmentAssembler,
      serviceState,
      sessionService,
      sessionStore,
      currentGenerationId: serviceState.generationId,
      workerPool,
      promptHandoffStore,
    })
      .catch((error) => {
        console.error(`omni prompt handoff scan failed: ${error.message}`);
      })
      .finally(() => {
        promptHandoffScanInFlight = false;
      });
  };
  const scanPendingSpikeQueue = async () => {
    if (promptQueueScanInFlight || !serviceState.isLeader || serviceState.retiring) {
      return;
    }

    promptQueueScanInFlight = true;
    await sessionService.drainPromptQueue(workerPool, {
      currentGenerationId: serviceState.generationId,
    })
      .catch((error) => {
        console.error(`spike prompt queue scan failed: ${error.message}`);
      })
      .finally(() => {
        promptQueueScanInFlight = false;
      });
  };
  const promptHandoffTimer = setInterval(() => {
    void scanPendingOmniPrompts().then(() => scanPendingSpikeQueue());
  }, 1000);
  promptHandoffTimer.unref();
  const retentionSweepTimer = setInterval(() => {
    if (retentionSweepInFlight || !serviceState.isLeader || serviceState.retiring) {
      return;
    }

    retentionSweepInFlight = true;
    void sessionLifecycleManager.sweepExpiredParkedSessions()
      .then(async () => {
        lastRetentionSweepAt = Date.now();
        await runtimeObserver.noteRetentionSweep(
          new Date(lastRetentionSweepAt).toISOString(),
        );
      })
      .catch((error) => {
        console.error(`retention sweep failed: ${error.message}`);
      })
      .finally(() => {
        retentionSweepInFlight = false;
      });
  }, config.retentionSweepIntervalSecs * 1000);
  retentionSweepTimer.unref();

  console.log(
    `poller starting for @${serviceState.botUsername || "no-username"} in chat ${config.telegramForumChatId} [generation=${serviceState.generationId}]`,
  );

  const stop = () => {
    stopRequested = true;
    serviceState.isLeader = false;
    const canceled = promptFragmentAssembler.cancelAll();
    if (canceled.canceledEntries > 0) {
      console.warn(
        `discarded ${canceled.canceledMessages} buffered Telegram fragment(s) across ${canceled.canceledEntries} prompt(s) during shutdown`,
      );
    }
    const canceledQueued = queuePromptAssembler.cancelAll();
    if (canceledQueued.canceledEntries > 0) {
      console.warn(
        `discarded ${canceledQueued.canceledMessages} buffered queue fragment(s) across ${canceledQueued.canceledEntries} prompt(s) during shutdown`,
      );
    }
    pollAbortController?.abort();
    shutdownPromise ??= Promise.allSettled([
      workerPool.shutdown(),
      emergencyRouter.shutdown(),
      generationStore.releaseLeadership(),
      generationStore.clearHeartbeat(),
      forwardingServer.stop(),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
    });
  };
  const retire = () => {
    if (serviceState.retiring || stopRequested) {
      return;
    }

    serviceState.retiring = true;
    serviceState.isLeader = false;
    pollAbortController?.abort();
    void generationStore.releaseLeadership().catch((error) => {
      console.warn(`failed to release leader lease during retire: ${error.message}`);
    });
  };
  const maybeStartRollout = async () => {
    if (
      rolloutPromise
      || stopRequested
      || serviceState.retiring
      || !serviceState.isLeader
    ) {
      return;
    }

    rolloutPromise = (async () => {
      const targetGenerationId = createGenerationId();
      const retainedSessionKeys = collectOwnedSessionKeys(workerPool);
      let replacement = null;

      try {
        await rolloutCoordinationStore.requestRollout({
          currentGenerationId: serviceState.generationId,
          targetGenerationId,
          requestedBy: "signal:SIGUSR2",
        });
        serviceState.rolloutStatus = "requested";

        replacement = spawnReplacementGeneration({
          config,
          generationId: targetGenerationId,
          parentGenerationId: serviceState.generationId,
          scriptPath,
        });
        replacement.unref();

        const readyGeneration = await waitForGenerationReady({
          generationStore,
          generationId: targetGenerationId,
          timeoutMs: ROLLOUT_READY_TIMEOUT_MS,
        });
        if (!readyGeneration) {
          throw new Error(
            `replacement generation ${targetGenerationId} did not become ready`,
          );
        }

        await markOwnedSessionsRetiring({
          workerPool,
          sessionStore,
          generationId: serviceState.generationId,
        });
        await rolloutCoordinationStore.startRollout({
          currentGenerationId: targetGenerationId,
          targetGenerationId,
          retiringGenerationId: serviceState.generationId,
          retainedSessionKeys,
        });
        serviceState.rolloutStatus = "in_progress";
        retire();
      } catch (error) {
        if (replacement && !replacement.killed) {
          replacement.kill("SIGINT");
        }
        serviceState.rolloutStatus = "failed";
        await rolloutCoordinationStore.failRollout(error.message, {
          currentGenerationId: serviceState.generationId,
          targetGenerationId,
          retiringGenerationId: serviceState.generationId,
        });
        console.error(`rollout request failed: ${error.message}`);
      } finally {
        rolloutRequested = false;
        rolloutPromise = null;
      }
    })();

    await rolloutPromise;
  };
  const requestRollout = () => {
    if (rolloutRequested || stopRequested) {
      return;
    }

    rolloutRequested = true;
    void maybeStartRollout();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (process.platform !== "win32") {
    process.on("SIGUSR2", requestRollout);
  }

  try {
    while (!stopRequested) {
      if (serviceState.retiring) {
        if (!workerPool.hasActiveOrStartingRuns()) {
          break;
        }

        await sleep(250);
        continue;
      }

      if (!serviceState.isLeader) {
        const acquiredLeadership = await generationStore.acquireLeadership()
          .catch((error) => {
            console.error(`leader acquisition failed: ${error.message}`);
            return false;
          });

        if (!acquiredLeadership) {
          await sleep(LEADER_WAIT_MS);
          continue;
        }

        serviceState.isLeader = true;
        await generationStore.heartbeat({
          mode: "leader",
          ipcEndpoint: getForwardingEndpoint(),
        });
        await ensureLongPollingReady(api, probe.webhookInfo);
        try {
          await syncTelegramCommandCatalog(api, "spike", config.telegramForumChatId, {
            omniEnabled: config.omniEnabled,
          });
        } catch (error) {
          console.warn(`Telegram command sync failed for Spike: ${error.message}`);
        }
        await reconcileRolloutState().catch(() => {});
        currentOffset = await bootstrapOffset({ api, offsetStore, serviceState });
        await noteOffsetSafe(runtimeObserver, currentOffset);
        if (serviceState.bootstrapDroppedUpdateId !== null) {
          await runtimeObserver.noteBootstrapDrop(serviceState.bootstrapDroppedUpdateId);
        }
        if (rolloutRequested) {
          void maybeStartRollout();
        }
        continue;
      }

      pollAbortController = new AbortController();
      try {
        const updates = await api.getUpdates(
          {
            offset: currentOffset ?? undefined,
            limit: 100,
            timeout: config.telegramPollTimeoutSecs,
            allowed_updates: TELEGRAM_ALLOWED_UPDATES,
          },
          { signal: pollAbortController.signal },
        );

        if (updates.length === 0) {
          if (RUN_ONCE) {
            await scanPendingOmniPrompts();
            await scanPendingSpikeQueue();
            await sessionLifecycleManager.sweepExpiredParkedSessions();
            lastRetentionSweepAt = Date.now();
            await runtimeObserver.noteRetentionSweep(
              new Date(lastRetentionSweepAt).toISOString(),
            );
            await promptFragmentAssembler.flushAll();
            await queuePromptAssembler.flushAll();
            break;
          }

          continue;
        }

        currentOffset = await processUpdates({
          api: trackedApi,
          botUsername: serviceState.botUsername,
          config,
          emergencyRouter,
          lifecycleManager: sessionLifecycleManager,
          promptFragmentAssembler,
          queuePromptAssembler,
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
          generationId: serviceState.generationId,
          generationStore,
          updates,
        });
        if (RUN_ONCE) {
          await scanPendingOmniPrompts();
          await scanPendingSpikeQueue();
          await sessionLifecycleManager.sweepExpiredParkedSessions();
          lastRetentionSweepAt = Date.now();
          await runtimeObserver.noteRetentionSweep(
            new Date(lastRetentionSweepAt).toISOString(),
          );
          await promptFragmentAssembler.flushAll();
          await queuePromptAssembler.flushAll();
          break;
        }
      } catch (error) {
        if (pollAbortController.signal.aborted) {
          continue;
        }

        markPollError(serviceState);
        console.error(`poll cycle failed: ${error.message}`);
        await runtimeObserver.notePollError(error);
        await sleep(2000);
      } finally {
        pollAbortController = null;
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(generationHeartbeatTimer);
    clearInterval(promptHandoffTimer);
    clearInterval(retentionSweepTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (process.platform !== "win32") {
      process.off("SIGUSR2", requestRollout);
    }
    shutdownPromise ??= Promise.allSettled([
      workerPool.shutdown(),
      emergencyRouter.shutdown(),
      generationStore.releaseLeadership(),
      generationStore.clearHeartbeat(),
      forwardingServer.stop(),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
    });
    if (shutdownPromise) {
      await shutdownPromise.catch((error) => {
        console.error(`worker shutdown failed: ${error.message}`);
      });
    }
    await runtimeObserver.stop({
      status: process.exitCode ? "failed" : "stopped",
    });
  }

  console.log("poller stopped");
}

main().catch((error) => {
  console.error(`run failed: ${error.message}`);
  process.exitCode = 1;
});
