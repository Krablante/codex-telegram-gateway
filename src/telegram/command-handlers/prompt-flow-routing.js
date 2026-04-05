import { isWaitFlushWord } from "../../i18n/ui-language.js";
import {
  canAutoModeAcceptPromptFromMessage,
  isAutoModeHumanInputLocked,
} from "../../session-manager/auto-mode.js";
import { getSessionUiLanguage } from "../../i18n/ui-language.js";
import {
  buildReplyMessageParams,
  extractBotCommand,
  isForeignBotCommand,
  parseQueueCommandArgs,
} from "../command-parsing.js";
import {
  extractPromptText,
  hasIncomingAttachments,
} from "../incoming-attachments.js";
import { safeSendMessage } from "../topic-delivery.js";
import { getTopicIdFromMessage } from "../../session-manager/session-key.js";
import { TOPIC_CONTROL_PANEL_COMMAND } from "../topic-control-panel.js";
import { resolveGeneralUiLanguage } from "./control-surface.js";
import {
  AUTO_MODE_ALLOWED_HUMAN_COMMANDS,
  buildNoSessionTopicMessage,
  buildOmniUnavailableMessage,
  buildQueueAutoUnavailableMessage,
} from "./prompt-flow-common.js";
import { buildBufferedPromptFlush, handleTopicPrompt } from "./prompt-flow-starts.js";
import { handleQueueCommand } from "./prompt-flow-queue.js";

export function isManualWaitFlushMessage(message, promptFragmentAssembler) {
  if (!promptFragmentAssembler) {
    return false;
  }

  const waitState = promptFragmentAssembler.getStateForMessage(message);
  if (!waitState.active || waitState.mode !== "manual" || waitState.messageCount <= 0) {
    return false;
  }

  if (hasIncomingAttachments(message)) {
    return false;
  }

  const promptText = extractPromptText(message, { trim: true });
  return isWaitFlushWord(promptText);
}

export async function preparePromptRoutingContext({
  botUsername,
  message,
  promptFragmentAssembler = null,
  queuePromptAssembler = null,
}) {
  if (isManualWaitFlushMessage(message, promptFragmentAssembler)) {
    await promptFragmentAssembler.flushPendingForMessage(message);
    return {
      handledResult: { handled: true, reason: "prompt-buffer-flushed" },
    };
  }

  const command = extractBotCommand(message, botUsername);
  const foreignBotCommand = !command && isForeignBotCommand(message, botUsername);

  if (
    queuePromptAssembler?.hasPendingForSameTopicMessage(message)
    && !message.from?.is_bot
  ) {
    if (command?.name === "q") {
      await queuePromptAssembler.flushPendingForMessage(message);
    } else if (
      !command
      && !foreignBotCommand
      && (message.text || message.caption || hasIncomingAttachments(message))
    ) {
      queuePromptAssembler.enqueue({ message });
      return {
        handledResult: { handled: true, reason: "queue-buffered" },
      };
    } else if (command) {
      queuePromptAssembler.cancelPendingForMessage(message);
    }
  }

  if (
    command
    && command.name !== "wait"
    && command.name !== TOPIC_CONTROL_PANEL_COMMAND
    && command.name !== "auto"
    && promptFragmentAssembler?.hasPendingForSameTopicMessage(message)
  ) {
    promptFragmentAssembler.cancelPendingForMessage(message, {
      preserveManualWindow: true,
    });
  }

  const parsedQueueCommand =
    command?.name === "q"
      ? parseQueueCommandArgs(command.args)
      : null;
  const effectiveQueueCommand =
    parsedQueueCommand?.action === "status" && hasIncomingAttachments(message)
      ? {
          action: "enqueue",
          text: "",
          position: null,
        }
      : parsedQueueCommand;

  return {
    command,
    foreignBotCommand,
    effectiveQueueCommand,
  };
}

export async function maybeHandlePromptCommandRouting({
  api,
  botUsername,
  config,
  lifecycleManager = null,
  globalControlPanelStore = null,
  message,
  promptStartGuard = null,
  promptFragmentAssembler = null,
  queuePromptAssembler = null,
  serviceState,
  sessionService,
  workerPool,
  command,
  foreignBotCommand = false,
  effectiveQueueCommand = null,
  markCommandHandled = null,
}) {
  if (!command) {
    if (message.from?.is_bot) {
      const botSession =
        getTopicIdFromMessage(message) &&
        typeof sessionService.ensureRunnableSessionForMessage === "function"
          ? await sessionService.ensureRunnableSessionForMessage(message)
          : null;
      if (
        !botSession ||
        config.omniEnabled === false ||
        !isAutoModeHumanInputLocked(botSession) ||
        !canAutoModeAcceptPromptFromMessage(botSession, message)
      ) {
        serviceState.ignoredUpdates += 1;
        return { handled: false, reason: "bot-prompt-ignored" };
      }
    }

    if (foreignBotCommand) {
      serviceState.ignoredUpdates += 1;
      return { handled: false, reason: "foreign-bot-command" };
    }

    if (!message.text && !message.caption && !hasIncomingAttachments(message)) {
      serviceState.ignoredUpdates += 1;
      return { handled: false, reason: "not-a-text-message" };
    }

    return handleTopicPrompt({
      api,
      config,
      lifecycleManager,
      message,
      promptStartGuard,
      promptFragmentAssembler,
      serviceState,
      sessionService,
      workerPool,
    });
  }

  const omniSpecificCommand =
    command.name === "auto"
    || command.name === "omni"
    || command.name === "omni_model"
    || command.name === "omni_reasoning";
  if (config.omniEnabled === false && omniSpecificCommand) {
    const topicId = getTopicIdFromMessage(message);
    const handledSession = topicId
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const language = handledSession
      ? getSessionUiLanguage(handledSession)
      : await resolveGeneralUiLanguage(globalControlPanelStore);
    await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildOmniUnavailableMessage(language, command.name),
      ),
      handledSession,
      lifecycleManager,
    );
    if (handledSession) {
      await sessionService.recordHandledSession(
        serviceState,
        handledSession,
        command.name,
      );
    }
    markCommandHandled?.(serviceState, command.name);
    return { handled: true, command: command.name, reason: "omni-disabled" };
  }

  if (command.name === "auto" || command.name === "omni") {
    serviceState.ignoredUpdates += 1;
    return { handled: false, reason: "omni-owned-command" };
  }

  const autoCommandLockSession =
    getTopicIdFromMessage(message) &&
    typeof sessionService.ensureRunnableSessionForMessage === "function"
      ? await sessionService.ensureRunnableSessionForMessage(message)
      : null;
  if (
    autoCommandLockSession &&
    config.omniEnabled !== false &&
    isAutoModeHumanInputLocked(autoCommandLockSession) &&
    !canAutoModeAcceptPromptFromMessage(autoCommandLockSession, message) &&
    !AUTO_MODE_ALLOWED_HUMAN_COMMANDS.has(command.name)
  ) {
    if (command.name === "q") {
      await safeSendMessage(
        api,
        buildReplyMessageParams(
          message,
          buildQueueAutoUnavailableMessage(
            getSessionUiLanguage(autoCommandLockSession),
          ),
        ),
        autoCommandLockSession,
        lifecycleManager,
      );
    }
    return { handled: true, reason: "auto-topic-human-command-blocked" };
  }

  if (command.name === "q") {
    const result = await handleQueueCommand({
      api,
      botUsername,
      config,
      lifecycleManager,
      message,
      parsedCommand: effectiveQueueCommand,
      promptStartGuard,
      queuePromptAssembler,
      serviceState,
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
    markCommandHandled?.(serviceState, command.name);
    return { handled: true, command: command.name, reason: result.reason };
  }

  return null;
}

export function buildApplyTopicWaitChange({
  api,
  botUsername,
  config,
  lifecycleManager,
  promptStartGuard,
  promptFragmentAssembler = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  return async ({
    message,
    value,
  }) => {
    if (!promptFragmentAssembler) {
      return { available: false };
    }

    if (value === "off") {
      promptFragmentAssembler.cancelPendingForMessage(message, {
        scope: "topic",
      });
      return { available: true };
    }

    const seconds = Number(value);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      return { available: false };
    }

    promptFragmentAssembler.openWindow({
      message,
      flushDelayMs: seconds * 1000,
      scope: "topic",
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
