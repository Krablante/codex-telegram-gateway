import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import { formatCodexLimitsMessage } from "../../../codex-runtime/limits.js";
import {
  PROMPT_SUFFIX_MAX_CHARS,
  normalizePromptSuffixText,
} from "../../../session-manager/prompt-suffix.js";
import { buildNoSessionTopicMessage } from "../prompt-flow.js";
import {
  handleScopedRuntimeSettingCommand,
} from "../runtime-settings.js";
import {
  buildHostStatusMessage,
  buildHostsOverviewMessage,
  resolveHostMessageLanguage,
} from "../host-commands.js";
import {
  buildPromptSuffixEmptyMessage,
  buildPromptSuffixMessage,
  buildPromptSuffixTooLongMessage,
  buildWaitDisabledMessage,
  buildWaitStateMessage,
  buildWaitUnavailableMessage,
  buildWaitUsageMessage,
} from "../topic-commands.js";
import { createBufferedPromptFlush } from "./common.js";

async function handleGlobalWaitCommand({
  api,
  config,
  generalUiLanguage,
  lifecycleManager = null,
  message,
  promptFragmentAssembler = null,
  promptStartGuard = null,
  serviceState,
  sessionService,
  waitCommand,
  workerPool,
}) {
  if (!promptFragmentAssembler) {
    return {
      responseText: buildWaitUnavailableMessage(generalUiLanguage),
    };
  }

  if (waitCommand.action === "show") {
    return {
      responseText: buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        "Global collection window",
        generalUiLanguage,
        "global",
      ),
    };
  }

  if (waitCommand.action === "off") {
    const canceled = promptFragmentAssembler.cancelPendingForMessage(message, {
      scope: "global",
    });
    return {
      responseText: buildWaitDisabledMessage(
        canceled,
        "global",
        generalUiLanguage,
      ),
    };
  }

  if (waitCommand.action === "set") {
    promptFragmentAssembler.openWindow({
      message,
      flushDelayMs: waitCommand.delayMs,
      scope: "global",
      flush: createBufferedPromptFlush({
        api,
        config,
        lifecycleManager,
        promptStartGuard,
        serviceState,
        sessionService,
        workerPool,
      }),
    });
    return {
      responseText: buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        "Global collection window enabled.",
        generalUiLanguage,
        "global",
      ),
    };
  }

  return {
    responseText: buildWaitUsageMessage(generalUiLanguage),
  };
}

async function handleGlobalLimitsCommand({
  generalUiLanguage,
  sessionService,
}) {
  const limitsSummary =
    typeof sessionService.getCodexLimitsSummary === "function"
      ? await sessionService.getCodexLimitsSummary()
      : null;
  return {
    responseText: formatCodexLimitsMessage(limitsSummary, generalUiLanguage),
  };
}

async function handleHostsOverviewCommand({
  generalUiLanguage,
  message,
  sessionService,
  topicId = null,
}) {
  const handledSession = topicId
    ? await sessionService.ensureSessionForMessage(message)
    : null;
  const language = resolveHostMessageLanguage(handledSession, generalUiLanguage);
  const hostStatuses =
    typeof sessionService.listTopicCreationHosts === "function"
      ? await sessionService.listTopicCreationHosts()
      : [];
  return {
    handledSession,
    responseText: buildHostsOverviewMessage(hostStatuses, language),
  };
}

async function handleHostStatusCommand({
  config,
  generalUiLanguage,
  hostCommand = null,
  message,
  sessionService,
  topicId = null,
}) {
  const handledSession = topicId
    ? await sessionService.ensureSessionForMessage(message)
    : null;
  const language = resolveHostMessageLanguage(handledSession, generalUiLanguage);
  const targetHostId =
    hostCommand?.hostId
    ?? handledSession?.execution_host_id
    ?? config.currentHostId
    ?? null;
  const hostStatus =
    targetHostId && typeof sessionService.resolveTopicCreationHost === "function"
      ? await sessionService.resolveTopicCreationHost(targetHostId)
      : handledSession && typeof sessionService.resolveSessionExecution === "function"
        ? await sessionService.resolveSessionExecution(handledSession)
        : null;
  return {
    handledSession,
    responseText: buildHostStatusMessage(hostStatus, language, {
      session: handledSession && !hostCommand?.hostId ? handledSession : null,
    }),
  };
}

async function handleGlobalSuffixCommand({
  generalUiLanguage,
  message,
  sessionService,
  suffixCommand,
  topicId = null,
}) {
  const handledSession = topicId
    ? await sessionService.ensureSessionForMessage(message)
    : null;
  const language = handledSession
    ? getSessionUiLanguage(handledSession)
    : generalUiLanguage;

  if (suffixCommand.action === "show") {
    return {
      handledSession,
      responseText: buildPromptSuffixMessage(
        await sessionService.getGlobalPromptSuffix(),
        "Global prompt suffix",
        "global",
        language,
      ),
    };
  }

  if (suffixCommand.action === "set") {
    const suffixText = normalizePromptSuffixText(suffixCommand.text);
    if (!suffixText) {
      return {
        handledSession,
        responseText: buildPromptSuffixEmptyMessage("global", language),
      };
    }
    if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
      return {
        handledSession,
        responseText: buildPromptSuffixTooLongMessage(
          PROMPT_SUFFIX_MAX_CHARS,
          language,
        ),
      };
    }
    const updated = await sessionService.updateGlobalPromptSuffix({
      text: suffixText,
      enabled: true,
    });
    return {
      handledSession,
      responseText: buildPromptSuffixMessage(
        updated,
        "Global prompt suffix updated.",
        "global",
        language,
      ),
    };
  }

  if (suffixCommand.action === "on") {
    const current = await sessionService.getGlobalPromptSuffix();
    if (!normalizePromptSuffixText(current.prompt_suffix_text)) {
      return {
        handledSession,
        responseText: buildPromptSuffixEmptyMessage("global", language),
      };
    }
    const updated = await sessionService.updateGlobalPromptSuffix({
      enabled: true,
    });
    return {
      handledSession,
      responseText: buildPromptSuffixMessage(
        updated,
        "Global prompt suffix enabled.",
        "global",
        language,
      ),
    };
  }

  if (suffixCommand.action === "off") {
    const updated = await sessionService.updateGlobalPromptSuffix({
      enabled: false,
    });
    return {
      handledSession,
      responseText: buildPromptSuffixMessage(
        updated,
        "Global prompt suffix disabled.",
        "global",
        language,
      ),
    };
  }

  const updated = await sessionService.clearGlobalPromptSuffix();
  return {
    handledSession,
    responseText: buildPromptSuffixMessage(
      updated,
      "Global prompt suffix cleared.",
      "global",
      language,
    ),
  };
}

async function handleGlobalRuntimeSettingsCommand({
  command,
  config,
  generalUiLanguage,
  message,
  scopedRuntimeSettingCommand,
  sessionService,
  topicId = null,
}) {
  let handledSession = topicId
    ? await sessionService.ensureSessionForMessage(message)
    : null;
  const language = handledSession
    ? getSessionUiLanguage(handledSession)
    : generalUiLanguage;
  const result = await handleScopedRuntimeSettingCommand({
    commandName: command.name,
    parsedCommand: scopedRuntimeSettingCommand,
    session: handledSession,
    sessionService,
    config,
    language,
  });
  handledSession = result.handledSession;
  return {
    handledSession,
    responseText: result.responseText,
  };
}

export async function maybeHandleGeneralSettingsSurfaceCommand(context) {
  const {
    command,
    generalUiLanguage,
    scopedRuntimeSettingCommand = null,
    suffixCommand = null,
    topicId = null,
    waitCommand = null,
  } = context;

  if (command.name === "wait" && waitCommand?.scope === "global" && !topicId) {
    return handleGlobalWaitCommand(context);
  }

  if (command.name === "limits" && !topicId) {
    return handleGlobalLimitsCommand(context);
  }

  if (command.name === "hosts") {
    return handleHostsOverviewCommand(context);
  }

  if (command.name === "host") {
    return handleHostStatusCommand(context);
  }

  if (command.name === "suffix" && suffixCommand?.scope === "global") {
    return handleGlobalSuffixCommand(context);
  }

  if (scopedRuntimeSettingCommand?.scope === "global") {
    return handleGlobalRuntimeSettingsCommand(context);
  }

  if (!topicId) {
    return {
      reason: "general-topic",
      responseText: buildNoSessionTopicMessage(generalUiLanguage),
    };
  }

  return null;
}
