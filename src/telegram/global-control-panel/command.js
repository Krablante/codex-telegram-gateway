import { sendStatusMessage } from "../global-control-panel-common.js";
import { ensureGlobalControlPanelMessage } from "../global-control-panel-lifecycle.js";
import {
  buildGeneralOnlyMessage,
  loadGlobalControlLanguage,
} from "../global-control-panel-view.js";
import { isGeneralForumMessage } from "./common.js";

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
