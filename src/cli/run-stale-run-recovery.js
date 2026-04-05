import { clearSessionOwnershipPatch } from "../rollout/session-ownership.js";

export const STALE_RUN_RECOVERY_TEXT =
  "Recovered a stale running session at startup after its owner generation was no longer live.";

function normalizeOwnerGenerationId(session) {
  const normalized = String(
    session?.session_owner_generation_id
      ?? session?.spike_run_owner_generation_id
      ?? "",
  ).trim();
  return normalized || null;
}

async function isOwnerGenerationLive(generationStore, generationId) {
  if (
    !generationId
    || !generationStore
    || typeof generationStore.loadGeneration !== "function"
    || typeof generationStore.isGenerationRecordVerifiablyLive !== "function"
  ) {
    return false;
  }

  const record = await generationStore.loadGeneration(generationId);
  if (!record) {
    return false;
  }

  return generationStore.isGenerationRecordVerifiablyLive(record);
}

export async function recoverStaleRunningSessions({
  generationStore,
  now = () => new Date().toISOString(),
  sessionStore,
} = {}) {
  if (!sessionStore || typeof sessionStore.listSessions !== "function") {
    return [];
  }

  const sessions = await sessionStore.listSessions();
  const recovered = [];

  for (const session of sessions) {
    if (!session || session.lifecycle_state === "purged") {
      continue;
    }
    if (session.last_run_status !== "running") {
      continue;
    }

    const ownerGenerationId = normalizeOwnerGenerationId(session);
    if (await isOwnerGenerationLive(generationStore, ownerGenerationId)) {
      continue;
    }

    const finishedAt = now();
    const updated = await sessionStore.patch(session, {
      ...clearSessionOwnershipPatch(),
      last_agent_reply:
        String(session.last_agent_reply ?? "").trim() || STALE_RUN_RECOVERY_TEXT,
      last_run_finished_at: finishedAt,
      last_run_status: "failed",
    });
    recovered.push(updated);
  }

  return recovered;
}
