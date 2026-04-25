import { DEFAULT_UI_LANGUAGE } from "../../i18n/ui-language.js";
import { getTopicIdFromMessage } from "../../session-manager/session-key.js";
import { isAuthorizedMessage } from "../command-parsing.js";
import {
  applyTopicControlActionDirect,
  getRefreshScreenForAction,
} from "../topic-control-panel-actions.js";
import {
  answerCallbackQuerySafe,
  buildAuthMessageForCallbackQuery,
  runSerializedTopicControlOperation,
} from "../topic-control-panel-common.js";
import { ensureTopicControlPanelMessage } from "../topic-control-panel-lifecycle.js";
import { parseTopicControlCallbackData } from "../topic-control-panel-view.js";
import {
  clearTopicControlPendingInput,
  startTopicControlPendingInput,
} from "./pending-input.js";
import { buildExpiredTopicMenuMessage } from "./common.js";

export async function handleTopicControlCallbackQuery({
  applyTopicWaitChange = null,
  api,
  callbackQuery,
  config,
  dispatchCommand,
  lifecycleManager = null,
  promptFragmentAssembler,
  sessionService,
  topicControlPanelStore,
  workerPool = null,
}) {
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

  return runSerializedTopicControlOperation(session.session_key, async () => {
    const controlState = await topicControlPanelStore.load(session, { force: true });
    const trackedMenuMessageId = Number(controlState.menu_message_id ?? 0) || null;
    if (!trackedMenuMessageId || trackedMenuMessageId !== menuMessage.message_id) {
      await answerCallbackQuerySafe(
        api,
        callbackQuery.id,
        buildExpiredTopicMenuMessage(session.ui_language),
      );
      return {
        handled: true,
        reason: "topic-control-menu-expired",
      };
    }

    await answerCallbackQuerySafe(api, callbackQuery.id);
    const actorMessage = {
      ...menuMessage,
      from: callbackQuery.from,
    };

    if (parsed.kind === "navigate") {
      const panelResult = await ensureTopicControlPanelMessage({
        activeScreen: parsed.screen,
        actor: actorMessage,
        api,
        config,
        controlState,
        preferredMessageId: menuMessage.message_id,
        lifecycleManager,
        promptFragmentAssembler,
        session,
        sessionService,
        topicControlPanelStore,
        workerPool,
      });
      if (panelResult?.parked) {
        return {
          handled: true,
          reason: "topic-control-topic-unavailable",
        };
      }
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
        lifecycleManager,
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
        lifecycleManager,
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
        notice: directAction.statusMessage ?? null,
      });
      const panelResult = await ensureTopicControlPanelMessage({
        activeScreen: refreshScreen,
        actor: actorMessage,
        api,
        config,
        controlState: {
          ...controlState,
          menu_message_id: menuMessage.message_id,
          active_screen: refreshScreen,
          notice: directAction.statusMessage ?? null,
        },
        preferredMessageId: menuMessage.message_id,
        lifecycleManager,
        promptFragmentAssembler,
        session: nextSession,
        sessionService,
        topicControlPanelStore,
        workerPool,
      });
      if (panelResult?.parked) {
        return {
          handled: true,
          reason: "topic-control-topic-unavailable",
        };
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
