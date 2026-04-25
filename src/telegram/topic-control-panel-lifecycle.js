import { getSessionUiLanguage } from "../i18n/ui-language.js";
import {
  buildMenuRefreshMessage,
  buildTopicControlPanelPayload,
  loadTopicControlPanelView,
  normalizeTopicControlScreenId,
} from "./topic-control-panel-view.js";
import {
  deleteTopicControlMessagesBestEffort,
  isNotModifiedError,
  isRecoverableEditError,
  pinTopicControlPanelMessageSafe,
  sendStatusMessage,
  syncPendingInputMessageId,
} from "./topic-control-panel-common.js";

export async function ensureTopicControlPanelMessage({
  activeScreen = "root",
  actor,
  api,
  config,
  controlState = null,
  forceRecreate = false,
  forceStatusMessage = false,
  lifecycleManager = null,
  recreateOnUnchanged = false,
  preferredMessageId = null,
  promptFragmentAssembler,
  session,
  sessionService,
  topicControlPanelStore,
  workerPool = null,
  pin = false,
}) {
  const resolvedControlState =
    controlState ?? await topicControlPanelStore.load(session, { force: true });
  const screen = normalizeTopicControlScreenId(
    activeScreen ?? resolvedControlState.active_screen,
  );
  const language = getSessionUiLanguage(session);
  const view = await loadTopicControlPanelView({
    config,
    message: actor,
    promptFragmentAssembler,
    session,
    sessionService,
    screen,
    workerPool,
  });
  const resolvedSession = view.session ?? session;
  const payload = buildTopicControlPanelPayload({
    language,
    notice: resolvedControlState.notice,
    pendingInput: resolvedControlState.pending_input,
    screen,
    session: resolvedSession,
    view,
  });
  const messageId = preferredMessageId ?? resolvedControlState.menu_message_id;
  const handlePanelTransportError = async (error, fallbackMessageId = messageId) => {
    const lifecycleResult = await lifecycleManager?.handleTransportError(
      resolvedSession,
      error,
    );
    if (!lifecycleResult?.handled) {
      return null;
    }

    return {
      created: false,
      messageId: fallbackMessageId ?? null,
      parked: lifecycleResult.parked === true,
      session: lifecycleResult.session || resolvedSession,
    };
  };

  if (messageId && !forceRecreate) {
    try {
      await api.editMessageText({
        chat_id: resolvedSession.chat_id,
        message_id: messageId,
        text: payload.text,
        reply_markup: payload.reply_markup,
      });
      await topicControlPanelStore.patch(resolvedSession, {
        menu_message_id: messageId,
        active_screen: screen,
        notice: null,
        pending_input: syncPendingInputMessageId(
          resolvedControlState.pending_input,
          messageId,
        ),
      });
      if (pin) {
        await pinTopicControlPanelMessageSafe(api, resolvedSession, messageId);
      }
      return {
        created: false,
        messageId,
      };
    } catch (error) {
      if (isNotModifiedError(error)) {
        if (recreateOnUnchanged) {
          // Explicit /menu should always surface a visible panel near the latest messages.
          // Recreate the panel instead of silently treating an unchanged edit as success.
          // Continue below into the sendMessage path.
        } else {
          await topicControlPanelStore.patch(resolvedSession, {
            menu_message_id: messageId,
            active_screen: screen,
            notice: null,
            pending_input: syncPendingInputMessageId(
              resolvedControlState.pending_input,
              messageId,
            ),
          });
          if (pin) {
            await pinTopicControlPanelMessageSafe(api, resolvedSession, messageId);
          }
          if (forceStatusMessage) {
            await sendStatusMessage(
              api,
              resolvedSession,
              buildMenuRefreshMessage(language),
              lifecycleManager,
            );
          }
          return {
            created: false,
            messageId,
            unchanged: true,
          };
        }
      } else if (!isRecoverableEditError(error)) {
        const lifecycleResult = await handlePanelTransportError(error, messageId);
        if (lifecycleResult) {
          return lifecycleResult;
        }
        throw error;
      }
    }
  }

  let sent;
  try {
    sent = await api.sendMessage({
      chat_id: resolvedSession.chat_id,
      message_thread_id: Number(resolvedSession.topic_id),
      text: payload.text,
      reply_markup: payload.reply_markup,
    });
  } catch (error) {
    const lifecycleResult = await handlePanelTransportError(error, messageId);
    if (lifecycleResult) {
      return lifecycleResult;
    }
    throw error;
  }
  const nextMessageId =
    Number.isInteger(sent?.message_id) && sent.message_id > 0
      ? sent.message_id
      : null;
  const resolvedMessageId = nextMessageId ?? messageId;
  await topicControlPanelStore.patch(resolvedSession, {
    menu_message_id: resolvedMessageId,
    active_screen: screen,
    notice: null,
    pending_input: syncPendingInputMessageId(
      resolvedControlState.pending_input,
      resolvedMessageId,
    ),
  });
  if (resolvedMessageId !== messageId) {
    await deleteTopicControlMessagesBestEffort(api, resolvedSession.chat_id, [
      messageId,
    ]);
  }
  if (pin || resolvedMessageId !== messageId) {
    await pinTopicControlPanelMessageSafe(api, resolvedSession, resolvedMessageId);
  }
  return {
    created: true,
    messageId: resolvedMessageId,
  };
}
