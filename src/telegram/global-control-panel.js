import { GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX } from "./global-control-panel-view.js";
import {
  handleGlobalControlCommand as handleGlobalControlCommandImpl,
} from "./global-control-panel/command.js";
import {
  handleGlobalControlCallbackQuery as handleGlobalControlCallbackQueryImpl,
} from "./global-control-panel/callback.js";
import {
  isGlobalControlCallbackQuery as isGlobalControlCallbackQueryBase,
} from "./global-control-panel/common.js";

export const GLOBAL_CONTROL_PANEL_COMMAND = "global";
export { GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX };

export { maybeHandleGlobalControlReply } from "./global-control-panel-input.js";
export { handleGlobalControlCommandImpl as handleGlobalControlCommand };
export { isGeneralForumMessage } from "./global-control-panel/common.js";

export function isGlobalControlCallbackQuery(callbackQuery) {
  return isGlobalControlCallbackQueryBase(
    callbackQuery,
    GLOBAL_CONTROL_PANEL_CALLBACK_PREFIX,
  );
}

export async function handleGlobalControlCallbackQuery(args) {
  if (!isGlobalControlCallbackQuery(args?.callbackQuery)) {
    return { handled: false };
  }

  return handleGlobalControlCallbackQueryImpl(args);
}
