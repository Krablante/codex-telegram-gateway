import { getTopicIdFromMessage } from "../session-manager/session-key.js";
import { shouldForwardSessionToOwner } from "../rollout/session-ownership.js";

function getUpdateMessage(update) {
  return update?.callback_query?.message || update?.message || null;
}

async function isGenerationRecordUsable(generationStore, record) {
  if (typeof generationStore?.isGenerationRecordVerifiablyLive === "function") {
    return generationStore.isGenerationRecordVerifiablyLive(record);
  }

  return generationStore?.isGenerationRecordLive?.(record) ?? false;
}

export function extractUpdateSessionSelector(update) {
  const message = getUpdateMessage(update);
  const topicId = getTopicIdFromMessage(message);
  const chatId = message?.chat?.id;
  if (!message || !topicId || chatId === undefined || chatId === null) {
    return null;
  }

  return {
    chatId: String(chatId),
    topicId: String(topicId),
  };
}

export async function resolveSpikeUpdateRoute({
  update,
  generationId,
  generationStore,
  sessionStore,
}) {
  const selector = extractUpdateSessionSelector(update);
  if (!selector) {
    return { type: "local", session: null };
  }

  const session = await sessionStore.load(selector.chatId, selector.topicId);
  if (!session) {
    return { type: "local", session: null };
  }

  if (!shouldForwardSessionToOwner(session, generationId)) {
    return { type: "local", session };
  }

  const ownerGenerationId =
    session?.session_owner_generation_id
    ?? session?.spike_run_owner_generation_id
    ?? null;
  const ownerGeneration = await generationStore.loadGeneration(ownerGenerationId);
  if (
    !await isGenerationRecordUsable(generationStore, ownerGeneration)
    || !ownerGeneration?.ipc_endpoint
  ) {
    return {
      type: "local",
      session,
      staleOwnerGenerationId: ownerGenerationId,
    };
  }

  return {
    type: "forward",
    session,
    ownerGeneration,
  };
}
