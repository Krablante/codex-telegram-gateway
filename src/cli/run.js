import crypto from "node:crypto";
import process from "node:process";

import { CodexWorkerPool } from "../pty-worker/worker-pool.js";
import { markPollError } from "../runtime/service-state.js";
import { syncTelegramCommandCatalog } from "../telegram/command-catalog.js";
import { PromptFragmentAssembler } from "../telegram/prompt-fragment-assembler.js";
import { EmergencyPrivateChatRouter } from "../emergency/private-chat-router.js";
import { disableOmniStateAcrossSessions } from "../omni/disabled-state.js";
import {
  UpdateForwardingServer,
} from "../runtime/update-forwarding-ipc.js";
import {
  bootstrapOffset,
  createForwardingRequestHandler,
  ensureLongPollingReady,
  noteOffsetSafe,
  processUpdates,
} from "./run-update-processing.js";
import { createBackgroundJobs } from "./run-background-jobs.js";
import { performRunOnceMaintenance } from "./run-maintenance.js";
import { createRolloutController } from "./run-rollout-controller.js";
import { createRunRuntimeContext } from "./run-runtime-context.js";
import { recoverStaleRunningSessions } from "./run-stale-run-recovery.js";

const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"];
const RUN_ONCE = process.env.RUN_ONCE === "1";
const LEADER_WAIT_MS = 1000;

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

async function main() {
  const {
    api,
    config,
    forwardingEndpoint,
    generalMessageLedgerStore,
    generationStore,
    globalCodexSettingsStore,
    globalControlPanelStore,
    offsetStore,
    probe,
    promptHandoffStore,
    runtimeObserver,
    rolloutCoordinationStore,
    serviceState,
    sessionCompactor,
    sessionLifecycleManager,
    sessionService,
    sessionStore,
    spikeFinalEventStore,
    topicControlPanelStore,
    trackedApi,
    zooService,
  } = await createRunRuntimeContext({
    generationId: createGenerationId(),
    runOnce: RUN_ONCE,
  });
  const getForwardingEndpoint = () =>
    forwardingServer?.endpoint || forwardingEndpoint;
  void sessionService.getCodexLimitsSummary({ force: true }).catch((error) => {
    console.warn(`Codex limits warmup failed: ${error.message}`);
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
    runtimeObserver,
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
  const forwardingRequestHandler = createForwardingRequestHandler({
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
    generationId: serviceState.generationId,
    instanceToken: generationStore.instanceToken,
  });
  forwardingServer = new UpdateForwardingServer({
    endpoint: forwardingEndpoint,
    onRequest: forwardingRequestHandler,
  });
  await forwardingServer.start();
  await generationStore.pruneStaleGenerations().catch(() => {});
  const recoveredStaleSessions = await recoverStaleRunningSessions({
    generationStore,
    sessionStore,
    spikeFinalEventStore,
  }).catch((error) => {
    console.error(`stale run recovery failed: ${error.message}`);
    return [];
  });
  if (recoveredStaleSessions.length > 0) {
    console.warn(
      `recovered ${recoveredStaleSessions.length} stale running session(s) at startup`,
    );
  }
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
  let pollAbortController = null;
  let shutdownPromise = null;
  let stopRequested = false;
  const rolloutController = createRolloutController({
    config,
    createGenerationId,
    generationStore,
    rolloutCoordinationStore,
    serviceState,
    sessionStore,
    workerPool,
    scriptPath: process.argv[1],
    getPollAbortController: () => pollAbortController,
    isStopRequested: () => stopRequested,
  });
  const {
    hasPendingRequest,
    maybeStartRollout,
    reconcileRolloutState,
    requestRollout,
  } = rolloutController;
  const backgroundJobs = createBackgroundJobs({
    api,
    botUsername: serviceState.botUsername,
    config,
    generationStore,
    getForwardingEndpoint,
    getPollAbortController: () => pollAbortController,
    isStopRequested: () => stopRequested,
    promptHandoffStore,
    promptFragmentAssembler,
    reconcileRolloutState,
    runtimeObserver,
    serviceState,
    sessionLifecycleManager,
    sessionService,
    sessionStore,
    timersEnabled: !RUN_ONCE,
    workerPool,
  });
  const {
    scanPendingOmniPrompts,
    scanPendingSpikeQueue,
  } = backgroundJobs;

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
        if (hasPendingRequest()) {
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
            await performRunOnceMaintenance({
              promptFragmentAssembler,
              queuePromptAssembler,
              runtimeObserver,
              scanPendingOmniPrompts,
              scanPendingSpikeQueue,
              sessionLifecycleManager,
            });
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
          await performRunOnceMaintenance({
            promptFragmentAssembler,
            queuePromptAssembler,
            runtimeObserver,
            scanPendingOmniPrompts,
            scanPendingSpikeQueue,
            sessionLifecycleManager,
          });
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
    backgroundJobs.stop();
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
