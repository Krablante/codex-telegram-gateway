import {
  DEFAULT_UI_LANGUAGE,
} from "../i18n/ui-language.js";
import { isAuthorizedMessage } from "./command-parsing.js";
import {
  applyGlobalControlActionDirect,
  buildDispatchCommandText,
  getRefreshScreenForAction,
} from "./global-control-panel-actions.js";
import {
  answerCallbackQuerySafe,
  buildAuthMessageForCallbackQuery,
  runSerializedGlobalControlOperation,
  sendStatusMessage,
} from "./global-control-panel-common.js";
import {
  clearGlobalControlPendingInput,
  maybeHandleGlobalControlReply,
  startGlobalControlPendingInput,
} from "./global-control-panel-input.js";
import { ensureGlobalControlPanelMessage } from "./global-control-panel-lifecycle.js";
import {
  buildGeneralOnlyMessage,
  buildGlobalLanguageUpdatedMessage,
  getGlobalControlLanguage,
  GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX,
  loadGlobalControlLanguage,
  parseGlobalControlCallbackData,
} from "./global-control-panel-view.js";

export const GLOBAL_CONTROL_PANEL_COMMAND = "global";

export { ensureGlobalControlPanelMessage } from "./global-control-panel-lifecycle.js";
export { maybeHandleGlobalControlReply } from "./global-control-panel-input.js";

function isGeneralThreadId(value) {
  return value === undefined || value === 0 || value === "0";
}

export function isGeneralForumMessage(message, config) {
  return (
    message
    && String(message.chat?.id ?? "") === String(config.telegramForumChatId ?? "")
    && isGeneralThreadId(message.message_thread_id)
  );
}

export function isGlobalControlCallbackQuery(callbackQuery) {
  return String(callbackQuery?.data ?? "").startsWith(
    `${GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX}:`,
  );
}

export async function handleGlobalControlCommand({
  activeScreen = "root",
  api,
  config,
  dispatchCommand,
  globalControlPanelStore,
  message,
  promptFragmentAssembler,
  sessionService,
}) {
  if (!globalControlPanelStore) {
    return { handled: false, reason: "missing-global-control-store" };
  }

  const language = await loadGlobalControlLanguage(globalControlPanelStore);
  if (!isGeneralForumMessage(message, config)) {
    await sendStatusMessage(api, message.chat.id, buildGeneralOnlyMessage(language));
    return {
      handled: true,
      reason: "general-only",
    };
  }

  await ensureGlobalControlPanelMessage({
    activeScreen,
    actor: message,
    api,
    config,
    forceStatusMessage: false,
    globalControlPanelStore,
    promptFragmentAssembler,
    sessionService,
  });
  void dispatchCommand;
  return {
    handled: true,
    reason: "global-control-menu-opened",
  };
}

export async function handleGlobalControlCallbackQuery({
  applyGlobalWaitChange = null,
  api,
  callbackQuery,
  config,
  dispatchCommand,
  globalControlPanelStore,
  promptFragmentAssembler,
  sessionService,
}) {
  if (!isGlobalControlCallbackQuery(callbackQuery)) {
    return { handled: false };
  }

  if (!globalControlPanelStore) {
    await answerCallbackQuerySafe(
      api,
      callbackQuery.id,
      "global control panel is unavailable",
    );
    return {
      handled: true,
      reason: "missing-global-control-store",
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
  if (!isGeneralForumMessage(menuMessage, config)) {
    await answerCallbackQuerySafe(
      api,
      callbackQuery.id,
      buildGeneralOnlyMessage(await loadGlobalControlLanguage(globalControlPanelStore)),
    );
    return {
      handled: true,
      reason: "general-only",
    };
  }

  const parsed = parseGlobalControlCallbackData(callbackQuery.data);
  if (!parsed) {
    await answerCallbackQuerySafe(api, callbackQuery.id);
    return {
      handled: true,
      reason: "invalid-global-control-callback",
    };
  }

  const actor = {
    chat: menuMessage.chat,
    from: callbackQuery.from,
  };

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
  return runSerializedGlobalControlOperation(String(menuMessage.chat?.id ?? "global"), async () => {
    const controlState = await globalControlPanelStore.load({ force: true });
    const language = getGlobalControlLanguage(controlState);

    if (parsed.kind === "navigate") {
      await ensureGlobalControlPanelMessage({
        activeScreen: parsed.screen,
        actor,
        api,
        config,
        controlState,
        globalControlPanelStore,
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        sessionService,
      });
      return {
        handled: true,
        reason: "global-control-menu-navigated",
      };
    }

    if (parsed.kind === "language_set") {
      await globalControlPanelStore.patch({
        ui_language: parsed.value,
        menu_message_id: menuMessage.message_id,
        active_screen: "root",
        pending_input: controlState.pending_input,
      });
      await ensureGlobalControlPanelMessage({
        activeScreen: "root",
        actor,
        api,
        config,
        controlState: {
          ...controlState,
          ui_language: parsed.value,
          menu_message_id: menuMessage.message_id,
          active_screen: "root",
        },
        globalControlPanelStore,
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        sessionService,
      });
      await sendStatusMessage(
        api,
        menuMessage.chat.id,
        buildGlobalLanguageUpdatedMessage(parsed.value),
      );
      return {
        handled: true,
        reason: "global-control-language-updated",
      };
    }

    if (parsed.kind === "help_show") {
      await dispatchCommand({
        actor: callbackQuery.from,
        chat: menuMessage.chat,
        commandText: "/help",
      });
      return {
        handled: true,
        reason: "global-control-help-sent",
      };
    }

    if (parsed.kind === "guide_show") {
      await dispatchCommand({
        actor: callbackQuery.from,
        chat: menuMessage.chat,
        commandText: "/guide",
      });
      return {
        handled: true,
        reason: "global-control-guide-sent",
      };
    }

    if (parsed.kind === "suffix_input" || parsed.kind === "wait_input") {
      return startGlobalControlPendingInput({
        actor: {
          ...actor,
          message_id: menuMessage.message_id,
        },
        api,
        config,
        controlState,
        globalControlPanelStore,
        kind: parsed.kind === "suffix_input" ? "suffix_text" : "wait_custom",
        promptFragmentAssembler,
        requestedByUserId: callbackQuery.from.id,
        sessionService,
      });
    }

    if (parsed.kind === "pending_clear") {
      return clearGlobalControlPendingInput({
        actor: {
          ...actor,
          message_id: menuMessage.message_id,
        },
        api,
        config,
        controlState,
        globalControlPanelStore,
        promptFragmentAssembler,
        sessionService,
      });
    }

    const directAction = await applyGlobalControlActionDirect({
      action: parsed,
      actor: callbackQuery.from,
      chat: menuMessage.chat,
      config,
      language,
      applyGlobalWaitChange,
      sessionService,
    });
    if (directAction.handled) {
      const refreshScreen = getRefreshScreenForAction(parsed);
      await globalControlPanelStore.patch({
        menu_message_id: menuMessage.message_id,
        active_screen: refreshScreen,
        ui_language: language,
        pending_input: controlState.pending_input,
      });
      await ensureGlobalControlPanelMessage({
        activeScreen: refreshScreen,
        actor,
        api,
        config,
        controlState: {
          ...controlState,
          menu_message_id: menuMessage.message_id,
          active_screen: refreshScreen,
        },
        globalControlPanelStore,
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        sessionService,
      });
      if (directAction.statusMessage) {
        await sendStatusMessage(api, menuMessage.chat.id, directAction.statusMessage);
      }
      return {
        handled: true,
        reason: "global-control-action-applied",
      };
    }

    const commandText = buildDispatchCommandText(parsed);
    if (!commandText) {
      return {
        handled: true,
        reason: "unsupported-global-control-action",
      };
    }

    await dispatchCommand({
      actor: callbackQuery.from,
      chat: menuMessage.chat,
      commandText,
    });
    const refreshedControlState = await globalControlPanelStore.load({ force: true });
    const refreshScreen = getRefreshScreenForAction(parsed);
    await globalControlPanelStore.patch({
      menu_message_id: menuMessage.message_id,
      active_screen: refreshScreen,
      ui_language: language,
      pending_input: refreshedControlState.pending_input,
    });
    await ensureGlobalControlPanelMessage({
      activeScreen: refreshScreen,
      actor,
      api,
      config,
      controlState: {
        ...refreshedControlState,
        menu_message_id: menuMessage.message_id,
        active_screen: refreshScreen,
        ui_language: language,
      },
      globalControlPanelStore,
      preferredMessageId: menuMessage.message_id,
      promptFragmentAssembler,
      sessionService,
    });
    return {
      handled: true,
      reason: "global-control-action-applied",
    };
  });
}
