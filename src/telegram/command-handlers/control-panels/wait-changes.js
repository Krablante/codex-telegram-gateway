import { buildBufferedPromptFlush, buildApplyTopicWaitChange } from "../prompt-flow.js";
import { buildSyntheticCommandMessage } from "./common.js";

export { buildApplyTopicWaitChange };

export function buildApplyGlobalWaitChange({
  api,
  botUsername,
  config,
  lifecycleManager = null,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  return async ({
    actor,
    chat,
    value,
  }) => {
    if (!promptFragmentAssembler) {
      return { available: false };
    }

    const syntheticMessage = buildSyntheticCommandMessage(
      actor,
      chat,
      value === "off" ? "/wait global off" : `/wait global ${value}`,
    );

    if (value === "off") {
      promptFragmentAssembler.cancelPendingForMessage(syntheticMessage, {
        scope: "global",
      });
      return { available: true };
    }

    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      return { available: false };
    }

    promptFragmentAssembler.openWindow({
      message: syntheticMessage,
      flushDelayMs: seconds * 1000,
      scope: "global",
      flush: buildBufferedPromptFlush({
        api,
        botUsername,
        config,
        lifecycleManager,
        promptStartGuard,
        serviceState,
        sessionService,
        workerPool,
      }),
    });
    return { available: true };
  };
}
