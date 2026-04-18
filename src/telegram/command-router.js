import {
  DEFAULT_UI_LANGUAGE,
  getSessionUiLanguage,
  normalizeUiLanguage,
} from "../i18n/ui-language.js";
import {
  buildReplyMessageParams,
  extractBotCommand,
  getTopicLabel,
  isForeignBotCommand,
  isAuthorizedMessage,
  parseLanguageCommandArgs,
  parseNewTopicCommandArgs,
  parsePromptSuffixCommandArgs,
  parseQueueCommandArgs,
  parseScopedRuntimeSettingCommandArgs,
  parseWaitCommandArgs,
} from "./command-parsing.js";
import {
  GLOBAL_CONTROL_PANEL_COMMAND,
  isGeneralForumMessage,
} from "./global-control-panel.js";
import {
  composePromptWithSuffixes,
  isTopicPromptSuffixEnabled,
} from "../session-manager/prompt-suffix.js";
import { getTopicIdFromMessage } from "../session-manager/session-key.js";
import {
  buildStatusMessage,
} from "./status-view.js";
import {
  safeSendMessage,
} from "./topic-delivery.js";
import {
  buildNoSessionTopicMessage,
  buildApplyTopicWaitChange,
  maybeHandlePromptCommandRouting,
  preparePromptRoutingContext,
} from "./command-handlers/prompt-flow.js";
import {
  buildBindingResolutionErrorMessage,
  buildCompactAlreadyRunningMessage,
  buildCompactFailureMessage,
  buildCompactMessage,
  buildCompactStartedMessage,
  buildDiffCleanMessage,
  buildDiffUnavailableMessage,
  buildDocumentTooLargeMessage,
  buildNewTopicAckMessage,
  buildNewTopicBootstrapMessage,
  buildPurgeAckMessage,
  buildPurgeBusyMessage,
  buildPurgedSessionMessage,
} from "./command-handlers/topic-commands.js";
import { resolveGeneralUiLanguage } from "./command-handlers/control-surface.js";
import {
  createGlobalControlDispatcher,
  handleControlPanelCallbackQuery,
  maybeHandleControlPanelCommand,
  maybeHandleControlPanelReplies,
} from "./command-handlers/control-panels.js";
import { maybeHandleSurfaceCommand } from "./command-handlers/surface-commands.js";
import {
  handleCompactCommand,
  handleDiffCommand,
  handleNewTopicCommand,
  handlePurgeCommand,
  launchCompactionInBackground,
} from "./command-handlers/session-ops.js";

export {
  buildBindingResolutionErrorMessage,
  buildCompactMessage,
  buildCompactStartedMessage,
  buildDiffCleanMessage,
  buildDiffUnavailableMessage,
  buildNoSessionTopicMessage,
  buildPurgeAckMessage,
  buildPurgeBusyMessage,
  buildReplyMessageParams,
  buildPurgedSessionMessage,
  buildStatusMessage,
  extractBotCommand,
  getTopicLabel,
  isForeignBotCommand,
  isAuthorizedMessage,
  parseLanguageCommandArgs,
  parseNewTopicCommandArgs,
  parsePromptSuffixCommandArgs,
  parseQueueCommandArgs,
  parseScopedRuntimeSettingCommandArgs,
  parseWaitCommandArgs,
};

export function applyPromptSuffix(prompt, session, globalPromptSuffix = null) {
  return composePromptWithSuffixes(prompt, session, globalPromptSuffix);
}

function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}

export function buildUnknownCommandMessage(
  language = DEFAULT_UI_LANGUAGE,
  { omniEnabled = true } = {},
) {
  if (isEnglish(language)) {
    return omniEnabled
      ? "Available commands: /help, /guide, /clear, /new, /zoo, /status, /limits, /global, /menu, /auto, /omni, /language, /q, /wait, /suffix, /model, /reasoning, /omni_model, /omni_reasoning, /interrupt, /diff, /compact, and /purge."
      : "Available commands: /help, /guide, /clear, /new, /zoo, /status, /limits, /global, /menu, /language, /q, /wait, /suffix, /model, /reasoning, /interrupt, /diff, /compact, and /purge.";
  }

  return omniEnabled
    ? "Сейчас доступны /help, /guide, /clear, /new, /zoo, /status, /limits, /global, /menu, /auto, /omni, /language, /q, /wait, /suffix, /model, /reasoning, /omni_model, /omni_reasoning, /interrupt, /diff, /compact и /purge."
    : "Сейчас доступны /help, /guide, /clear, /new, /zoo, /status, /limits, /global, /menu, /language, /q, /wait, /suffix, /model, /reasoning, /interrupt, /diff, /compact и /purge.";
}

function markCommandHandled(serviceState, commandName) {
  serviceState.handledCommands += 1;
  serviceState.lastCommandName = commandName;
  serviceState.lastCommandAt = new Date().toISOString();
}

export async function handleIncomingMessage({
  api,
  botUsername,
  config,
  lifecycleManager = null,
  globalControlPanelStore = null,
  generalMessageLedgerStore = null,
  topicControlPanelStore = null,
  zooService = null,
  message,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  promptHandoffStore = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  if (!isAuthorizedMessage(message, config)) {
    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "unauthorized" };
  }

  if (
    generalMessageLedgerStore
    && isGeneralForumMessage(message, config)
    && !message.is_internal_global_control_dispatch
    && Number.isInteger(message.message_id)
    && message.message_id > 0
  ) {
    await generalMessageLedgerStore.trackMessageId(message.message_id);
  }

  if (zooService) {
    const zooResult = await zooService.maybeHandleIncomingMessage({
      api,
      botUsername,
      message,
    });
    if (zooResult?.handled) {
      if (zooResult.command) {
        markCommandHandled(serviceState, zooResult.command);
      }
      if (zooResult.ackText && !zooResult.suppressAck) {
        await safeSendMessage(
          api,
          buildReplyMessageParams(message, zooResult.ackText),
          null,
          lifecycleManager,
        );
      }
      return zooResult;
    }
  }

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

  const controlReplyResult = await maybeHandleControlPanelReplies({
    api,
    config,
    globalControlPanelStore,
    message,
    promptFragmentAssembler,
    sessionService,
    topicControlPanelStore,
    workerPool,
    dispatchGlobalControlCommand,
    applyTopicWaitChange,
  });
  if (controlReplyResult?.handled) {
    return controlReplyResult;
  }

  const promptIngress = await preparePromptRoutingContext({
    botUsername,
    message,
    promptFragmentAssembler,
    queuePromptAssembler,
  });
  if (promptIngress.handledResult) {
    return promptIngress.handledResult;
  }
  const {
    command,
    foreignBotCommand,
    effectiveQueueCommand,
  } = promptIngress;
  const promptRoutingResult = await maybeHandlePromptCommandRouting({
    api,
    botUsername,
    config,
    lifecycleManager,
    globalControlPanelStore,
    message,
    promptStartGuard,
    promptFragmentAssembler,
    queuePromptAssembler,
    serviceState,
    sessionService,
    workerPool,
    command,
    foreignBotCommand,
    effectiveQueueCommand,
    markCommandHandled,
  });
  if (promptRoutingResult) {
    return promptRoutingResult;
  }

  if (command.name === "new") {
    const result = await handleNewTopicCommand({
      api,
      config,
      lifecycleManager,
      globalControlPanelStore,
      message: {
        ...message,
        command_args: command.args,
      },
      promptFragmentAssembler,
      topicControlPanelStore,
      sessionService,
      workerPool,
    });
    if (result.handledSession) {
      await sessionService.recordHandledSession(
        serviceState,
        result.handledSession,
        command.name,
      );
    }
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name, reason: result.reason };
  }

  const generalUiLanguage = await resolveGeneralUiLanguage(globalControlPanelStore);
  const controlPanelCommandResult = await maybeHandleControlPanelCommand({
    api,
    config,
    lifecycleManager,
    globalControlPanelStore,
    generalMessageLedgerStore,
    message,
    promptFragmentAssembler,
    sessionService,
    topicControlPanelStore,
    workerPool,
    command,
    fallbackLanguage: generalUiLanguage,
    dispatchGlobalControlCommand,
  });
  if (controlPanelCommandResult) {
    markCommandHandled(serviceState, command.name);
    return {
      handled: true,
      command: command.name,
      reason: controlPanelCommandResult.reason,
    };
  }

  const surfaceCommandResult = await maybeHandleSurfaceCommand({
    api,
    command,
    config,
    globalControlPanelStore,
    lifecycleManager,
    markCommandHandled,
    message,
    promptFragmentAssembler,
    promptStartGuard,
    serviceState,
    sessionService,
    workerPool,
  });
  if (surfaceCommandResult) {
    return surfaceCommandResult;
  }

  const topicId = getTopicIdFromMessage(message);
  if (!topicId) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(message, buildNoSessionTopicMessage(generalUiLanguage)),
      null,
      lifecycleManager,
    );
    markCommandHandled(serviceState, command.name);
    return { handled: true, command: command.name, reason: "general-topic" };
  }

  const session = await sessionService.ensureSessionForMessage(message);
  let responseText = null;
  let handledSession = session;
  let backgroundCompactPromise = null;
  if (command.name === "diff") {
    const result = await handleDiffCommand({
      api,
      lifecycleManager,
      message,
      session,
      sessionService,
      language: getSessionUiLanguage(session),
    });
    handledSession = result.handledSession ?? handledSession;
    responseText = result.responseText;
    if (result.reason === "topic-unavailable") {
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: result.reason };
    }
  } else if (command.name === "compact") {
    const result = await handleCompactCommand({
      session,
      sessionService,
      promptHandoffStore,
      workerPool,
      language: getSessionUiLanguage(session),
    });
    responseText = result.responseText;
    backgroundCompactPromise = result.backgroundCompactPromise;
  } else if (command.name === "purge") {
    const result = await handlePurgeCommand({
      session,
      sessionService,
      workerPool,
      language: getSessionUiLanguage(session),
    });
    handledSession = result.handledSession ?? handledSession;
    responseText = result.responseText;
  } else {
    responseText = buildUnknownCommandMessage(getSessionUiLanguage(session), {
      omniEnabled: config.omniEnabled !== false,
    });
  }

  if (responseText) {
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, responseText),
      handledSession,
      lifecycleManager,
    );
    if (delivery.parked) {
      handledSession = delivery.session || handledSession;
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
      markCommandHandled(serviceState, command.name);
      return { handled: true, command: command.name, reason: "topic-unavailable" };
    }
  }
  await sessionService.recordHandledSession(
    serviceState,
    handledSession,
    command.name,
  );
  markCommandHandled(serviceState, command.name);

  if (backgroundCompactPromise) {
    launchCompactionInBackground({
      api,
      lifecycleManager,
      message,
      session,
      compactPromise: backgroundCompactPromise,
    });
  }

  return { handled: true, command: command.name };
}

export async function handleIncomingCallbackQuery({
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
  if (zooService) {
    const zooResult = await zooService.handleCallbackQuery({
      api,
      callbackQuery,
    });
    if (zooResult?.handled) {
      return zooResult;
    }
  }

  const result = await handleControlPanelCallbackQuery({
    handleIncomingMessage,
    api,
    botUsername,
    callbackQuery,
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

  if (!result.handled) {
    serviceState.ignoredUpdates += 1;
  }

  return result;
}
