import process from "node:process";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { CodexWorkerPool } from "../pty-worker/worker-pool.js";
import { createServiceState, markBootstrapDrop, markPollError, markUpdateSeen } from "../runtime/service-state.js";
import { RuntimeObserver } from "../runtime/runtime-observer.js";
import { SessionCompactor } from "../session-manager/session-compactor.js";
import { GlobalPromptSuffixStore } from "../session-manager/global-prompt-suffix-store.js";
import { SessionLifecycleManager } from "../session-manager/session-lifecycle-manager.js";
import { SessionService } from "../session-manager/session-service.js";
import { SessionStore } from "../session-manager/session-store.js";
import { UpdateOffsetStore } from "../session-manager/update-offset-store.js";
import { ensureStateLayout } from "../state/layout.js";
import { TelegramBotApiClient } from "../telegram/bot-api-client.js";
import { handleIncomingMessage } from "../telegram/command-router.js";
import { PromptFragmentAssembler } from "../telegram/prompt-fragment-assembler.js";
import { runTelegramProbe } from "../telegram/probe.js";
import { EmergencyPrivateChatRouter } from "../emergency/private-chat-router.js";

const MESSAGE_UPDATES_ONLY = ["message"];
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
  runtimeObserver,
  offsetStore,
  sessionService,
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
      if (update.message) {
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
          serviceState,
          sessionService,
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
  const sessionStore = new SessionStore(layout.sessions);
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
  });
  const workerPool = new CodexWorkerPool({
    api,
    config,
    sessionStore,
    serviceState,
    sessionCompactor,
    sessionLifecycleManager,
  });
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const emergencyRouter = new EmergencyPrivateChatRouter({
    api,
    botUsername: serviceState.botUsername,
    config,
    normalRunState: {
      hasActiveRuns: () => workerPool.hasActiveOrStartingRuns(),
      getRunCount: () => workerPool.getActiveOrStartingRunCount(),
    },
  });
  sessionLifecycleManager.workerPool = workerPool;

  await ensureLongPollingReady(api, probe.webhookInfo);
  let currentOffset = await bootstrapOffset({ api, offsetStore, serviceState });
  await runtimeObserver.start({ currentOffset });
  if (serviceState.bootstrapDroppedUpdateId !== null) {
    await runtimeObserver.noteBootstrapDrop(serviceState.bootstrapDroppedUpdateId);
  }
  let lastRetentionSweepAt = 0;
  const heartbeatTimer = setInterval(() => {
    void runtimeObserver.writeHeartbeat().catch(() => {});
  }, 15000);
  heartbeatTimer.unref();

  console.log(
    `poller starting for @${serviceState.botUsername || "no-username"} in chat ${config.telegramForumChatId}`,
  );

  const abortController = new AbortController();
  let shutdownPromise = null;
  const stop = () => {
    const canceled = promptFragmentAssembler.cancelAll();
    if (canceled.canceledEntries > 0) {
      console.warn(
        `discarded ${canceled.canceledMessages} buffered Telegram fragment(s) across ${canceled.canceledEntries} prompt(s) during shutdown`,
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
            allowed_updates: MESSAGE_UPDATES_ONLY,
          },
          { signal: abortController.signal },
        );

        if (updates.length === 0) {
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
            break;
          }

          continue;
        }

        currentOffset = await processUpdates({
          api,
          botUsername: serviceState.botUsername,
          config,
          emergencyRouter,
          lifecycleManager: sessionLifecycleManager,
          promptFragmentAssembler,
          runtimeObserver,
          offsetStore,
          sessionService,
          workerPool,
          serviceState,
          updates,
        });
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
