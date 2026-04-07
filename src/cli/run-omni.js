import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { createServiceState, markBootstrapDrop, markPollError, markUpdateSeen } from "../runtime/service-state.js";
import { RuntimeObserver } from "../runtime/runtime-observer.js";
import { SessionLifecycleManager } from "../session-manager/session-lifecycle-manager.js";
import { SessionCompactor } from "../session-manager/session-compactor.js";
import { SessionService } from "../session-manager/session-service.js";
import { SessionStore } from "../session-manager/session-store.js";
import { SpikeFinalEventStore } from "../session-manager/spike-final-event-store.js";
import { GlobalCodexSettingsStore } from "../session-manager/global-codex-settings-store.js";
import { UpdateOffsetStore } from "../session-manager/update-offset-store.js";
import { ensureStateLayout } from "../state/layout.js";
import { TelegramBotApiClient } from "../telegram/bot-api-client.js";
import {
  extractBotCommand,
  isForeignBotCommand,
} from "../telegram/command-parsing.js";
import { extractPromptText } from "../telegram/incoming-attachments.js";
import { PromptFragmentAssembler } from "../telegram/prompt-fragment-assembler.js";
import { syncTelegramCommandCatalog } from "../telegram/command-catalog.js";
import { runTelegramProbe } from "../telegram/probe.js";
import { OmniCoordinator } from "../omni/coordinator.js";
import { disableOmniStateAcrossSessions } from "../omni/disabled-state.js";
import { OmniPromptHandoffStore } from "../omni/prompt-handoff.js";
import {
  isAutoModeTerminalPhase,
  normalizeAutoModeState,
} from "../session-manager/auto-mode.js";

const MESSAGE_UPDATES_ONLY = ["message"];
const RUN_ONCE = process.env.RUN_ONCE === "1";
const SKIP_PENDING_SCANS = process.env.OMNI_SKIP_PENDING_SCAN === "1";
const OMNI_POLL_TIMEOUT_SECS = 15;
const OMNI_SCAN_INTERVAL_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
  return directoryPath;
}

async function ensureOmniLayout(stateRoot) {
  const omniRoot = path.join(stateRoot, "omni");
  return {
    root: await ensureDir(omniRoot),
    logs: await ensureDir(path.join(omniRoot, "logs")),
    indexes: await ensureDir(path.join(omniRoot, "indexes")),
    runs: await ensureDir(path.join(omniRoot, "runs")),
  };
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
    console.warn(`Omni offset heartbeat update failed: ${error.message}`);
  }
}

async function resolveSpikeBotId(config) {
  if (config.spikeBotId) {
    return config.spikeBotId;
  }

  const spikeApi = new TelegramBotApiClient({
    token: config.telegramBotToken,
    baseUrl: config.telegramApiBaseUrl,
  });
  const me = await spikeApi.call("getMe");
  return String(me.id);
}

async function processUpdates({
  api,
  lifecycleManager,
  offsetStore,
  omniCoordinator,
  promptFragmentAssembler,
  runtimeObserver,
  sessionService,
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
        const command = extractBotCommand(
          update.message,
          serviceState.botUsername,
        );
        const foreignBotCommand = !command
          && isForeignBotCommand(update.message, serviceState.botUsername);
        if (
          (command || foreignBotCommand)
          && promptFragmentAssembler?.hasPendingForSameTopicMessage(update.message)
        ) {
          promptFragmentAssembler.cancelPendingForMessage(update.message);
        }

        const lifecycleResult = await lifecycleManager.handleServiceMessage(
          update.message,
        );
        if (!lifecycleResult.handled) {
          const shouldBufferHumanMessage =
            !command
            && !foreignBotCommand
            && !update.message.from?.is_bot
            && update.message.message_thread_id
            && typeof sessionService.ensureSessionForMessage === "function"
            && promptFragmentAssembler?.shouldBufferMessage(
              update.message,
              extractPromptText(update.message, { trim: true }),
            );
          if (shouldBufferHumanMessage) {
            const session = await sessionService.ensureSessionForMessage(update.message);
            const autoMode = normalizeAutoModeState(session?.auto_mode);
            if (autoMode.enabled && !isAutoModeTerminalPhase(autoMode.phase)) {
              promptFragmentAssembler.enqueue({
                message: update.message,
                flush: async (bufferedMessages) => {
                  await omniCoordinator.handleBufferedHumanMessages(bufferedMessages);
                },
              });
              await offsetStore.save(nextOffset);
              await noteOffsetSafe(runtimeObserver, nextOffset);
              continue;
            }
          }

          await omniCoordinator.handleHumanMessage(update.message);
        }
      } else {
        serviceState.ignoredUpdates += 1;
      }
    } catch (error) {
      console.error(`Omni update ${updateId} failed: ${error.message}`);
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
  if (config.omniEnabled === false) {
    const layout = await ensureStateLayout(config.stateRoot);
    const disabledSessionStore = new SessionStore(layout.sessions);
    const disabledPromptHandoffStore = new OmniPromptHandoffStore(
      disabledSessionStore,
    );
    const disabledSummary = await disableOmniStateAcrossSessions({
      sessionStore: disabledSessionStore,
      promptHandoffStore: disabledPromptHandoffStore,
    });
    if (disabledSummary.autoSessionsDisarmed > 0 || disabledSummary.handoffsCleared > 0) {
      console.log(
        `Omni disabled: disarmed ${disabledSummary.autoSessionsDisarmed} session(s) and cleared ${disabledSummary.handoffsCleared} queued handoff(s).`,
      );
    }
    if (config.omniBotToken) {
      try {
        const disabledApi = new TelegramBotApiClient({
          token: config.omniBotToken,
          baseUrl: config.telegramApiBaseUrl,
        });
        await syncTelegramCommandCatalog(
          disabledApi,
          "omni",
          config.telegramForumChatId,
          { omniEnabled: false },
        );
      } catch (error) {
        console.warn(
          `Telegram command clear failed for disabled Omni: ${error.message}`,
        );
      }
    }
    console.log("Omni runtime is disabled. Idling without polling Telegram.");
    if (RUN_ONCE) {
      return;
    }

    await new Promise((resolve) => {
      const stop = () => resolve();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    return;
  }

  const layout = await ensureStateLayout(config.stateRoot);
  const omniLayout = await ensureOmniLayout(config.stateRoot);
  const api = new TelegramBotApiClient({
    token: config.omniBotToken,
    baseUrl: config.telegramApiBaseUrl,
  });
  const probe = await runTelegramProbe(config, api);
  const serviceState = createServiceState(config, probe);
  const runtimeObserver = new RuntimeObserver({
    logsDir: omniLayout.logs,
    config,
    serviceState,
    probe,
    mode: RUN_ONCE ? "omni-smoke" : "omni-poller",
  });
  const offsetStore = new UpdateOffsetStore(omniLayout.indexes, {
    fileName: "omni-telegram-update-offset.json",
  });
  const sessionStore = new SessionStore(layout.sessions);
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(layout.settings);
  const sessionCompactor = new SessionCompactor({
    sessionStore,
    config,
    globalCodexSettingsStore,
  });
  const sessionLifecycleManager = new SessionLifecycleManager({
    config,
    sessionStore,
    runtimeObserver,
  });
  const sessionService = new SessionService({
    sessionStore,
    config,
    sessionCompactor,
    runtimeObserver,
    globalCodexSettingsStore,
  });
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const promptHandoffStore = new OmniPromptHandoffStore(sessionStore);
  const promptFragmentAssembler = new PromptFragmentAssembler();
  const spikeBotId = await resolveSpikeBotId(config);
  const omniCoordinator = new OmniCoordinator({
    api,
    config,
    promptHandoffStore,
    serviceState,
    sessionService,
    sessionStore,
    sessionLifecycleManager,
    spikeFinalEventStore,
    omniBotId: config.omniBotId || String(probe.me.id),
    spikeBotId,
  });

  await ensureLongPollingReady(api, probe.webhookInfo);
  try {
    await syncTelegramCommandCatalog(api, "omni", config.telegramForumChatId, {
      omniEnabled: config.omniEnabled,
    });
  } catch (error) {
    console.warn(`Telegram command sync failed for Omni: ${error.message}`);
  }
  let currentOffset = await bootstrapOffset({ api, offsetStore, serviceState });
  await runtimeObserver.start({ currentOffset });
  if (serviceState.bootstrapDroppedUpdateId !== null) {
    await runtimeObserver.noteBootstrapDrop(serviceState.bootstrapDroppedUpdateId);
  }
  const heartbeatTimer = setInterval(() => {
    void runtimeObserver.writeHeartbeat().catch(() => {});
  }, 15000);
  heartbeatTimer.unref();

  console.log(
    `Omni poller starting for @${serviceState.botUsername || "no-username"} in chat ${config.telegramForumChatId}`,
  );

  const abortController = new AbortController();
  let shutdownPromise = null;
  const stop = () => {
    abortController.abort();
    shutdownPromise ??= omniCoordinator.shutdown();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    let lastScanAt = 0;

    while (!abortController.signal.aborted) {
      try {
        const updates = await api.getUpdates(
          {
            offset: currentOffset ?? undefined,
            limit: 100,
            timeout: RUN_ONCE ? 1 : OMNI_POLL_TIMEOUT_SECS,
            allowed_updates: MESSAGE_UPDATES_ONLY,
          },
          { signal: abortController.signal },
        );

        if (updates.length > 0) {
          currentOffset = await processUpdates({
            api,
            lifecycleManager: sessionLifecycleManager,
            offsetStore,
            omniCoordinator,
            promptFragmentAssembler,
            runtimeObserver,
            sessionService,
            serviceState,
            updates,
          });
        }

        const now = Date.now();
        if (
          !SKIP_PENDING_SCANS &&
          (updates.length === 0 || now - lastScanAt >= OMNI_SCAN_INTERVAL_MS)
        ) {
          await omniCoordinator.scanPendingSpikeFinals();
          await omniCoordinator.resumeDueSleepingSessions();
          lastScanAt = now;
        }

        if (RUN_ONCE && updates.length === 0) {
          break;
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          break;
        }

        markPollError(serviceState);
        await runtimeObserver.notePollError(error);
        console.error(`Omni poll failed: ${error.message}`);
        await sleep(3000);
      }
    }
  } catch (error) {
    await runtimeObserver.stop({
      status: "failed",
      error,
    });
    throw error;
  }

  await shutdownPromise;
  await runtimeObserver.stop();
}

main().catch((error) => {
  console.error(`Omni runtime failed: ${error.message}`);
  process.exitCode = 1;
});
