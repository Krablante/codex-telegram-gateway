import { handleGuideReferenceCommand } from "./surface-reference/guide-handler.js";
import { handleHelpReferenceCommand } from "./surface-reference/help-handler.js";

export async function maybeHandleReferenceSurfaceCommand({
  api,
  command,
  config,
  generalUiLanguage,
  lifecycleManager = null,
  markCommandHandled,
  message,
  serviceState,
  sessionService,
  suffixCommand = null,
  topicId = null,
}) {
  const isSuffixHelpCommand =
    command.name === "suffix" && suffixCommand?.scope === "help";
  if (
    command.name !== "help"
    && command.name !== "guide"
    && !isSuffixHelpCommand
  ) {
    return null;
  }

  if (command.name === "help" || isSuffixHelpCommand) {
    return handleHelpReferenceCommand({
      api,
      command,
      generalUiLanguage,
      lifecycleManager,
      markCommandHandled,
      message,
      serviceState,
      sessionService,
      suffixCommand,
      topicId,
    });
  }

  return handleGuideReferenceCommand({
    api,
    command,
    config,
    generalUiLanguage,
    lifecycleManager,
    markCommandHandled,
    message,
    serviceState,
    sessionService,
    topicId,
  });
}
