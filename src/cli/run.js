import process from "node:process";

import { loadRuntimeConfig } from "../config/runtime-config.js";
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
import { SessionService } from "../session-manager/session-service.js";
import { SessionStore } from "../session-manager/session-store.js";
import { TopicControlPanelStore } from "../session-manager/topic-control-panel-store.js";
import { UpdateOffsetStore } from "../session-manager/update-offset-store.js";
import { ensureStateLayout } from "../state/layout.js";
import { TelegramBotApiClient } from "../telegram/bot-api-client.js";
import { syncTelegramCommandCatalog } from "../telegram/command-catalog.js";
import {
  handleIncomingCallbackQuery,
  handleIncomingMessage,
} from "../telegram/command-router.js";
import { createTrackedGeneralApi } from "../telegram/general-message-cleanup.js";
import { PromptFragmentAssembler } from "../telegram/prompt-fragment-assembler.js";
import { runTelegramProbe } from "../telegram/probe.js";
import { EmergencyPrivateChatRouter } from "../emergency/private-chat-router.js";
import { OmniPromptHandoffStore, drainPendingOmniPrompts } from "../omni/prompt-handoff.js";
import { disableOmniStateAcrossSessions } from "../omni/disabled-state.js";
import { ZooService } from "../zoo/service.js";

const TELEGRAM_ALLOWED_UPDATES = ["message", "callback_query"];
const RUN_ONCE = process.env.RUN_ONCE === "1";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  sessionService,
  globalControlPanelStore,
  generalMessageLedgerStore,
  topicControlPanelStore,
  zooService,
  workerPool,
  serviceState,
  updates,
}) {
  let nextOffset = null;

  for (const update of updates) {
    const updateId = update.update_id;
    markUpdateSeen(serviceState, updateId);
    nextOffset = updateId + 1;

    try {
      if (update.callback_query) {
        await handleIncomingCallbackQuery({
          api,
          botUsername,
          config,
          callbackQuery: update.callback_query,
          lifecycleManager,
          promptStartGuard: emergencyRouter,
          promptFragmentAssembler,
          queuePromptAssembler,
          serviceState,
          sessionService,
          globalControlPanelStore,
          generalMessageLedgerStore,
          topicControlPanelStore,
          zooService,
          workerPool,
        });
      } else if (update.message) {
        const emergencyResult = await emergencyRouter?.handleMessage(update.message);
        if (emergencyResult?.handled) {
          await offsetStore.save(nextOffset);
          await noteOffsetSafe(runtimeObserver, nextOffset);
          continue;
        }

        const emergencyTopicLockResult =
          await emergencyRouter?.handleCompetingTopicMessage(update.message);
        if (emergencyTopicLockResult?.handled) {
          await offsetStore.save(nextOffset);
          await noteOffsetSafe(runtimeObserver, nextOffset);
          continue;
        }

        const lifecycleResult = await lifecycleManager.handleServiceMessage(
          update.message,
        );
        if (lifecycleResult.handled) {
          await offsetStore.save(nextOffset);
          await noteOffsetSafe(runtimeObserver, nextOffset);
          continue;
        }

        await handleIncomingMessage({
          api,
          botUsername,
          config,
          lifecycleManager,
          message: update.message,
          promptStartGuard: emergencyRouter,
          promptFragmentAssembler,
          queuePromptAssembler,
          serviceState,
          sessionService,
          globalControlPanelStore,
          generalMessageLedgerStore,
          topicControlPanelStore,
          zooService,
          workerPool,
        });
      } else {
        serviceState.ignoredUpdates += 1;
      }
    } catch (error) {
      console.error(`update ${updateId} failed: ${error.message}`);
      await runtimeObserver?.noteUpdateFailure(updateId, error);
      throw error;
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
  const trackedApi = createTrackedGeneralApi(
    api,
    config,
    generalMessageLedgerStore,
  );
  const sessionStore = new SessionStore(layout.sessions);
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
  });
  const zooService = new ZooService({
    config,
    sessionService,
    globalControlPanelStore,
  });
  let workerPool = null;
  const handleRunTerminated = async ({ session }) => {
    if (!session) {
      return;
    }

    await sessionService.drainPromptQueue(workerPool, { session });
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

  await ensureLongPollingReady(api, probe.webhookInfo);
  try {
    await syncTelegramCommandCatalog(api, "spike", config.telegramForumChatId, {
      omniEnabled: config.omniEnabled,
    });
  } catch (error) {
    console.warn(`Telegram command sync failed for Spike: ${error.message}`);
  }
  let currentOffset = await bootstrapOffset({ api, offsetStore, serviceState });
  await runtimeObserver.start({ currentOffset });
  if (serviceState.bootstrapDroppedUpdateId !== null) {
    await runtimeObserver.noteBootstrapDrop(serviceState.bootstrapDroppedUpdateId);
  }
  let lastRetentionSweepAt = 0;
  const abortController = new AbortController();
  let shutdownPromise = null;
  const heartbeatTimer = setInterval(() => {
    void runtimeObserver.writeHeartbeat().catch(() => {});
  }, 15000);
  heartbeatTimer.unref();
  let promptHandoffScanInFlight = false;
  let promptQueueScanInFlight = false;
  const scanPendingOmniPrompts = async () => {
    if (config.omniEnabled === false) {
      return;
    }
    if (promptHandoffScanInFlight || abortController.signal.aborted) {
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
    if (promptQueueScanInFlight || abortController.signal.aborted) {
      return;
    }

    promptQueueScanInFlight = true;
    await sessionService.drainPromptQueue(workerPool)
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

  console.log(
    `poller starting for @${serviceState.botUsername || "no-username"} in chat ${config.telegramForumChatId}`,
  );

  const stop = () => {
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
    abortController.abort();
    shutdownPromise ??= Promise.allSettled([
      workerPool.shutdown(),
      emergencyRouter.shutdown(),
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

  try {
    while (!abortController.signal.aborted) {
      try {
        const updates = await api.getUpdates(
          {
            offset: currentOffset ?? undefined,
            limit: 100,
            timeout: config.telegramPollTimeoutSecs,
            allowed_updates: TELEGRAM_ALLOWED_UPDATES,
          },
          { signal: abortController.signal },
        );

        if (updates.length === 0) {
          await scanPendingOmniPrompts();
          await scanPendingSpikeQueue();
          const now = Date.now();
          if (
            now - lastRetentionSweepAt >=
            config.retentionSweepIntervalSecs * 1000
          ) {
            await sessionLifecycleManager.sweepExpiredParkedSessions();
            lastRetentionSweepAt = now;
            await runtimeObserver.noteRetentionSweep(
              new Date(lastRetentionSweepAt).toISOString(),
            );
          }

          if (RUN_ONCE) {
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
          sessionService,
          globalControlPanelStore,
          generalMessageLedgerStore,
          topicControlPanelStore,
          zooService,
          workerPool,
          serviceState,
          updates,
        });
        await scanPendingOmniPrompts();
        const now = Date.now();
        if (
          now - lastRetentionSweepAt >=
          config.retentionSweepIntervalSecs * 1000
        ) {
          await sessionLifecycleManager.sweepExpiredParkedSessions();
          lastRetentionSweepAt = now;
          await runtimeObserver.noteRetentionSweep(
            new Date(lastRetentionSweepAt).toISOString(),
          );
        }

        if (RUN_ONCE) {
          await promptFragmentAssembler.flushAll();
          await queuePromptAssembler.flushAll();
          break;
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          break;
        }

        markPollError(serviceState);
        console.error(`poll cycle failed: ${error.message}`);
        await runtimeObserver.notePollError(error);
        await sleep(2000);
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(promptHandoffTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
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
