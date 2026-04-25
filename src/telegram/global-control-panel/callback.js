import {
  applyGlobalControlActionDirect,
  buildDispatchCommandText,
  getRefreshScreenForAction,
} from "../global-control-panel-actions.js";
import {
  answerCallbackQuerySafe,
  buildAuthMessageForCallbackQuery,
  runSerializedGlobalControlOperation,
} from "../global-control-panel-common.js";
import { buildNewTopicHostUnavailableMessage } from "../command-handlers/topic-commands.js";
import { ensureGlobalControlPanelMessage } from "../global-control-panel-lifecycle.js";
import {
  buildGeneralOnlyMessage,
  buildGlobalLanguageUpdatedMessage,
  getGlobalControlLanguage,
  loadGlobalControlLanguage,
  parseGlobalControlCallbackData,
} from "../global-control-panel-view.js";
import { isAuthorizedMessage } from "../command-parsing.js";
import {
  clearGlobalControlPendingInput,
  startGlobalControlPendingInput,
} from "./pending-input.js";
import {
  buildExpiredGlobalMenuMessage,
  isGeneralForumMessage,
} from "./common.js";

async function listTopicCreationHosts(sessionService) {
  return typeof sessionService?.listTopicCreationHosts === "function"
    ? await sessionService.listTopicCreationHosts()
    : [];
}

function getSoleConfiguredTopicHost(hostStatuses) {
  return hostStatuses.length === 1 ? hostStatuses[0] : null;
}

async function maybeStartSingleHostNewTopicInput({
  actor,
  api,
  config,
  controlState,
  globalControlPanelStore,
  language,
  menuMessage,
  promptFragmentAssembler,
  requestedByUserId,
  sessionService,
}) {
  const hostStatuses = await listTopicCreationHosts(sessionService);
  const selectedHost = getSoleConfiguredTopicHost(hostStatuses);
  if (!selectedHost) {
    return null;
  }

  if (!selectedHost.ok) {
    const notice = buildNewTopicHostUnavailableMessage(selectedHost, language);
    await globalControlPanelStore.patch({
      menu_message_id: menuMessage.message_id,
      active_screen: "root",
      pending_input: null,
      notice,
    });
    await ensureGlobalControlPanelMessage({
      activeScreen: "root",
      actor,
      api,
      config,
      controlState: {
        ...controlState,
        menu_message_id: menuMessage.message_id,
        active_screen: "root",
        pending_input: null,
        notice,
      },
      globalControlPanelStore,
      preferredMessageId: menuMessage.message_id,
      promptFragmentAssembler,
      sessionService,
    });
    return {
      handled: true,
      reason: "global-control-single-host-unavailable",
    };
  }

  return startGlobalControlPendingInput({
    actor: {
      ...actor,
      message_id: menuMessage.message_id,
    },
    api,
    config,
    controlState,
    extra: {
      requested_host_id: selectedHost.hostId,
      requested_host_label: selectedHost.hostLabel,
      single_host_auto_selected: true,
    },
    globalControlPanelStore,
    kind: "new_topic_title",
    promptFragmentAssembler,
    requestedByUserId,
    screen: "root",
    sessionService,
  });
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

  return runSerializedGlobalControlOperation(String(menuMessage.chat?.id ?? "global"), async () => {
    const controlState = await globalControlPanelStore.load({ force: true });
    const language = getGlobalControlLanguage(controlState);
    const trackedMenuMessageId = Number(controlState.menu_message_id ?? 0) || null;
    if (!trackedMenuMessageId || trackedMenuMessageId !== menuMessage.message_id) {
      await answerCallbackQuerySafe(
        api,
        callbackQuery.id,
        buildExpiredGlobalMenuMessage(language, getGlobalControlLanguage),
      );
      return {
        handled: true,
        reason: "global-control-menu-expired",
      };
    }

    await answerCallbackQuerySafe(api, callbackQuery.id);

    if (parsed.kind === "navigate") {
      if (parsed.screen === "new_topic") {
        const singleHostResult = await maybeStartSingleHostNewTopicInput({
          actor,
          api,
          config,
          controlState,
          globalControlPanelStore,
          language,
          menuMessage,
          promptFragmentAssembler,
          requestedByUserId: callbackQuery.from.id,
          sessionService,
        });
        if (singleHostResult) {
          return singleHostResult;
        }
      }

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
      const notice = buildGlobalLanguageUpdatedMessage(parsed.value);
      await globalControlPanelStore.patch({
        ui_language: parsed.value,
        menu_message_id: menuMessage.message_id,
        active_screen: "root",
        pending_input: controlState.pending_input,
        notice,
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
          notice,
        },
        globalControlPanelStore,
        preferredMessageId: menuMessage.message_id,
        promptFragmentAssembler,
        sessionService,
      });
      return {
        handled: true,
        reason: "global-control-language-updated",
      };
    }

    const menuCommandTextByKind = {
      help_show: "/help",
      guide_show: "/guide",
      zoo_show: "/zoo",
      clear_run: "/clear",
    };
    const menuCommandReasonByKind = {
      help_show: "global-control-help-sent",
      guide_show: "global-control-guide-sent",
      zoo_show: "global-control-zoo-opened",
      clear_run: "global-control-clear-run",
    };

    if (menuCommandTextByKind[parsed.kind]) {
      await dispatchCommand({
        actor: callbackQuery.from,
        chat: menuMessage.chat,
        commandText: menuCommandTextByKind[parsed.kind],
      });
      return {
        handled: true,
        reason: menuCommandReasonByKind[parsed.kind],
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

    if (parsed.kind === "new_topic_host_select") {
      const hostStatuses = await listTopicCreationHosts(sessionService);
      const selectedHost = hostStatuses.find((host) => host.hostId === parsed.hostId);
      if (!selectedHost?.ok) {
        const notice = buildNewTopicHostUnavailableMessage(selectedHost || {
            hostId: parsed.hostId,
            hostLabel: parsed.hostId,
          }, language);
        await globalControlPanelStore.patch({
          menu_message_id: menuMessage.message_id,
          active_screen: "new_topic",
          pending_input: controlState.pending_input,
          notice,
        });
        await ensureGlobalControlPanelMessage({
          activeScreen: "new_topic",
          actor,
          api,
          config,
          controlState: {
            ...controlState,
            menu_message_id: menuMessage.message_id,
            active_screen: "new_topic",
            notice,
          },
          globalControlPanelStore,
          preferredMessageId: menuMessage.message_id,
          promptFragmentAssembler,
          sessionService,
        });
        return {
          handled: true,
          reason: "global-control-host-unavailable",
        };
      }

      return startGlobalControlPendingInput({
        actor: {
          ...actor,
          message_id: menuMessage.message_id,
        },
        api,
        config,
        controlState,
        extra: {
          requested_host_id: selectedHost.hostId,
          requested_host_label: selectedHost.hostLabel,
        },
        globalControlPanelStore,
        kind: "new_topic_title",
        promptFragmentAssembler,
        requestedByUserId: callbackQuery.from.id,
        screen: "new_topic",
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
        notice: directAction.statusMessage ?? null,
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
          notice: directAction.statusMessage ?? null,
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
