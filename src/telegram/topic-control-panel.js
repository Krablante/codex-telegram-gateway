import { TOPIC_CONTROL_PANEL_CALLBACK_PREFIX } from "./topic-control-panel-view.js";
import {
  handleTopicControlCommand as handleTopicControlCommandImpl,
} from "./topic-control-panel/command.js";
import {
  handleTopicControlCallbackQuery as handleTopicControlCallbackQueryImpl,
} from "./topic-control-panel/callback.js";
import {
  isTopicControlCallbackQuery as isTopicControlCallbackQueryBase,
} from "./topic-control-panel/common.js";

export const TOPIC_CONTROL_PANEL_COMMAND = "menu";
export { TOPIC_CONTROL_PANEL_CALLBACK_PREFIX };

export { ensureTopicControlPanelMessage } from "./topic-control-panel-lifecycle.js";
export { maybeHandleTopicControlReply } from "./topic-control-panel-input.js";
export { handleTopicControlCommandImpl as handleTopicControlCommand };

export function isTopicControlCallbackQuery(callbackQuery) {
  return isTopicControlCallbackQueryBase(
    callbackQuery,
    TOPIC_CONTROL_PANEL_CALLBACK_PREFIX,
  );
}

export async function handleTopicControlCallbackQuery(args) {
  if (!isTopicControlCallbackQuery(args?.callbackQuery)) {
    return { handled: false };
  }

  return handleTopicControlCallbackQueryImpl(args);
}
