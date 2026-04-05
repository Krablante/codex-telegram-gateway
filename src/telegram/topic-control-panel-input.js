import { getSessionUiLanguage } from "../i18n/ui-language.js";
import {
  normalizePromptSuffixText,
  PROMPT_SUFFIX_MAX_CHARS,
} from "../session-manager/prompt-suffix.js";
import { getTopicIdFromMessage } from "../session-manager/session-key.js";
import { parseWaitCommandArgs } from "./command-parsing.js";
import {
  buildInvalidCustomWaitMessage,
  buildInvalidSuffixMessage,
  buildPendingInputCanceledMessage,
  buildPendingInputNeedsTextMessage,
  buildPendingInputStartedMessage,
  buildPendingInputUnauthorizedMessage,
  buildTooLongSuffixMessage,
  buildWaitUnavailableMessage,
} from "./topic-control-panel-view.js";
import {
  sendStatusMessage,
} from "./topic-control-panel-common.js";
import { ensureTopicControlPanelMessage } from "./topic-control-panel-lifecycle.js";

export async function startTopicControlPendingInput({
  actorMessage,
  api,
  config,
  controlState,
  kind,
  promptFragmentAssembler,
  requestedByUserId,
  session,
  sessionService,
  topicControlPanelStore,
  workerPool = null,
}) {
  const language = getSessionUiLanguage(session);
  const nextPendingInput = {
    kind,
    requested_at: new Date().toISOString(),
    requested_by_user_id: String(requestedByUserId),
    menu_message_id: actorMessage.message_id,
    screen: kind === "suffix_text" ? "suffix" : "wait",
  };
  await topicControlPanelStore.patch(session, {
    pending_input: nextPendingInput,
    menu_message_id: actorMessage.message_id,
    active_screen: nextPendingInput.screen,
  });
  await ensureTopicControlPanelMessage({
    activeScreen: nextPendingInput.screen,
    actor: actorMessage,
    api,
    config,
    controlState: {
      ...controlState,
      pending_input: nextPendingInput,
      menu_message_id: actorMessage.message_id,
      active_screen: nextPendingInput.screen,
    },
    preferredMessageId: actorMessage.message_id,
    promptFragmentAssembler,
    session,
    sessionService,
    topicControlPanelStore,
    workerPool,
  });
  await sendStatusMessage(
    api,
    session,
    buildPendingInputStartedMessage(nextPendingInput.kind, language),
  );
  return {
    handled: true,
    reason: "topic-control-pending-input-started",
  };
}

export async function clearTopicControlPendingInput({
  actorMessage,
  api,
  config,
  controlState,
  promptFragmentAssembler,
  session,
  sessionService,
  topicControlPanelStore,
  workerPool = null,
}) {
  const language = getSessionUiLanguage(session);
  await topicControlPanelStore.patch(session, {
    pending_input: null,
    menu_message_id: actorMessage.message_id,
    active_screen: controlState.active_screen,
  });
  await ensureTopicControlPanelMessage({
    activeScreen: controlState.active_screen,
    actor: actorMessage,
    api,
    config,
    controlState: {
      ...controlState,
      pending_input: null,
      menu_message_id: actorMessage.message_id,
    },
    preferredMessageId: actorMessage.message_id,
    promptFragmentAssembler,
    session,
    sessionService,
    topicControlPanelStore,
    workerPool,
  });
  await sendStatusMessage(
    api,
    session,
    buildPendingInputCanceledMessage(language),
  );
  return {
    handled: true,
    reason: "topic-control-pending-input-cleared",
  };
}

export async function maybeHandleTopicControlReply({
  api,
  config,
  message,
  promptFragmentAssembler,
  sessionService,
  topicControlPanelStore,
  applyTopicWaitChange = null,
  workerPool = null,
}) {
  if (!topicControlPanelStore || !getTopicIdFromMessage(message)) {
    return { handled: false };
  }

  const session = await sessionService.ensureSessionForMessage(message);
  const controlState = await topicControlPanelStore.load(session, { force: true });
  const pendingInput = controlState.pending_input;
  const language = getSessionUiLanguage(session);
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
      session,
      buildPendingInputUnauthorizedMessage(language),
    );
    return {
      handled: true,
      reason: "topic-control-pending-input-owner-mismatch",
    };
  }

  const text = String(message.text ?? message.caption ?? "");
  if (!text.trim()) {
    await sendStatusMessage(
      api,
      session,
      buildPendingInputNeedsTextMessage(language),
    );
    return {
      handled: true,
      reason: "topic-control-pending-input-needs-text",
    };
  }

  let nextSession = session;
  if (pendingInput.kind === "wait_custom") {
    const parsed = parseWaitCommandArgs(text);
    if (
      !["set", "off"].includes(parsed.action)
      || parsed.scope !== "topic"
      || typeof applyTopicWaitChange !== "function"
    ) {
      await sendStatusMessage(
        api,
        session,
        buildInvalidCustomWaitMessage(language),
      );
      return {
        handled: true,
        reason: "topic-control-invalid-custom-wait",
      };
    }

    const applied = await applyTopicWaitChange({
      message,
      value: parsed.action === "off" ? "off" : String(parsed.seconds),
    });
    if (!applied?.available) {
      await sendStatusMessage(api, session, buildWaitUnavailableMessage(language));
      return {
        handled: true,
        reason: "topic-control-wait-unavailable",
      };
    }
  }

  if (pendingInput.kind === "suffix_text") {
    const suffixText = normalizePromptSuffixText(text);
    if (!suffixText) {
      await sendStatusMessage(api, session, buildInvalidSuffixMessage(language));
      return {
        handled: true,
        reason: "topic-control-invalid-suffix",
      };
    }
    if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
      await sendStatusMessage(api, session, buildTooLongSuffixMessage(language));
      return {
        handled: true,
        reason: "topic-control-suffix-too-long",
      };
    }

    nextSession = await sessionService.updatePromptSuffix(session, {
      text: suffixText,
      enabled: true,
    });
  }

  await topicControlPanelStore.patch(nextSession, {
    pending_input: null,
    active_screen: pendingInput.screen || controlState.active_screen,
    menu_message_id: pendingInput.menu_message_id,
  });
  await ensureTopicControlPanelMessage({
    activeScreen: pendingInput.screen || controlState.active_screen,
    actor: message,
    api,
    config,
    preferredMessageId: pendingInput.menu_message_id,
    promptFragmentAssembler,
    session: nextSession,
    sessionService,
    topicControlPanelStore,
    workerPool,
  });
  return {
    handled: true,
    reason: "topic-control-pending-input-applied",
  };
}
