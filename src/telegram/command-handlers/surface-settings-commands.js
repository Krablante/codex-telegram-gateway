import { DEFAULT_UI_LANGUAGE } from "../../i18n/ui-language.js";
import { getCodexRuntimeCommandSpec } from "./runtime-settings.js";
import { maybeHandleGeneralSettingsSurfaceCommand } from "./surface-settings/general-handlers.js";
import { maybeHandleTopicSettingsSurfaceCommand } from "./surface-settings/topic-handlers.js";
import {
  deliverSettingsCommandResult,
  isSupportedSettingsSurfaceCommand,
} from "./surface-settings/common.js";

export async function maybeHandleSettingsSurfaceCommand({
  api,
  command,
  config,
  generalUiLanguage = DEFAULT_UI_LANGUAGE,
  hostCommand = null,
  languageCommand = null,
  lifecycleManager = null,
  markCommandHandled,
  message,
  promptFragmentAssembler = null,
  promptStartGuard = null,
  scopedRuntimeSettingCommand = null,
  serviceState,
  sessionService,
  suffixCommand = null,
  topicId = null,
  waitCommand = null,
  workerPool,
}) {
  if (!isSupportedSettingsSurfaceCommand({
    command,
    scopedRuntimeSettingCommand: scopedRuntimeSettingCommand
      || getCodexRuntimeCommandSpec(command.name),
    suffixCommand,
  })) {
    return null;
  }

  const context = {
    api,
    command,
    config,
    generalUiLanguage,
    hostCommand,
    languageCommand,
    lifecycleManager,
    markCommandHandled,
    message,
    promptFragmentAssembler,
    promptStartGuard,
    scopedRuntimeSettingCommand,
    serviceState,
    sessionService,
    suffixCommand,
    topicId,
    waitCommand,
    workerPool,
  };

  const generalResult = await maybeHandleGeneralSettingsSurfaceCommand(context);
  if (generalResult) {
    return deliverSettingsCommandResult(context, generalResult);
  }

  const topicResult = await maybeHandleTopicSettingsSurfaceCommand(context);
  if (!topicResult) {
    return null;
  }

  return deliverSettingsCommandResult(context, topicResult);
}
