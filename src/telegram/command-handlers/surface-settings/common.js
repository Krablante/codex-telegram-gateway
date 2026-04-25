import { buildReplyMessageParams } from "../../command-parsing.js";
import { safeSendMessage } from "../../topic-delivery.js";
import { buildBufferedPromptFlush } from "../prompt-flow.js";
import {
  finalizeHandledCommand,
  maybeFinalizeParkedDelivery,
} from "../surface-command-common.js";

export function isSupportedSettingsSurfaceCommand({
  command,
  scopedRuntimeSettingCommand = null,
  suffixCommand = null,
}) {
  const supportedCommand =
    command.name === "status"
    || command.name === "limits"
    || command.name === "interrupt"
    || command.name === "language"
    || command.name === "hosts"
    || command.name === "host"
    || command.name === "wait"
    || command.name === "suffix"
    || Boolean(
      scopedRuntimeSettingCommand
      || suffixCommand?.scope === "help",
    );
  return supportedCommand
    && !(command.name === "suffix" && suffixCommand?.scope === "help");
}

export function createBufferedPromptFlush({
  api,
  config,
  lifecycleManager = null,
  promptStartGuard = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  return buildBufferedPromptFlush({
    api,
    config,
    lifecycleManager,
    promptStartGuard,
    serviceState,
    sessionService,
    workerPool,
  });
}

export async function deliverSettingsCommandResult(
  {
    api,
    command,
    lifecycleManager = null,
    markCommandHandled,
    message,
    serviceState,
    sessionService,
  },
  {
    handledSession = null,
    reason = null,
    responseText = null,
  } = {},
) {
  if (responseText) {
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, responseText),
      handledSession,
      lifecycleManager,
    );
    const parkedResult = await maybeFinalizeParkedDelivery({
      commandName: command.name,
      delivery,
      handledSession,
      markCommandHandled,
      serviceState,
      sessionService,
    });
    if (parkedResult) {
      return parkedResult;
    }
  }

  return finalizeHandledCommand({
    commandName: command.name,
    handledSession,
    markCommandHandled,
    reason,
    serviceState,
    sessionService,
  });
}
