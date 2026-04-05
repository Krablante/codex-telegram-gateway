import {
  normalizePromptSuffixText,
  PROMPT_SUFFIX_MAX_CHARS,
} from "../session-manager/prompt-suffix.js";
import { parseWaitCommandArgs } from "./command-parsing.js";
import {
  buildGlobalInvalidCustomWaitMessage,
  buildGlobalInvalidSuffixMessage,
  buildGlobalPendingInputCanceledMessage,
  buildGlobalPendingInputNeedsTextMessage,
  buildGlobalPendingInputStartedMessage,
  buildGlobalPendingInputUnauthorizedMessage,
  buildGlobalTooLongSuffixMessage,
  getGlobalControlLanguage,
} from "./global-control-panel-view.js";
import { sendStatusMessage } from "./global-control-panel-common.js";
import { ensureGlobalControlPanelMessage } from "./global-control-panel-lifecycle.js";

export async function startGlobalControlPendingInput({
  actor,
  api,
  config,
  controlState,
  globalControlPanelStore,
  kind,
  promptFragmentAssembler,
  requestedByUserId,
  sessionService,
}) {
  const language = getGlobalControlLanguage(controlState);
  const nextPendingInput = {
    kind,
    requested_at: new Date().toISOString(),
    requested_by_user_id: String(requestedByUserId),
    menu_message_id: actor.message_id,
    screen: kind === "suffix_text" ? "suffix" : "wait",
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
  await sendStatusMessage(
    api,
    actor.chat.id,
    buildGlobalPendingInputStartedMessage(nextPendingInput.kind, language),
  );
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
    },
    globalControlPanelStore,
    preferredMessageId: actor.message_id,
    promptFragmentAssembler,
    sessionService,
  });
  await sendStatusMessage(
    api,
    actor.chat.id,
    buildGlobalPendingInputCanceledMessage(language),
  );
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

  const replyToMessageId = Number(message?.reply_to_message?.message_id ?? 0);
  if (!replyToMessageId || replyToMessageId !== pendingInput.menu_message_id) {
    return { handled: false };
  }

  if (
    pendingInput.requested_by_user_id
    && String(message.from?.id ?? "") !== pendingInput.requested_by_user_id
  ) {
    await sendStatusMessage(
      api,
      message.chat.id,
      buildGlobalPendingInputUnauthorizedMessage(language),
    );
    return {
      handled: true,
      reason: "global-control-pending-input-owner-mismatch",
    };
  }

  const text = String(message.text ?? message.caption ?? "");
  if (!text.trim()) {
    await sendStatusMessage(
      api,
      message.chat.id,
      buildGlobalPendingInputNeedsTextMessage(language),
    );
    return {
      handled: true,
      reason: "global-control-pending-input-needs-text",
    };
  }

  if (pendingInput.kind === "wait_custom") {
    const parsed = parseWaitCommandArgs(text);
    if (!["set", "off"].includes(parsed.action)) {
      await sendStatusMessage(
        api,
        message.chat.id,
        buildGlobalInvalidCustomWaitMessage(language),
      );
      return {
        handled: true,
        reason: "global-control-invalid-custom-wait",
      };
    }
  }

  if (pendingInput.kind === "suffix_text") {
    const suffixText = normalizePromptSuffixText(text);
    if (!suffixText) {
      await sendStatusMessage(api, message.chat.id, buildGlobalInvalidSuffixMessage(language));
      return {
        handled: true,
        reason: "global-control-invalid-suffix",
      };
    }
    if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
      await sendStatusMessage(api, message.chat.id, buildGlobalTooLongSuffixMessage(language));
      return {
        handled: true,
        reason: "global-control-suffix-too-long",
      };
    }
  }

  const commandText =
    pendingInput.kind === "suffix_text"
      ? `/suffix global ${text}`
      : `/wait global ${text}`;
  await dispatchCommand({
    actor: message.from,
    chat: message.chat,
    commandText,
  });
  await globalControlPanelStore.patch({
    pending_input: null,
    active_screen: pendingInput.screen || controlState.active_screen,
    menu_message_id: pendingInput.menu_message_id,
  });
  await ensureGlobalControlPanelMessage({
    activeScreen: pendingInput.screen || controlState.active_screen,
    actor: message,
    api,
    config,
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
