import { getSessionUiLanguage } from "../../../i18n/ui-language.js";
import { formatCodexLimitsMessage } from "../../../codex-runtime/limits.js";
import {
  PROMPT_SUFFIX_MAX_CHARS,
  normalizePromptSuffixText,
} from "../../../session-manager/prompt-suffix.js";
import { resolveStatusView } from "../../status-view.js";
import { handleScopedRuntimeSettingCommand } from "../runtime-settings.js";
import { buildInterruptMessage } from "../surface-command-common.js";
import {
  buildLanguageStateMessage,
  buildLanguageUpdatedMessage,
  buildLanguageUsageMessage,
  buildPromptSuffixEmptyMessage,
  buildPromptSuffixMessage,
  buildPromptSuffixTooLongMessage,
  buildTopicPromptSuffixStateMessage,
  buildTopicPromptSuffixUsageMessage,
  buildWaitDisabledMessage,
  buildWaitStateMessage,
  buildWaitUnavailableMessage,
  buildWaitUsageMessage,
} from "../topic-commands.js";
import { createBufferedPromptFlush } from "./common.js";

async function handleStatusCommand({
  language,
  message,
  serviceState,
  session,
  sessionService,
  workerPool,
}) {
  const statusView = await resolveStatusView({
    state: serviceState,
    message,
    session,
    sessionService,
    workerPool,
    language,
  });
  return {
    handledSession: statusView.session,
    responseText: statusView.text,
  };
}

async function handleLimitsCommand({ language, sessionService, session }) {
  const limitsSummary =
    typeof sessionService.getCodexLimitsSummary === "function"
      ? await sessionService.getCodexLimitsSummary()
      : null;
  return {
    handledSession: session,
    responseText: formatCodexLimitsMessage(limitsSummary, language),
  };
}

function handleInterruptCommand({ language, message, session, workerPool }) {
  return {
    handledSession: session,
    responseText: buildInterruptMessage(
      message,
      session,
      workerPool.interrupt(session.session_key),
      language,
    ),
  };
}

async function handleLanguageCommand({
  language,
  languageCommand,
  session,
  sessionService,
}) {
  if (languageCommand.action === "show") {
    return {
      handledSession: session,
      responseText: buildLanguageStateMessage(session, language),
    };
  }

  if (languageCommand.action === "set") {
    const handledSession = await sessionService.updateUiLanguage(session, {
      language: languageCommand.language,
    });
    return {
      handledSession,
      responseText: buildLanguageUpdatedMessage(handledSession),
    };
  }

  return {
    handledSession: session,
    responseText: buildLanguageUsageMessage(language),
  };
}

function buildTopicWaitHeading(waitCommand) {
  return waitCommand.scope === "global"
    ? "Global collection window"
    : waitCommand.scope === "topic"
      ? "Local collection window"
      : "Collection windows";
}

function buildTopicWaitEnabledHeading(waitCommand) {
  return waitCommand.scope === "global"
    ? "Global collection window enabled."
    : "Local collection window enabled.";
}

async function handleWaitCommand({
  api,
  config,
  language,
  lifecycleManager = null,
  message,
  promptFragmentAssembler = null,
  promptStartGuard = null,
  serviceState,
  session,
  sessionService,
  waitCommand,
  workerPool,
}) {
  if (!promptFragmentAssembler) {
    return {
      handledSession: session,
      responseText: buildWaitUnavailableMessage(language),
    };
  }

  if (waitCommand.action === "show") {
    return {
      handledSession: session,
      responseText: buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        buildTopicWaitHeading(waitCommand),
        language,
        waitCommand.scope,
      ),
    };
  }

  if (waitCommand.action === "off") {
    const canceled = promptFragmentAssembler.cancelPendingForMessage(message, {
      scope: waitCommand.scope,
    });
    return {
      handledSession: session,
      responseText: buildWaitDisabledMessage(
        canceled,
        waitCommand.scope,
        language,
      ),
    };
  }

  if (waitCommand.action === "set") {
    promptFragmentAssembler.openWindow({
      message,
      flushDelayMs: waitCommand.delayMs,
      scope: waitCommand.scope,
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
      handledSession: session,
      responseText: buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        buildTopicWaitEnabledHeading(waitCommand),
        language,
        waitCommand.scope,
      ),
    };
  }

  return {
    handledSession: session,
    responseText: buildWaitUsageMessage(language),
  };
}

async function handleSuffixCommand({
  language,
  session,
  sessionService,
  suffixCommand,
}) {
  if (suffixCommand.scope === "topic-control") {
    if (suffixCommand.action === "show") {
      return {
        handledSession: session,
        responseText: buildTopicPromptSuffixStateMessage(
          session,
          "Topic prompt suffix routing",
          language,
        ),
      };
    }

    if (suffixCommand.action === "on") {
      const handledSession = await sessionService.updatePromptSuffixTopicState(
        session,
        {
          enabled: true,
        },
      );
      return {
        handledSession,
        responseText: buildTopicPromptSuffixStateMessage(
          handledSession,
          "Topic prompt suffix routing enabled.",
          getSessionUiLanguage(handledSession),
        ),
      };
    }

    if (suffixCommand.action === "off") {
      const handledSession = await sessionService.updatePromptSuffixTopicState(
        session,
        {
          enabled: false,
        },
      );
      return {
        handledSession,
        responseText: buildTopicPromptSuffixStateMessage(
          handledSession,
          "Topic prompt suffix routing disabled.",
          getSessionUiLanguage(handledSession),
        ),
      };
    }

    return {
      handledSession: session,
      responseText: buildTopicPromptSuffixUsageMessage(language),
    };
  }

  if (suffixCommand.action === "show") {
    return {
      handledSession: session,
      responseText: buildPromptSuffixMessage(
        session,
        "Prompt suffix",
        "topic",
        language,
      ),
    };
  }

  if (suffixCommand.action === "set") {
    const suffixText = normalizePromptSuffixText(suffixCommand.text);
    if (!suffixText) {
      return {
        handledSession: session,
        responseText: buildPromptSuffixEmptyMessage("topic", language),
      };
    }
    if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
      return {
        handledSession: session,
        responseText: buildPromptSuffixTooLongMessage(
          PROMPT_SUFFIX_MAX_CHARS,
          language,
        ),
      };
    }
    const handledSession = await sessionService.updatePromptSuffix(session, {
      text: suffixText,
      enabled: true,
    });
    return {
      handledSession,
      responseText: buildPromptSuffixMessage(
        handledSession,
        "Prompt suffix updated.",
        "topic",
        getSessionUiLanguage(handledSession),
      ),
    };
  }

  if (suffixCommand.action === "on") {
    if (!normalizePromptSuffixText(session.prompt_suffix_text)) {
      return {
        handledSession: session,
        responseText: buildPromptSuffixEmptyMessage("topic", language),
      };
    }
    const handledSession = await sessionService.updatePromptSuffix(session, {
      enabled: true,
    });
    return {
      handledSession,
      responseText: buildPromptSuffixMessage(
        handledSession,
        "Prompt suffix enabled.",
        "topic",
        getSessionUiLanguage(handledSession),
      ),
    };
  }

  if (suffixCommand.action === "off") {
    const handledSession = await sessionService.updatePromptSuffix(session, {
      enabled: false,
    });
    return {
      handledSession,
      responseText: buildPromptSuffixMessage(
        handledSession,
        "Prompt suffix disabled.",
        "topic",
        getSessionUiLanguage(handledSession),
      ),
    };
  }

  const handledSession = await sessionService.clearPromptSuffix(session);
  return {
    handledSession,
    responseText: buildPromptSuffixMessage(
      handledSession,
      "Prompt suffix cleared.",
      "topic",
      getSessionUiLanguage(handledSession),
    ),
  };
}

async function handleRuntimeSettingsCommand({
  command,
  config,
  language,
  scopedRuntimeSettingCommand,
  session,
  sessionService,
}) {
  const result = await handleScopedRuntimeSettingCommand({
    commandName: command.name,
    parsedCommand: scopedRuntimeSettingCommand,
    session,
    sessionService,
    config,
    language,
  });
  return {
    handledSession: result.handledSession ?? session,
    responseText: result.responseText,
  };
}

const TOPIC_COMMAND_HANDLERS = {
  interrupt: handleInterruptCommand,
  language: handleLanguageCommand,
  limits: handleLimitsCommand,
  status: handleStatusCommand,
  suffix: handleSuffixCommand,
  wait: handleWaitCommand,
};

export async function maybeHandleTopicSettingsSurfaceCommand(context) {
  const session = await context.sessionService.ensureSessionForMessage(
    context.message,
  );
  const language = getSessionUiLanguage(session);
  const topicContext = {
    ...context,
    handledSession: session,
    language,
    session,
  };

  const handler = TOPIC_COMMAND_HANDLERS[context.command.name];
  if (handler) {
    return handler(topicContext);
  }

  if (context.scopedRuntimeSettingCommand) {
    return handleRuntimeSettingsCommand(topicContext);
  }

  return null;
}
