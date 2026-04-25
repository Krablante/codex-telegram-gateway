import { hasIncomingAttachments } from "../../incoming-attachments.js";
import { handleTopicPrompt } from "./start-run.js";
import { handleQueueCommand } from "./queue-command.js";

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
  void botUsername;
  void globalControlPanelStore;
  void promptFragmentAssembler;
  if (!command) {
    if (message.from?.is_bot) {
      serviceState.ignoredUpdates += 1;
      return { handled: false, reason: "bot-prompt-ignored" };
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
