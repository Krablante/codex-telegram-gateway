import { DEFAULT_UI_LANGUAGE } from "../../i18n/ui-language.js";
import { getTopicIdFromMessage } from "../../session-manager/session-key.js";
import {
  parseHostCommandArgs,
  parseLanguageCommandArgs,
  parsePromptSuffixCommandArgs,
  parseScopedRuntimeSettingCommandArgs,
  parseWaitCommandArgs,
} from "../command-parsing.js";
import { resolveGeneralUiLanguage } from "./control-surface.js";
import { maybeHandleReferenceSurfaceCommand } from "./surface-reference-commands.js";
import { maybeHandleSettingsSurfaceCommand } from "./surface-settings-commands.js";
import { getCodexRuntimeCommandSpec } from "./runtime-settings.js";

export async function maybeHandleSurfaceCommand({
  api,
  command,
  config,
  globalControlPanelStore = null,
  lifecycleManager = null,
  markCommandHandled,
  message,
  promptFragmentAssembler = null,
  promptStartGuard = null,
  serviceState,
  sessionService,
  workerPool,
}) {
  const suffixCommand =
    command.name === "suffix"
      ? parsePromptSuffixCommandArgs(command.args)
      : null;
  const waitCommand =
    command.name === "wait"
      ? parseWaitCommandArgs(command.args)
      : null;
  const languageCommand =
    command.name === "language"
      ? parseLanguageCommandArgs(command.args)
      : null;
  const hostCommand =
    command.name === "host"
      ? parseHostCommandArgs(command.args)
      : null;
  const scopedRuntimeSettingCommand = getCodexRuntimeCommandSpec(command.name)
    ? parseScopedRuntimeSettingCommandArgs(command.args)
    : null;

  const supportedCommand =
    command.name === "help"
    || command.name === "guide"
    || command.name === "status"
    || command.name === "limits"
    || command.name === "interrupt"
    || command.name === "language"
    || command.name === "hosts"
    || command.name === "host"
    || command.name === "wait"
    || command.name === "suffix"
    || Boolean(scopedRuntimeSettingCommand);
  if (!supportedCommand) {
    return null;
  }

  const topicId = getTopicIdFromMessage(message);
  const generalUiLanguage = !topicId
    ? await resolveGeneralUiLanguage(globalControlPanelStore)
    : DEFAULT_UI_LANGUAGE;

  const referenceResult = await maybeHandleReferenceSurfaceCommand({
    api,
    command,
    config,
    generalUiLanguage,
    lifecycleManager,
    markCommandHandled,
    message,
    serviceState,
    sessionService,
    suffixCommand,
    topicId,
  });
  if (referenceResult) {
    return referenceResult;
  }

  return maybeHandleSettingsSurfaceCommand({
    api,
    command,
    config,
    generalUiLanguage,
    languageCommand,
    hostCommand,
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
  });
}
