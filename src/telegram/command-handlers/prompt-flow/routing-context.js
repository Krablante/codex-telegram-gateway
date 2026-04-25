import { isWaitFlushWord } from "../../../i18n/ui-language.js";
import {
  extractBotCommand,
  isForeignBotCommand,
  parseQueueCommandArgs,
} from "../../command-parsing.js";
import {
  extractPromptText,
  hasIncomingAttachments,
} from "../../incoming-attachments.js";
import { TOPIC_CONTROL_PANEL_COMMAND } from "../../topic-control-panel.js";
import { buildBufferedPromptFlush } from "./start-run.js";

function isManualWaitFlushMessage(message, promptFragmentAssembler) {
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
      const flushed = await queuePromptAssembler.flushPendingForMessage(message);
      if (flushed && !String(command.args ?? "").trim()) {
        return {
          handledResult: { handled: true, reason: "queue-buffer-flushed" },
        };
      }
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
