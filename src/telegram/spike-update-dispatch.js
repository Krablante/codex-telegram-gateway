import {
  handleIncomingCallbackQuery,
  handleIncomingMessage,
} from "./command-router.js";
import { buildReplyMessageParams } from "./command-parsing.js";
import { IncomingAttachmentTooLargeError } from "./incoming-attachments.js";
import { safeSendMessage } from "./topic-delivery.js";

export async function handleSpikeUpdate({
  api,
  botUsername,
  config,
  emergencyRouter,
  generalMessageLedgerStore,
  globalControlPanelStore,
  lifecycleManager,
  promptFragmentAssembler,
  promptHandoffStore = null,
  queuePromptAssembler,
  runtimeObserver = null,
  sessionService,
  serviceState,
  topicControlPanelStore,
  update,
  workerPool,
  zooService,
}) {
  const updateId = update?.update_id ?? null;

  try {
    if (update.callback_query) {
      await handleIncomingCallbackQuery({
        api,
        botUsername,
        callbackQuery: update.callback_query,
        config,
        lifecycleManager,
        promptStartGuard: emergencyRouter,
        promptFragmentAssembler,
        promptHandoffStore,
        queuePromptAssembler,
        serviceState,
        sessionService,
        globalControlPanelStore,
        generalMessageLedgerStore,
        topicControlPanelStore,
        zooService,
        workerPool,
      });
      return;
    }

    if (!update.message) {
      serviceState.ignoredUpdates += 1;
      return;
    }

    const emergencyResult = await emergencyRouter?.handleMessage(update.message);
    if (emergencyResult?.handled) {
      return;
    }

    const emergencyTopicLockResult =
      await emergencyRouter?.handleCompetingTopicMessage(update.message);
    if (emergencyTopicLockResult?.handled) {
      return;
    }

    const lifecycleResult = await lifecycleManager.handleServiceMessage(update.message);
    if (lifecycleResult.handled) {
      return;
    }

    await handleIncomingMessage({
      api,
      botUsername,
      config,
      lifecycleManager,
      message: update.message,
      promptStartGuard: emergencyRouter,
      promptFragmentAssembler,
      promptHandoffStore,
      queuePromptAssembler,
      serviceState,
      sessionService,
      globalControlPanelStore,
      generalMessageLedgerStore,
      topicControlPanelStore,
      zooService,
      workerPool,
    });
  } catch (error) {
    if (error instanceof IncomingAttachmentTooLargeError && update.message) {
      try {
        await safeSendMessage(
          api,
          buildReplyMessageParams(update.message, error.replyText),
          error.session,
          lifecycleManager,
        );
      } catch (deliveryError) {
        if (updateId !== null) {
          await runtimeObserver?.noteUpdateFailure(updateId, deliveryError);
        }
      }
      return;
    }

    if (updateId !== null) {
      await runtimeObserver?.noteUpdateFailure(updateId, error);
    }
    throw error;
  }
}
