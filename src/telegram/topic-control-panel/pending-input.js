import { getSessionUiLanguage } from "../../i18n/ui-language.js";
import {
  normalizePromptSuffixText,
  PROMPT_SUFFIX_MAX_CHARS,
} from "../../session-manager/prompt-suffix.js";
import { getTopicIdFromMessage } from "../../session-manager/session-key.js";
import { parseWaitCommandArgs } from "../command-parsing.js";
import {
  buildInvalidCustomWaitMessage,
  buildInvalidSuffixMessage,
  buildPendingInputCanceledMessage,
  buildPendingInputNeedsTextMessage,
  buildPendingInputStartedMessage,
  buildTooLongSuffixMessage,
  buildWaitUnavailableMessage,
} from "../topic-control-panel-view.js";
import { ensureTopicControlPanelMessage } from "../topic-control-panel-lifecycle.js";

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

function isTopicPendingInputMessage(message, pendingInput) {
  const replyToMessageId = getReplyToMessageId(message);
  if (replyToMessageId) {
    return replyToMessageId === pendingInput.menu_message_id;
  }

  return isSameRequestedUser(message, pendingInput)
    && isPlainTextPendingInputMessage(message);
}

function withPendingStatus(pendingInput, statusMessage) {
  return {
    ...pendingInput,
    status_message: statusMessage,
  };
}

async function updateTopicPendingInputMenu({
  activeScreen,
  api,
  config,
  controlState,
  lifecycleManager,
  message,
  pendingInput,
  promptFragmentAssembler,
  session,
  sessionService,
  topicControlPanelStore,
  workerPool,
}) {
  await topicControlPanelStore.patch(session, {
    pending_input: pendingInput,
    active_screen: activeScreen,
    menu_message_id: pendingInput?.menu_message_id ?? controlState.menu_message_id,
  });
  await ensureTopicControlPanelMessage({
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
    preferredMessageId: pendingInput?.menu_message_id ?? controlState.menu_message_id,
    lifecycleManager,
    promptFragmentAssembler,
    session,
    sessionService,
    topicControlPanelStore,
    workerPool,
  });
}

export async function startTopicControlPendingInput({
  actorMessage,
  api,
  config,
  controlState,
  kind,
  lifecycleManager = null,
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
    status_message: buildPendingInputStartedMessage(kind, language),
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
    lifecycleManager,
    promptFragmentAssembler,
    session,
    sessionService,
    topicControlPanelStore,
    workerPool,
  });
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
  lifecycleManager = null,
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
    notice: buildPendingInputCanceledMessage(language),
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
      notice: buildPendingInputCanceledMessage(language),
    },
    preferredMessageId: actorMessage.message_id,
    lifecycleManager,
    promptFragmentAssembler,
    session,
    sessionService,
    topicControlPanelStore,
    workerPool,
  });
  return {
    handled: true,
    reason: "topic-control-pending-input-cleared",
  };
}

export async function maybeHandleTopicControlReply({
  api,
  config,
  message,
  lifecycleManager = null,
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

  if (!isTopicPendingInputMessage(message, pendingInput)) {
    return { handled: false };
  }

  if (!isSameRequestedUser(message, pendingInput)) {
    return {
      handled: true,
      reason: "topic-control-pending-input-owner-mismatch",
    };
  }

  const text = getMessageText(message);
  if (!text.trim()) {
    await updateTopicPendingInputMenu({
      activeScreen: pendingInput.screen || controlState.active_screen,
      api,
      config,
      controlState,
      lifecycleManager,
      message,
      pendingInput: withPendingStatus(
        pendingInput,
        buildPendingInputNeedsTextMessage(language),
      ),
      promptFragmentAssembler,
      session,
      sessionService,
      topicControlPanelStore,
      workerPool,
    });
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
      await updateTopicPendingInputMenu({
        activeScreen: pendingInput.screen || controlState.active_screen,
        api,
        config,
        controlState,
        lifecycleManager,
        message,
        pendingInput: withPendingStatus(
          pendingInput,
          buildInvalidCustomWaitMessage(language),
        ),
        promptFragmentAssembler,
        session,
        sessionService,
        topicControlPanelStore,
        workerPool,
      });
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
      await updateTopicPendingInputMenu({
        activeScreen: pendingInput.screen || controlState.active_screen,
        api,
        config,
        controlState,
        lifecycleManager,
        message,
        pendingInput: withPendingStatus(
          pendingInput,
          buildWaitUnavailableMessage(language),
        ),
        promptFragmentAssembler,
        session,
        sessionService,
        topicControlPanelStore,
        workerPool,
      });
      return {
        handled: true,
        reason: "topic-control-wait-unavailable",
      };
    }
  }

  if (pendingInput.kind === "suffix_text") {
    const suffixText = normalizePromptSuffixText(text);
    if (!suffixText) {
      await updateTopicPendingInputMenu({
        activeScreen: pendingInput.screen || controlState.active_screen,
        api,
        config,
        controlState,
        lifecycleManager,
        message,
        pendingInput: withPendingStatus(
          pendingInput,
          buildInvalidSuffixMessage(language),
        ),
        promptFragmentAssembler,
        session,
        sessionService,
        topicControlPanelStore,
        workerPool,
      });
      return {
        handled: true,
        reason: "topic-control-invalid-suffix",
      };
    }
    if (suffixText.length > PROMPT_SUFFIX_MAX_CHARS) {
      await updateTopicPendingInputMenu({
        activeScreen: pendingInput.screen || controlState.active_screen,
        api,
        config,
        controlState,
        lifecycleManager,
        message,
        pendingInput: withPendingStatus(
          pendingInput,
          buildTooLongSuffixMessage(language),
        ),
        promptFragmentAssembler,
        session,
        sessionService,
        topicControlPanelStore,
        workerPool,
      });
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
    controlState: {
      ...controlState,
      pending_input: null,
      active_screen: pendingInput.screen || controlState.active_screen,
      menu_message_id: pendingInput.menu_message_id,
    },
    lifecycleManager,
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
