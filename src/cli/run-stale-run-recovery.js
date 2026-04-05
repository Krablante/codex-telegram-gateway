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

async function persistRecoveredRunArtifacts({
  finishedAt,
  recoveryText,
  session,
  sessionStore,
  spikeFinalEventStore,
}) {
  let currentSession = session;

  if (sessionStore?.appendExchangeLogEntry) {
    const exchangeLogResult = await sessionStore.appendExchangeLogEntry(
      currentSession,
      {
        assistant_reply: recoveryText,
        created_at: finishedAt,
        status: "failed",
      },
    );
    currentSession = exchangeLogResult?.session || currentSession;
  }

  if (spikeFinalEventStore?.write) {
    await spikeFinalEventStore.write(currentSession, {
      exchange_log_entries: currentSession.exchange_log_entries ?? 0,
      status: "failed",
      finished_at: finishedAt,
      final_reply_text: recoveryText,
      telegram_message_ids: [],
      reply_to_message_id: null,
      thread_id: null,
    });
  }

  return currentSession;
}

export async function recoverStaleRunningSessions({
  generationStore,
  now = () => new Date().toISOString(),
  sessionStore,
  spikeFinalEventStore = null,
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
    const recoveryText = STALE_RUN_RECOVERY_TEXT;
    const updated = await sessionStore.patch(session, {
      ...clearSessionOwnershipPatch(),
      codex_thread_id: null,
      codex_rollout_path: null,
      last_context_snapshot: null,
      last_agent_reply:
        String(session.last_agent_reply ?? "").trim() || recoveryText,
      last_run_finished_at: finishedAt,
      last_run_status: "failed",
    });
    const finalized = await persistRecoveredRunArtifacts({
      finishedAt,
      recoveryText,
      session: updated,
      sessionStore,
      spikeFinalEventStore,
    });
    recovered.push(finalized);
  }

  return recovered;
}
