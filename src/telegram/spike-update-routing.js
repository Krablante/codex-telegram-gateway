import { getTopicIdFromMessage } from "../session-manager/session-key.js";
import {
  clearSessionOwnershipPatch,
  isOwnedSessionForwardTargetLive,
  shouldForwardSessionToOwner,
} from "../rollout/session-ownership.js";

function getUpdateMessage(update) {
  return update?.callback_query?.message || update?.message || null;
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
  const ownerGenerationIsLive = await isOwnedSessionForwardTargetLive(
    session,
    generationStore,
  );
  const ownerGeneration = ownerGenerationIsLive
    ? await generationStore.loadGeneration(ownerGenerationId)
    : null;
  if (!ownerGenerationIsLive || !ownerGeneration?.ipc_endpoint) {
    const clearedSession = typeof sessionStore.patch === "function"
      ? await sessionStore.patch(session, {
          ...clearSessionOwnershipPatch(),
          spike_run_owner_generation_id: null,
        })
      : session;
    return {
      type: "local",
      session: clearedSession,
      staleOwnerGenerationId: ownerGenerationId,
    };
  }

  return {
    type: "forward",
    session,
    ownerGeneration,
  };
}
