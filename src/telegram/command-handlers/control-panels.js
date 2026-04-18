import {
  GLOBAL_CONTROL_PANEL_COMMAND,
  handleGlobalControlCallbackQuery,
  handleGlobalControlCommand,
  maybeHandleGlobalControlReply,
} from "../global-control-panel.js";
import {
  TOPIC_CONTROL_PANEL_COMMAND,
  handleTopicControlCallbackQuery,
  handleTopicControlCommand,
  maybeHandleTopicControlReply,
} from "../topic-control-panel.js";
import {
  buildApplyTopicWaitChange,
  buildBufferedPromptFlush,
} from "./prompt-flow.js";
import {
  handleClearCommand,
  resolveGeneralUiLanguage,
} from "./control-surface.js";

export function buildSyntheticCommandMessage(actor, chat, commandText) {
  const rawCommand = String(commandText ?? "").trim().split(/\s+/u)[0] ?? "";
  return {
    text: commandText,
    entities: rawCommand.startsWith("/")
      ? [{ type: "bot_command", offset: 0, length: rawCommand.length }]
      : undefined,
    from: actor,
    chat,
    message_thread_id: Number.isInteger(chat?.message_thread_id)
      ? chat.message_thread_id
      : undefined,
    is_internal_global_control_dispatch: true,
  };
}

export function createGlobalControlDispatcher({
  handleIncomingMessage,
  api,
  botUsername,
  config,
  lifecycleManager = null,
  globalControlPanelStore = null,
  generalMessageLedgerStore = null,
  topicControlPanelStore = null,
  zooService = null,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  promptHandoffStore = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  return async ({
    actor,
    chat,
    commandText,
  }) =>
    handleIncomingMessage({
      api,
      botUsername,
      config,
      lifecycleManager,
      globalControlPanelStore,
      generalMessageLedgerStore,
      topicControlPanelStore,
      zooService,
      message: buildSyntheticCommandMessage(actor, chat, commandText),
      promptStartGuard,
      promptFragmentAssembler,
      promptHandoffStore,
      queuePromptAssembler,
      serviceState,
      sessionService,
      workerPool,
    });
}

export async function maybeHandleControlPanelReplies({
  api,
  config,
  globalControlPanelStore = null,
  message,
  promptFragmentAssembler = null,
  sessionService,
  topicControlPanelStore = null,
  workerPool,
  dispatchGlobalControlCommand,
  applyTopicWaitChange,
}) {
  if (
    !message.is_internal_global_control_dispatch
    && globalControlPanelStore
  ) {
    const globalControlReplyResult = await maybeHandleGlobalControlReply({
      api,
      config,
      dispatchCommand: dispatchGlobalControlCommand,
      globalControlPanelStore,
      message,
      promptFragmentAssembler,
      sessionService,
    });
    if (globalControlReplyResult?.handled) {
      return globalControlReplyResult;
    }
  }

  if (topicControlPanelStore) {
    const topicControlReplyResult = await maybeHandleTopicControlReply({
      api,
      config,
      message,
      promptFragmentAssembler,
      sessionService,
      topicControlPanelStore,
      applyTopicWaitChange,
      workerPool,
    });
    if (topicControlReplyResult?.handled) {
      return topicControlReplyResult;
    }
  }

  return null;
}

export async function maybeHandleControlPanelCommand({
  api,
  config,
  lifecycleManager = null,
  globalControlPanelStore = null,
  generalMessageLedgerStore = null,
  message,
  promptFragmentAssembler = null,
  sessionService,
  topicControlPanelStore = null,
  workerPool,
  command,
  fallbackLanguage,
  dispatchGlobalControlCommand,
}) {
  if (command.name === GLOBAL_CONTROL_PANEL_COMMAND) {
    const result = await handleGlobalControlCommand({
      api,
      config,
      dispatchCommand: dispatchGlobalControlCommand,
      globalControlPanelStore,
      message,
      promptFragmentAssembler,
      sessionService,
    });
    return { reason: result.reason };
  }

  if (command.name === TOPIC_CONTROL_PANEL_COMMAND) {
    const result = await handleTopicControlCommand({
      api,
      config,
      fallbackLanguage,
      message,
      promptFragmentAssembler,
      sessionService,
      topicControlPanelStore,
      workerPool,
    });
    return { reason: result.reason };
  }

  if (command.name === "clear") {
    const language = await resolveGeneralUiLanguage(globalControlPanelStore);
    const result = await handleClearCommand({
      api,
      config,
      lifecycleManager,
      message,
      globalControlPanelStore,
      generalMessageLedgerStore,
      promptFragmentAssembler,
      sessionService,
      language,
      refreshGeneralMenu: ({ activeScreen }) =>
        handleGlobalControlCommand({
          activeScreen,
          api,
          config,
          dispatchCommand: dispatchGlobalControlCommand,
          globalControlPanelStore,
          message,
          promptFragmentAssembler,
          sessionService,
        }),
    });
    return { reason: result.reason };
  }

  return null;
}

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

export async function handleControlPanelCallbackQuery({
  handleIncomingMessage,
  api,
  botUsername,
  callbackQuery,
  config,
  lifecycleManager = null,
  globalControlPanelStore = null,
  generalMessageLedgerStore = null,
  topicControlPanelStore = null,
  zooService = null,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  promptHandoffStore = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  const dispatchGlobalControlCommand = createGlobalControlDispatcher({
    handleIncomingMessage,
    api,
    botUsername,
    config,
    lifecycleManager,
    globalControlPanelStore,
    generalMessageLedgerStore,
    topicControlPanelStore,
    zooService,
    promptStartGuard,
    promptFragmentAssembler,
    promptHandoffStore,
    queuePromptAssembler,
    serviceState,
    sessionService,
    workerPool,
  });
  const applyGlobalWaitChange = buildApplyGlobalWaitChange({
    api,
    botUsername,
    config,
    lifecycleManager,
    promptStartGuard,
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool,
  });
  const applyTopicWaitChange = buildApplyTopicWaitChange({
    api,
    botUsername,
    config,
    lifecycleManager,
    promptStartGuard,
    promptFragmentAssembler,
    serviceState,
    sessionService,
    workerPool,
  });

  const topicResult = await handleTopicControlCallbackQuery({
    applyTopicWaitChange,
    api,
    callbackQuery,
    config,
    dispatchCommand: dispatchGlobalControlCommand,
    promptFragmentAssembler,
    sessionService,
    topicControlPanelStore,
    workerPool,
  });

  if (topicResult.handled) {
    return topicResult;
  }

  return handleGlobalControlCallbackQuery({
    applyGlobalWaitChange,
    api,
    callbackQuery,
    config,
    dispatchCommand: dispatchGlobalControlCommand,
    globalControlPanelStore,
    promptFragmentAssembler,
    sessionService,
  });
}
