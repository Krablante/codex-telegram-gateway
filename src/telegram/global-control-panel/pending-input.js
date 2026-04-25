import {
  normalizePromptSuffixText,
  PROMPT_SUFFIX_MAX_CHARS,
} from "../../session-manager/prompt-suffix.js";
import { buildPromptSuffixMessage } from "../command-handlers/topic-commands.js";
import { parseWaitCommandArgs } from "../command-parsing.js";
import { buildHostSelectionStartedMessage } from "../command-handlers/host-commands.js";
import {
  buildGlobalInvalidCustomWaitMessage,
  buildGlobalInvalidSuffixMessage,
  buildGlobalPendingInputCanceledMessage,
  buildGlobalPendingInputNeedsTextMessage,
  buildGlobalPendingInputStartedMessage,
  buildGlobalTooLongSuffixMessage,
  buildGlobalWaitUnavailableMessage,
  getGlobalControlLanguage,
} from "../global-control-panel-view.js";
import { ensureGlobalControlPanelMessage } from "../global-control-panel-lifecycle.js";
import { isGeneralForumMessage } from "./common.js";

function quoteCommandArgument(value) {
  return JSON.stringify(String(value ?? "").trim());
}

function getMessageText(message) {
  return String(message?.text ?? message?.caption ?? "");
}

function hasLeadingCommandText(message) {
  const text = String(message?.text ?? message?.caption ?? "").trim();
  return /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?(?:\s|$)/u.test(text);
}

function hasMediaOrCaption(message) {
  return Boolean(
    message?.caption
    || message?.photo
    || message?.document
    || message?.video
    || message?.audio
    || message?.voice
    || message?.animation
    || message?.sticker,
  );
}

function isPlainTextPendingInputMessage(message) {
  return (
    typeof message?.text === "string"
    && message.text.trim()
    && !hasLeadingCommandText(message)
    && !hasMediaOrCaption(message)
  );
}

function isSameRequestedUser(message, pendingInput) {
  return (
    !pendingInput.requested_by_user_id
    || String(message?.from?.id ?? "") === pendingInput.requested_by_user_id
  );
}

function getReplyToMessageId(message) {
  return Number(message?.reply_to_message?.message_id ?? 0) || null;
}

function isGlobalPendingInputMessage(message, pendingInput, config) {
  if (!isGeneralForumMessage(message, config)) {
    return false;
  }

  const replyToMessageId = getReplyToMessageId(message);
  if (replyToMessageId) {
    return replyToMessageId === pendingInput.menu_message_id;
  }

  return isSameRequestedUser(message, pendingInput)
    && isPlainTextPendingInputMessage(message);
}

function buildNewTopicPendingStatus(extra, language) {
  return extra.single_host_auto_selected
    ? buildGlobalPendingInputStartedMessage("new_topic_title", language)
    : buildHostSelectionStartedMessage({
        hostId: extra.requested_host_id,
        hostLabel: extra.requested_host_label,
      }, language);
}

function withPendingStatus(pendingInput, statusMessage) {
  return {
    ...pendingInput,
    status_message: statusMessage,
  };
}

async function updateGlobalPendingInputMenu({
  activeScreen,
  api,
  config,
  controlState,
  globalControlPanelStore,
  message,
  pendingInput,
  promptFragmentAssembler,
  sessionService,
}) {
  await globalControlPanelStore.patch({
    pending_input: pendingInput,
    active_screen: activeScreen,
    menu_message_id: pendingInput?.menu_message_id ?? controlState.menu_message_id,
  });
  await ensureGlobalControlPanelMessage({
    activeScreen,
    actor: message,
    api,
    config,
    controlState: {
      ...controlState,
      pending_input: pendingInput,
      active_screen: activeScreen,
      menu_message_id: pendingInput?.menu_message_id ?? controlState.menu_message_id,
    },
    globalControlPanelStore,
    preferredMessageId: pendingInput?.menu_message_id ?? controlState.menu_message_id,
    promptFragmentAssembler,
    sessionService,
  });
}

export async function startGlobalControlPendingInput({
  actor,
  api,
  config,
  controlState,
  extra = {},
  globalControlPanelStore,
  kind,
  promptFragmentAssembler,
  requestedByUserId,
  screen = null,
  sessionService,
}) {
  const language = getGlobalControlLanguage(controlState);
  const nextPendingInput = {
    kind,
    requested_at: new Date().toISOString(),
    requested_by_user_id: String(requestedByUserId),
    menu_message_id: actor.message_id,
    screen: screen || (kind === "suffix_text" ? "suffix" : kind === "new_topic_title" ? "new_topic" : "wait"),
    status_message: kind === "new_topic_title"
      ? buildNewTopicPendingStatus(extra, language)
      : buildGlobalPendingInputStartedMessage(kind, language),
    ...extra,
  };
  await globalControlPanelStore.patch({
    pending_input: nextPendingInput,
    menu_message_id: actor.message_id,
    active_screen: nextPendingInput.screen,
  });
  await ensureGlobalControlPanelMessage({
    activeScreen: nextPendingInput.screen,
    actor,
    api,
    config,
    controlState: {
      ...controlState,
      pending_input: nextPendingInput,
      menu_message_id: actor.message_id,
      active_screen: nextPendingInput.screen,
    },
    globalControlPanelStore,
    preferredMessageId: actor.message_id,
    promptFragmentAssembler,
    sessionService,
  });
  return {
    handled: true,
    reason: "global-control-pending-input-started",
  };
}

export async function clearGlobalControlPendingInput({
  actor,
  api,
  config,
  controlState,
  globalControlPanelStore,
  promptFragmentAssembler,
  sessionService,
}) {
  const language = getGlobalControlLanguage(controlState);
  await globalControlPanelStore.patch({
    pending_input: null,
    menu_message_id: actor.message_id,
    active_screen: controlState.active_screen,
    ui_language: language,
    notice: buildGlobalPendingInputCanceledMessage(language),
  });
  await ensureGlobalControlPanelMessage({
    activeScreen: controlState.active_screen,
    actor,
    api,
    config,
    controlState: {
      ...controlState,
      pending_input: null,
      menu_message_id: actor.message_id,
      notice: buildGlobalPendingInputCanceledMessage(language),
    },
    globalControlPanelStore,
    preferredMessageId: actor.message_id,
    promptFragmentAssembler,
    sessionService,
  });
  return {
    handled: true,
    reason: "global-control-pending-input-cleared",
  };
}

export async function maybeHandleGlobalControlReply({
  api,
  config,
  dispatchCommand,
  globalControlPanelStore,
  message,
  promptFragmentAssembler,
  sessionService,
  applyGlobalWaitChange = null,
}) {
  if (!globalControlPanelStore) {
    return { handled: false };
  }

  const controlState = await globalControlPanelStore.load({ force: true });
  const pendingInput = controlState.pending_input;
  const language = getGlobalControlLanguage(controlState);
  if (!pendingInput) {
    return { handled: false };
  }

  if (!isGlobalPendingInputMessage(message, pendingInput, config)) {
    return { handled: false };
  }

  if (!isSameRequestedUser(message, pendingInput)) {
    return {
      handled: true,
      reason: "global-control-pending-input-owner-mismatch",
    };
  }

  const text = getMessageText(message);
  if (!text.trim()) {
    await updateGlobalPendingInputMenu({
      activeScreen: pendingInput.screen || controlState.active_screen,
      api,
      config,
      controlState,
      globalControlPanelStore,
      message,
      pendingInput: withPendingStatus(
        pendingInput,
        buildGlobalPendingInputNeedsTextMessage(language),
      ),
      promptFragmentAssembler,
      sessionService,
    });
    return {
      handled: true,
      reason: "global-control-pending-input-needs-text",
    };
  }

  if (pendingInput.kind === "wait_custom") {
    const parsed = parseWaitCommandArgs(text);
    if (!["set", "off"].includes(parsed.action)) {
      await updateGlobalPendingInputMenu({
        activeScreen: pendingInput.screen || controlState.active_screen,
        api,
        config,
        controlState,
        globalControlPanelStore,
        message,
        pendingInput: withPendingStatus(
          pendingInput,
          buildGlobalInvalidCustomWaitMessage(language),
        ),
        promptFragmentAssembler,
        sessionService,
      });
      return {
        handled: true,
        reason: "global-control-invalid-custom-wait",
      };
    }
  }

  if (pendingInput.kind === "suffix_text") {
    const suffixText = normalizePromptSuffixText(text);
    if (!suffixText) {
      await updateGlobalPendingInputMenu({
        activeScreen: pendingInput.screen || controlState.active_screen,
        api,
        config,
        controlState,
        globalControlPanelStore,
        message,
        pendingInput: withPendingStatus(
          pendingInput,
          buildGlobalInvalidSuffixMessage(language),
        ),
        promptFragmentAssembler,
        sessionService,
      });
      return {
        handled: true,
        reason: "global-control-invalid-suffix",
      };
    }
    if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
      await updateGlobalPendingInputMenu({
        activeScreen: pendingInput.screen || controlState.active_screen,
        api,
        config,
        controlState,
        globalControlPanelStore,
        message,
        pendingInput: withPendingStatus(
          pendingInput,
          buildGlobalTooLongSuffixMessage(language),
        ),
        promptFragmentAssembler,
        sessionService,
      });
      return {
        handled: true,
        reason: "global-control-suffix-too-long",
      };
    }
  }

  if (pendingInput.kind === "new_topic_title" && !text.trim()) {
    await updateGlobalPendingInputMenu({
      activeScreen: pendingInput.screen || controlState.active_screen,
      api,
      config,
      controlState,
      globalControlPanelStore,
      message,
      pendingInput: withPendingStatus(
        pendingInput,
        buildGlobalPendingInputNeedsTextMessage(language),
      ),
      promptFragmentAssembler,
      sessionService,
    });
    return {
      handled: true,
      reason: "global-control-new-topic-needs-title",
    };
  }

  let statusMessage = null;
  if (
    pendingInput.kind === "suffix_text"
    && typeof sessionService?.updateGlobalPromptSuffix === "function"
  ) {
    const updated = await sessionService.updateGlobalPromptSuffix({
      text: normalizePromptSuffixText(text),
      enabled: true,
    });
    statusMessage = buildPromptSuffixMessage(
      updated,
      "Global prompt suffix updated.",
      "global",
      language,
    );
  } else if (pendingInput.kind === "new_topic_title") {
    await dispatchCommand({
      actor: message.from,
      chat: message.chat,
      commandText: `/new host=${pendingInput.requested_host_id} ${quoteCommandArgument(text)}`,
    });
  } else {
    const parsed = parseWaitCommandArgs(text);
    if (typeof applyGlobalWaitChange === "function") {
      const applied = await applyGlobalWaitChange({
        actor: message.from,
        chat: message.chat,
        value: parsed.action === "off" ? "off" : String(parsed.seconds),
      });
      if (!applied?.available) {
        await updateGlobalPendingInputMenu({
          activeScreen: pendingInput.screen || controlState.active_screen,
          api,
          config,
          controlState,
          globalControlPanelStore,
          message,
          pendingInput: withPendingStatus(
            pendingInput,
            buildGlobalWaitUnavailableMessage(language),
          ),
          promptFragmentAssembler,
          sessionService,
        });
        return {
          handled: true,
          reason: "global-control-wait-unavailable",
        };
      }
    } else {
      await dispatchCommand({
        actor: message.from,
        chat: message.chat,
        commandText: `/wait global ${text}`,
      });
    }
  }
  await globalControlPanelStore.patch({
    pending_input: null,
    active_screen: pendingInput.screen || controlState.active_screen,
    menu_message_id: pendingInput.menu_message_id,
    notice: statusMessage,
  });
  await ensureGlobalControlPanelMessage({
    activeScreen: pendingInput.screen || controlState.active_screen,
    actor: message,
    api,
    config,
    controlState: {
      ...controlState,
      pending_input: null,
      active_screen: pendingInput.screen || controlState.active_screen,
      menu_message_id: pendingInput.menu_message_id,
      notice: statusMessage,
    },
    globalControlPanelStore,
    preferredMessageId: pendingInput.menu_message_id,
    promptFragmentAssembler,
    sessionService,
  });
  return {
    handled: true,
    reason: "global-control-pending-input-applied",
  };
}
