import {
  collectOwnedSessionKeys,
  markOwnedSessionsRetiring,
  spawnReplacementGeneration,
  waitForGenerationReady,
} from "../runtime/service-rollout.js";

const ROLLOUT_READY_TIMEOUT_MS = 15000;

export function createRolloutController({
  config,
  collectOwnedSessionKeysImpl = collectOwnedSessionKeys,
  createGenerationId,
  generationStore,
  markOwnedSessionsRetiringImpl = markOwnedSessionsRetiring,
  rolloutCoordinationStore,
  serviceState,
  sessionStore,
  spawnReplacementGenerationImpl = spawnReplacementGeneration,
  waitForGenerationReadyImpl = waitForGenerationReady,
  workerPool,
  scriptPath,
  getPollAbortController,
  isStopRequested,
}) {
  let rolloutRequested = false;
  let rolloutPromise = null;

  const retire = () => {
    if (serviceState.retiring || isStopRequested()) {
      return;
    }

    serviceState.retiring = true;
    serviceState.isLeader = false;
    getPollAbortController()?.abort();
    void generationStore.releaseLeadership().catch((error) => {
      console.warn(`failed to release leader lease during retire: ${error.message}`);
    });
  };

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

  const maybeStartRollout = async () => {
    if (
      rolloutPromise
      || isStopRequested()
      || serviceState.retiring
      || !serviceState.isLeader
    ) {
      return;
    }

    rolloutPromise = (async () => {
      const targetGenerationId = createGenerationId();
      const retainedSessionKeys = collectOwnedSessionKeysImpl(workerPool);
      let replacement = null;

      try {
        await rolloutCoordinationStore.requestRollout({
          currentGenerationId: serviceState.generationId,
          targetGenerationId,
          requestedBy: "signal:SIGUSR2",
        });
        serviceState.rolloutStatus = "requested";

        replacement = spawnReplacementGenerationImpl({
          config,
          generationId: targetGenerationId,
          parentGenerationId: serviceState.generationId,
          scriptPath,
        });
        replacement.unref();

        const readyGeneration = await waitForGenerationReadyImpl({
          generationStore,
          generationId: targetGenerationId,
          timeoutMs: ROLLOUT_READY_TIMEOUT_MS,
        });
        if (!readyGeneration) {
          throw new Error(
            `replacement generation ${targetGenerationId} did not become ready`,
          );
        }

        await markOwnedSessionsRetiringImpl({
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
    if (rolloutRequested || isStopRequested()) {
      return;
    }

    rolloutRequested = true;
    void maybeStartRollout();
  };

  return {
    hasPendingRequest: () => rolloutRequested,
    maybeStartRollout,
    reconcileRolloutState,
    requestRollout,
    retire,
  };
}
