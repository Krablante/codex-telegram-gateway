import { DEFAULT_UI_LANGUAGE } from "../i18n/ui-language.js";
import { getTopicIdFromMessage } from "../session-manager/session-key.js";
import { isAuthorizedMessage } from "./command-parsing.js";
import { applyTopicControlActionDirect, getRefreshScreenForAction } from "./topic-control-panel-actions.js";
import {
  answerCallbackQuerySafe,
  buildAuthMessageForCallbackQuery,
  runSerializedTopicControlOperation,
  sendStatusMessage,
} from "./topic-control-panel-common.js";
import {
  clearTopicControlPendingInput,
  maybeHandleTopicControlReply,
  startTopicControlPendingInput,
} from "./topic-control-panel-input.js";
import { ensureTopicControlPanelMessage } from "./topic-control-panel-lifecycle.js";
import {
  buildTopicOnlyMessage,
  parseTopicControlCallbackData,
  TOPIC_CONTROL_PANEL_CALLBACK_PREFIX,
} from "./topic-control-panel-view.js";

export const TOPIC_CONTROL_PANEL_COMMAND = "menu";

export { ensureTopicControlPanelMessage } from "./topic-control-panel-lifecycle.js";
export { maybeHandleTopicControlReply } from "./topic-control-panel-input.js";

export function isTopicControlCallbackQuery(callbackQuery) {
  return String(callbackQuery?.data ?? "").startsWith(
    `${TOPIC_CONTROL_PANEL_CALLBACK_PREFIX}:`,
  );
}

export async function handleTopicControlCommand({
  api,
  config,
  fallbackLanguage = DEFAULT_UI_LANGUAGE,
  message,
  promptFragmentAssembler,
  sessionService,
  topicControlPanelStore,
  workerPool = null,
}) {
  if (!topicControlPanelStore) {
    return { handled: false, reason: "missing-topic-control-store" };
  }

  const topicId = getTopicIdFromMessage(message);
  if (!topicId) {
    await api.sendMessage({
      chat_id: message.chat.id,
      text: buildTopicOnlyMessage(fallbackLanguage),
    });
    return {
      handled: true,
      reason: "topic-only",
    };
  }

  const session = await sessionService.ensureSessionForMessage(message);
  await ensureTopicControlPanelMessage({
    activeScreen: "root",
    actor: message,
    api,
    config,
    promptFragmentAssembler,
    recreateOnUnchanged: true,
    session,
    sessionService,
    topicControlPanelStore,
    workerPool,
    pin: true,
  });
  return {
    handled: true,
    reason: "topic-control-menu-opened",
  };
}

export async function handleTopicControlCallbackQuery({
  applyTopicWaitChange = null,
  api,
  callbackQuery,
  config,
  dispatchCommand,
  promptFragmentAssembler,
  sessionService,
  topicControlPanelStore,
  workerPool = null,
}) {
  if (!isTopicControlCallbackQuery(callbackQuery)) {
    return { handled: false };
  }

  if (!topicControlPanelStore) {
    await answerCallbackQuerySafe(api, callbackQuery.id, "topic control panel is unavailable");
    return {
      handled: true,
      reason: "missing-topic-control-store",
    };
  }

  if (!isAuthorizedMessage(buildAuthMessageForCallbackQuery(callbackQuery), config)) {
    await answerCallbackQuerySafe(api, callbackQuery.id);
    return {
      handled: false,
      reason: "unauthorized",
    };
  }

  const menuMessage = callbackQuery.message;
  if (!getTopicIdFromMessage(menuMessage)) {
    await answerCallbackQuerySafe(api, callbackQuery.id, "Use /menu inside a topic");
    return {
      handled: true,
      reason: "topic-only",
    };
  }

  const session = await sessionService.ensureSessionForMessage(menuMessage);
  const parsed = parseTopicControlCallbackData(callbackQuery.data);
  if (!parsed) {
    await answerCallbackQuerySafe(api, callbackQuery.id);
    return {
      handled: true,
      reason: "invalid-topic-control-callback",
    };
  }

  if (
    (parsed.screen === "omni_model" || parsed.screen === "omni_reasoning")
    && config.omniEnabled === false
  ) {
    await answerCallbackQuerySafe(api, callbackQuery.id, "Omni is disabled");
    return {
      handled: true,
      reason: "omni-disabled",
    };
  }

  await answerCallbackQuerySafe(api, callbackQuery.id);
  return runSerializedTopicControlOperation(session.session_key, async () => {
    const controlState = await topicControlPanelStore.load(session, { force: true });
    const actorMessage = {
      ...menuMessage,
      from: callbackQuery.from,
    };

    if (parsed.kind === "navigate") {
      await ensureTopicControlPanelMessage({
        activeScreen: parsed.screen,
        actor: actorMessage,
        api,
        config,
        controlState,
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        session,
        sessionService,
        topicControlPanelStore,
        workerPool,
      });
      return {
        handled: true,
        reason: "topic-control-menu-navigated",
      };
    }

    if (parsed.kind === "help_show") {
      await dispatchCommand({
        actor: callbackQuery.from,
        chat: {
          ...menuMessage.chat,
          message_thread_id: menuMessage.message_thread_id,
        },
        commandText: "/help",
      });
      return {
        handled: true,
        reason: "topic-control-help-sent",
      };
    }

    if (parsed.kind === "command_dispatch") {
      await dispatchCommand({
        actor: callbackQuery.from,
        chat: {
          ...menuMessage.chat,
          message_thread_id: menuMessage.message_thread_id,
        },
        commandText: `/${parsed.command}`,
      });
      return {
        handled: true,
        reason: "topic-control-command-dispatched",
      };
    }

    if (parsed.kind === "suffix_input" || parsed.kind === "wait_input") {
      return startTopicControlPendingInput({
        actorMessage,
        api,
        config,
        controlState,
        kind: parsed.kind === "suffix_input" ? "suffix_text" : "wait_custom",
        promptFragmentAssembler,
        requestedByUserId: callbackQuery.from.id,
        session,
        sessionService,
        topicControlPanelStore,
        workerPool,
      });
    }

    if (parsed.kind === "pending_clear") {
      return clearTopicControlPendingInput({
        actorMessage,
        api,
        config,
        controlState,
        promptFragmentAssembler,
        session,
        sessionService,
        topicControlPanelStore,
        workerPool,
      });
    }

    const directAction = await applyTopicControlActionDirect({
      action: parsed,
      config,
      language: session.ui_language ?? DEFAULT_UI_LANGUAGE,
      message: actorMessage,
      session,
      sessionService,
      applyTopicWaitChange,
    });
    if (directAction.handled) {
      const nextSession = directAction.session || session;
      const refreshScreen = getRefreshScreenForAction(parsed);
      await topicControlPanelStore.patch(nextSession, {
        menu_message_id: menuMessage.message_id,
        active_screen: refreshScreen,
        pending_input: controlState.pending_input,
      });
      await ensureTopicControlPanelMessage({
        activeScreen: refreshScreen,
        actor: actorMessage,
        api,
        config,
        controlState: {
          ...controlState,
          menu_message_id: menuMessage.message_id,
          active_screen: refreshScreen,
        },
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        session: nextSession,
        sessionService,
        topicControlPanelStore,
        workerPool,
      });
      if (directAction.statusMessage) {
        await sendStatusMessage(api, nextSession, directAction.statusMessage);
      }
      return {
        handled: true,
        reason: "topic-control-action-applied",
      };
    }

    return {
      handled: true,
      reason: "unsupported-topic-control-action",
    };
  });
}
