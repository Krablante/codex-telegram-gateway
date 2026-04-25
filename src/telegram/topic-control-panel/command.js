import { DEFAULT_UI_LANGUAGE } from "../../i18n/ui-language.js";
import { getTopicIdFromMessage } from "../../session-manager/session-key.js";
import { ensureTopicControlPanelMessage } from "../topic-control-panel-lifecycle.js";
import { buildTopicOnlyMessage } from "../topic-control-panel-view.js";

export async function handleTopicControlCommand({
  api,
  config,
  fallbackLanguage = DEFAULT_UI_LANGUAGE,
  lifecycleManager = null,
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
    forceRecreate: true,
    lifecycleManager,
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
