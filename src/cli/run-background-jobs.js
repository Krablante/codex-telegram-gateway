import { drainPendingOmniPrompts } from "../omni/prompt-handoff.js";

const HEARTBEAT_WRITE_MS = 15000;
const GENERATION_HEARTBEAT_MS = 3000;
const PROMPT_SCAN_MS = 1000;

export function createBackgroundJobs({
  api,
  botUsername,
  clearIntervalImpl = clearInterval,
  config,
  drainPendingOmniPromptsImpl = drainPendingOmniPrompts,
  generationStore,
  getForwardingEndpoint,
  getPollAbortController,
  isStopRequested,
  promptHandoffStore,
  promptFragmentAssembler,
  reconcileRolloutState,
  runtimeObserver,
  setIntervalImpl = setInterval,
  serviceState,
  sessionLifecycleManager,
  sessionService,
  sessionStore,
  timersEnabled = true,
  workerPool,
}) {
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
    await drainPendingOmniPromptsImpl({
      api,
      botUsername,
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

  if (!timersEnabled) {
    return {
      scanPendingOmniPrompts,
      scanPendingSpikeQueue,
      stop() {},
    };
  }

  const heartbeatTimer = setIntervalImpl(() => {
    void runtimeObserver.writeHeartbeat().catch(() => {});
  }, HEARTBEAT_WRITE_MS);
  heartbeatTimer.unref?.();

  const generationHeartbeatTimer = setIntervalImpl(() => {
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
          if (!renewed && !serviceState.retiring && !isStopRequested()) {
            serviceState.isLeader = false;
            getPollAbortController()?.abort();
          }
        })
        .catch(() => {});
    }
  }, GENERATION_HEARTBEAT_MS);
  generationHeartbeatTimer.unref?.();

  const promptHandoffTimer = setIntervalImpl(() => {
    void scanPendingOmniPrompts().then(() => scanPendingSpikeQueue());
  }, PROMPT_SCAN_MS);
  promptHandoffTimer.unref?.();

  const retentionSweepTimer = setIntervalImpl(() => {
    if (retentionSweepInFlight || !serviceState.isLeader || serviceState.retiring) {
      return;
    }

    retentionSweepInFlight = true;
    void sessionLifecycleManager.sweepExpiredParkedSessions()
      .then(async () => {
        await runtimeObserver.noteRetentionSweep(
          new Date().toISOString(),
        );
      })
      .catch((error) => {
        console.error(`retention sweep failed: ${error.message}`);
      })
      .finally(() => {
        retentionSweepInFlight = false;
      });
  }, config.retentionSweepIntervalSecs * 1000);
  retentionSweepTimer.unref?.();

  return {
    scanPendingOmniPrompts,
    scanPendingSpikeQueue,
    stop() {
      clearIntervalImpl(heartbeatTimer);
      clearIntervalImpl(generationHeartbeatTimer);
      clearIntervalImpl(promptHandoffTimer);
      clearIntervalImpl(retentionSweepTimer);
    },
  };
}
