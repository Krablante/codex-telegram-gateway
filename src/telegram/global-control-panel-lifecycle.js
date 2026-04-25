import {
  buildGlobalControlPanelPayload,
  buildGlobalMenuRefreshMessage,
  getGlobalControlLanguage,
  loadGlobalControlPanelView,
  normalizeGlobalControlScreenId,
} from "./global-control-panel-view.js";
import {
  isNotModifiedError,
  isRecoverableEditError,
  sendStatusMessage,
  syncPendingInputMessageId,
} from "./global-control-panel-common.js";

export async function ensureGlobalControlPanelMessage({
  activeScreen = "root",
  actor,
  api,
  config,
  controlState = null,
  forceStatusMessage = false,
  globalControlPanelStore,
  preferredMessageId = null,
  promptFragmentAssembler,
  sessionService,
}) {
  const resolvedControlState =
    controlState ?? await globalControlPanelStore.load({ force: true });
  const screen = normalizeGlobalControlScreenId(
    activeScreen ?? resolvedControlState.active_screen,
  );
  const language = getGlobalControlLanguage(resolvedControlState);
  const view = await loadGlobalControlPanelView({
    actor,
    config,
    promptFragmentAssembler,
    sessionService,
    screen,
  });
  const payload = buildGlobalControlPanelPayload({
    language,
    notice: resolvedControlState.notice,
    pendingInput: resolvedControlState.pending_input,
    screen,
    view,
  });
  const chatId = actor?.chat?.id ?? config.telegramForumChatId;
  const messageId = preferredMessageId ?? resolvedControlState.menu_message_id;

  if (messageId) {
    try {
      await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: payload.text,
        reply_markup: payload.reply_markup,
      });
      await globalControlPanelStore.patch({
        menu_message_id: messageId,
        active_screen: screen,
        notice: null,
        pending_input: syncPendingInputMessageId(
          resolvedControlState.pending_input,
          messageId,
        ),
      });
      return {
        created: false,
        messageId,
      };
    } catch (error) {
      if (isNotModifiedError(error)) {
        await globalControlPanelStore.patch({
          menu_message_id: messageId,
          active_screen: screen,
          notice: null,
          pending_input: syncPendingInputMessageId(
            resolvedControlState.pending_input,
            messageId,
          ),
        });
        if (forceStatusMessage) {
          await sendStatusMessage(api, chatId, buildGlobalMenuRefreshMessage(language));
        }
        return {
          created: false,
          messageId,
          unchanged: true,
        };
      }

      if (!isRecoverableEditError(error)) {
        throw error;
      }
    }
  }

  const sent = await api.sendMessage({
    chat_id: chatId,
    text: payload.text,
    reply_markup: payload.reply_markup,
  });
  const nextMessageId =
    Number.isInteger(sent?.message_id) && sent.message_id > 0
      ? sent.message_id
      : null;
  const resolvedMessageId = nextMessageId ?? messageId;
  await globalControlPanelStore.patch({
    menu_message_id: resolvedMessageId,
    active_screen: screen,
    notice: null,
    pending_input: syncPendingInputMessageId(
      resolvedControlState.pending_input,
      resolvedMessageId,
    ),
  });
  return {
    created: true,
    messageId: resolvedMessageId,
  };
}
