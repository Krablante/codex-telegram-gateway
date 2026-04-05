import {
  DEFAULT_UI_LANGUAGE,
  getSessionUiLanguage,
} from "../../i18n/ui-language.js";
import { formatCodexLimitsMessage } from "../../codex-runtime/limits.js";
import {
  PROMPT_SUFFIX_MAX_CHARS,
  normalizePromptSuffixText,
} from "../../session-manager/prompt-suffix.js";
import { buildReplyMessageParams } from "../command-parsing.js";
import { resolveStatusView } from "../status-view.js";
import { safeSendMessage } from "../topic-delivery.js";
import {
  buildBufferedPromptFlush,
  buildNoSessionTopicMessage,
} from "./prompt-flow.js";
import {
  getCodexRuntimeCommandSpec,
  handleScopedRuntimeSettingCommand,
} from "./runtime-settings.js";
import {
  buildInterruptMessage,
  finalizeHandledCommand,
  maybeFinalizeParkedDelivery,
} from "./surface-command-common.js";
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
} from "./topic-commands.js";

export async function maybeHandleSettingsSurfaceCommand({
  api,
  command,
  config,
  generalUiLanguage = DEFAULT_UI_LANGUAGE,
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
  const supportedCommand =
    command.name === "status"
    || command.name === "limits"
    || command.name === "interrupt"
    || command.name === "language"
    || command.name === "wait"
    || command.name === "suffix"
    || Boolean(
      scopedRuntimeSettingCommand || getCodexRuntimeCommandSpec(command.name),
    );
  if (!supportedCommand || (command.name === "suffix" && suffixCommand?.scope === "help")) {
    return null;
  }

  if (
    command.name === "wait"
    && waitCommand?.scope === "global"
    && !topicId
  ) {
    let responseText = null;

    if (!promptFragmentAssembler) {
      responseText = buildWaitUnavailableMessage(generalUiLanguage);
    } else if (waitCommand.action === "show") {
      responseText = buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        "Global collection window",
        generalUiLanguage,
        "global",
      );
    } else if (waitCommand.action === "off") {
      const canceled = promptFragmentAssembler.cancelPendingForMessage(message, {
        scope: "global",
      });
      responseText = buildWaitDisabledMessage(
        canceled,
        "global",
        generalUiLanguage,
      );
    } else if (waitCommand.action === "set") {
      promptFragmentAssembler.openWindow({
        message,
        flushDelayMs: waitCommand.delayMs,
        scope: "global",
        flush: buildBufferedPromptFlush({
          api,
          config,
          lifecycleManager,
          promptStartGuard,
          serviceState,
          sessionService,
          workerPool,
        }),
      });
      responseText = buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        "Global collection window enabled.",
        generalUiLanguage,
        "global",
      );
    } else {
      responseText = buildWaitUsageMessage(generalUiLanguage);
    }

    await safeSendMessage(
      api,
      buildReplyMessageParams(message, responseText),
      null,
      lifecycleManager,
    );
    return finalizeHandledCommand({
      commandName: command.name,
      markCommandHandled,
      serviceState,
      sessionService,
    });
  }

  if (command.name === "limits" && !topicId) {
    const limitsSummary =
      typeof sessionService.getCodexLimitsSummary === "function"
        ? await sessionService.getCodexLimitsSummary()
        : null;
    await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        formatCodexLimitsMessage(limitsSummary, generalUiLanguage),
      ),
      null,
      lifecycleManager,
    );
    return finalizeHandledCommand({
      commandName: command.name,
      markCommandHandled,
      serviceState,
      sessionService,
    });
  }

  if (command.name === "suffix" && suffixCommand?.scope === "global") {
    const handledSession = topicId
      ? await sessionService.ensureSessionForMessage(message)
      : null;
    const language = handledSession
      ? getSessionUiLanguage(handledSession)
      : generalUiLanguage;
    let responseText = null;

    if (suffixCommand.action === "show") {
      responseText = buildPromptSuffixMessage(
        await sessionService.getGlobalPromptSuffix(),
        "Global prompt suffix",
        "global",
        language,
      );
    } else if (suffixCommand.action === "set") {
      const suffixText = normalizePromptSuffixText(suffixCommand.text);
      if (!suffixText) {
        responseText = buildPromptSuffixEmptyMessage("global", language);
      } else if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
        responseText = buildPromptSuffixTooLongMessage(
          PROMPT_SUFFIX_MAX_CHARS,
          language,
        );
      } else {
        const updated = await sessionService.updateGlobalPromptSuffix({
          text: suffixText,
          enabled: true,
        });
        responseText = buildPromptSuffixMessage(
          updated,
          "Global prompt suffix updated.",
          "global",
          language,
        );
      }
    } else if (suffixCommand.action === "on") {
      const current = await sessionService.getGlobalPromptSuffix();
      if (!normalizePromptSuffixText(current.prompt_suffix_text)) {
        responseText = buildPromptSuffixEmptyMessage("global", language);
      } else {
        const updated = await sessionService.updateGlobalPromptSuffix({
          enabled: true,
        });
        responseText = buildPromptSuffixMessage(
          updated,
          "Global prompt suffix enabled.",
          "global",
          language,
        );
      }
    } else if (suffixCommand.action === "off") {
      const updated = await sessionService.updateGlobalPromptSuffix({
        enabled: false,
      });
      responseText = buildPromptSuffixMessage(
        updated,
        "Global prompt suffix disabled.",
        "global",
        language,
      );
    } else if (suffixCommand.action === "clear") {
      const updated = await sessionService.clearGlobalPromptSuffix();
      responseText = buildPromptSuffixMessage(
        updated,
        "Global prompt suffix cleared.",
        "global",
        language,
      );
    }

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
    return finalizeHandledCommand({
      commandName: command.name,
      handledSession,
      markCommandHandled,
      serviceState,
      sessionService,
    });
  }

  if (
    scopedRuntimeSettingCommand
    && scopedRuntimeSettingCommand.scope === "global"
  ) {
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
    const delivery = await safeSendMessage(
      api,
      buildReplyMessageParams(message, result.responseText),
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
    return finalizeHandledCommand({
      commandName: command.name,
      handledSession,
      markCommandHandled,
      serviceState,
      sessionService,
    });
  }

  if (!topicId) {
    await safeSendMessage(
      api,
      buildReplyMessageParams(
        message,
        buildNoSessionTopicMessage(generalUiLanguage),
      ),
      null,
      lifecycleManager,
    );
    return finalizeHandledCommand({
      commandName: command.name,
      markCommandHandled,
      reason: "general-topic",
      serviceState,
      sessionService,
    });
  }

  const session = await sessionService.ensureSessionForMessage(message);
  const language = getSessionUiLanguage(session);
  let responseText = null;
  let handledSession = session;

  if (command.name === "status") {
    const statusView = await resolveStatusView({
      state: serviceState,
      message,
      session,
      sessionService,
      workerPool,
      language,
    });
    handledSession = statusView.session;
    responseText = statusView.text;
  } else if (command.name === "limits") {
    const limitsSummary =
      typeof sessionService.getCodexLimitsSummary === "function"
        ? await sessionService.getCodexLimitsSummary()
        : null;
    responseText = formatCodexLimitsMessage(limitsSummary, language);
  } else if (command.name === "interrupt") {
    responseText = buildInterruptMessage(
      message,
      session,
      workerPool.interrupt(session.session_key),
      language,
    );
  } else if (command.name === "language") {
    if (languageCommand.action === "show") {
      responseText = buildLanguageStateMessage(session, language);
    } else if (languageCommand.action === "set") {
      handledSession = await sessionService.updateUiLanguage(session, {
        language: languageCommand.language,
      });
      responseText = buildLanguageUpdatedMessage(handledSession);
    } else {
      responseText = buildLanguageUsageMessage(language);
    }
  } else if (command.name === "wait") {
    if (!promptFragmentAssembler) {
      responseText = buildWaitUnavailableMessage(language);
    } else if (waitCommand.action === "show") {
      const heading =
        waitCommand.scope === "global"
          ? "Global collection window"
          : waitCommand.scope === "topic"
            ? "Local collection window"
            : "Collection windows";
      responseText = buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        heading,
        language,
        waitCommand.scope,
      );
    } else if (waitCommand.action === "off") {
      const canceled = promptFragmentAssembler.cancelPendingForMessage(message, {
        scope: waitCommand.scope,
      });
      responseText = buildWaitDisabledMessage(
        canceled,
        waitCommand.scope,
        language,
      );
    } else if (waitCommand.action === "set") {
      promptFragmentAssembler.openWindow({
        message,
        flushDelayMs: waitCommand.delayMs,
        scope: waitCommand.scope,
        flush: buildBufferedPromptFlush({
          api,
          config,
          lifecycleManager,
          promptStartGuard,
          serviceState,
          sessionService,
          workerPool,
        }),
      });
      const heading =
        waitCommand.scope === "global"
          ? "Global collection window enabled."
          : "Local collection window enabled.";
      responseText = buildWaitStateMessage(
        promptFragmentAssembler.getStateForMessage(message),
        heading,
        language,
        waitCommand.scope,
      );
    } else {
      responseText = buildWaitUsageMessage(language);
    }
  } else if (command.name === "suffix") {
    if (suffixCommand.scope === "topic-control") {
      if (suffixCommand.action === "show") {
        responseText = buildTopicPromptSuffixStateMessage(
          session,
          "Topic prompt suffix routing",
          language,
        );
      } else if (suffixCommand.action === "on") {
        handledSession = await sessionService.updatePromptSuffixTopicState(session, {
          enabled: true,
        });
        responseText = buildTopicPromptSuffixStateMessage(
          handledSession,
          "Topic prompt suffix routing enabled.",
          getSessionUiLanguage(handledSession),
        );
      } else if (suffixCommand.action === "off") {
        handledSession = await sessionService.updatePromptSuffixTopicState(session, {
          enabled: false,
        });
        responseText = buildTopicPromptSuffixStateMessage(
          handledSession,
          "Topic prompt suffix routing disabled.",
          getSessionUiLanguage(handledSession),
        );
      } else {
        responseText = buildTopicPromptSuffixUsageMessage(language);
      }
    } else if (suffixCommand.action === "show") {
      responseText = buildPromptSuffixMessage(
        session,
        "Prompt suffix",
        "topic",
        language,
      );
    } else if (suffixCommand.action === "set") {
      const suffixText = normalizePromptSuffixText(suffixCommand.text);
      if (!suffixText) {
        responseText = buildPromptSuffixEmptyMessage("topic", language);
      } else if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
        responseText = buildPromptSuffixTooLongMessage(
          PROMPT_SUFFIX_MAX_CHARS,
          language,
        );
      } else {
        handledSession = await sessionService.updatePromptSuffix(session, {
          text: suffixText,
          enabled: true,
        });
        responseText = buildPromptSuffixMessage(
          handledSession,
          "Prompt suffix updated.",
          "topic",
          getSessionUiLanguage(handledSession),
        );
      }
    } else if (suffixCommand.action === "on") {
      if (!normalizePromptSuffixText(session.prompt_suffix_text)) {
        responseText = buildPromptSuffixEmptyMessage("topic", language);
      } else {
        handledSession = await sessionService.updatePromptSuffix(session, {
          enabled: true,
        });
        responseText = buildPromptSuffixMessage(
          handledSession,
          "Prompt suffix enabled.",
          "topic",
          getSessionUiLanguage(handledSession),
        );
      }
    } else if (suffixCommand.action === "off") {
      handledSession = await sessionService.updatePromptSuffix(session, {
        enabled: false,
      });
      responseText = buildPromptSuffixMessage(
        handledSession,
        "Prompt suffix disabled.",
        "topic",
        getSessionUiLanguage(handledSession),
      );
    } else if (suffixCommand.action === "clear") {
      handledSession = await sessionService.clearPromptSuffix(session);
      responseText = buildPromptSuffixMessage(
        handledSession,
        "Prompt suffix cleared.",
        "topic",
        getSessionUiLanguage(handledSession),
      );
    }
  } else if (scopedRuntimeSettingCommand) {
    const result = await handleScopedRuntimeSettingCommand({
      commandName: command.name,
      parsedCommand: scopedRuntimeSettingCommand,
      session,
      sessionService,
      config,
      language,
    });
    handledSession = result.handledSession ?? handledSession;
    responseText = result.responseText;
  } else {
    return null;
  }

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
    serviceState,
    sessionService,
  });
}
