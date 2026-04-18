import { readLatestContextSnapshot } from "../session-manager/context-snapshot.js";
import { clearSessionOwnershipPatch } from "../rollout/session-ownership.js";
import {
  readRolloutDelta,
  summarizeRolloutLine,
} from "../pty-worker/codex-runner-recovery.js";

export const STALE_RUN_RECOVERY_TEXT =
  "Recovered a stale running session at startup after its owner generation was no longer live.";

function normalizeStoredText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function resolveStoredThreadId(session) {
  return normalizeStoredText(
    session?.codex_thread_id
      ?? session?.last_context_snapshot?.thread_id
      ?? session?.last_context_snapshot?.threadId,
  );
}

function resolveStoredProviderSessionId(session) {
  return normalizeStoredText(
    session?.provider_session_id
      ?? session?.last_context_snapshot?.session_id
      ?? session?.last_context_snapshot?.sessionId,
  );
}

function resolveStoredRolloutPath(session) {
  return normalizeStoredText(
    session?.codex_rollout_path
      ?? session?.last_context_snapshot?.rollout_path
      ?? session?.last_context_snapshot?.rolloutPath,
  );
}

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
  appendExchangeLog = true,
  finishedAt,
  recoveryText,
  assistantReply = recoveryText,
  finalReplyText = assistantReply,
  session,
  sessionStore,
  spikeFinalEventStore,
  status = "failed",
  userPrompt = null,
}) {
  let currentSession = session;

  if (appendExchangeLog && sessionStore?.appendExchangeLogEntry) {
    const exchangeLogResult = await sessionStore.appendExchangeLogEntry(
      currentSession,
      {
        assistant_reply: assistantReply,
        created_at: finishedAt,
        status,
        user_prompt: userPrompt,
      },
    );
    currentSession = exchangeLogResult?.session || currentSession;
  }

  if (spikeFinalEventStore?.write) {
    await spikeFinalEventStore.write(currentSession, {
      exchange_log_entries: currentSession.exchange_log_entries ?? 0,
      status,
      finished_at: finishedAt,
      final_reply_text: finalReplyText,
      telegram_message_ids: [],
      reply_to_message_id: null,
      thread_id: currentSession.codex_thread_id ?? null,
    });
  }

  return currentSession;
}

async function inspectRecoveredRunOutcome({
  codexSessionsRoot = null,
  session,
}) {
  const threadId = resolveStoredThreadId(session);
  let providerSessionId = resolveStoredProviderSessionId(session);
  let rolloutPath = resolveStoredRolloutPath(session);
  let latestSnapshot = null;

  if ((threadId || providerSessionId) && codexSessionsRoot) {
    const resolved = await readLatestContextSnapshot({
      threadId,
      providerSessionId,
      sessionsRoot: codexSessionsRoot,
      knownRolloutPath: rolloutPath,
    });
    rolloutPath = resolved.rolloutPath || rolloutPath;
    latestSnapshot = resolved.snapshot || null;
    providerSessionId = normalizeStoredText(
      resolved.snapshot?.session_id ?? providerSessionId,
    );
  }

  if (!rolloutPath) {
    return {
      finalReplyText: null,
      hasFinalAnswer: false,
      latestSnapshot,
      providerSessionId,
      rolloutPath: null,
      threadId,
    };
  }

  let delta = null;
  try {
    delta = await readRolloutDelta({
      filePath: rolloutPath,
      offset: 0,
      carryover: Buffer.alloc(0),
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        finalReplyText: null,
        hasFinalAnswer: false,
        latestSnapshot,
        providerSessionId,
        rolloutPath,
        threadId,
      };
    }
    throw error;
  }

  let finalReplyText = null;
  let hasFinalAnswer = false;
  for (const line of delta.lines) {
    const summary = summarizeRolloutLine(line.text, {
      primaryThreadId: threadId,
    });
    if (summary?.messagePhase !== "final_answer") {
      continue;
    }
    hasFinalAnswer = true;
    if (normalizeStoredText(summary.text)) {
      finalReplyText = summary.text;
    }
  }

  return {
    finalReplyText,
    hasFinalAnswer,
    latestSnapshot,
    providerSessionId,
    rolloutPath,
    threadId,
  };
}

export async function recoverStaleRunningSessions({
  codexSessionsRoot = null,
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
    const inspection = await inspectRecoveredRunOutcome({
      codexSessionsRoot,
      session,
    });
    const recoveredFinalReply =
      normalizeStoredText(inspection.finalReplyText)
      || normalizeStoredText(session.last_agent_reply);
    const hasRecoverableContinuity = Boolean(
      inspection.providerSessionId
        || inspection.latestSnapshot?.session_id
        || session.provider_session_id
        ||
      inspection.threadId
        || inspection.rolloutPath
        || inspection.latestSnapshot
        || session.last_context_snapshot,
    );
    const recoveryStatus = inspection.hasFinalAnswer
      ? "completed"
      : hasRecoverableContinuity
        ? "interrupted"
        : "failed";
    const updated = await sessionStore.patch(session, {
      ...clearSessionOwnershipPatch(),
      last_run_finished_at: finishedAt,
      last_run_status: recoveryStatus,
      ...(inspection.rolloutPath && inspection.rolloutPath !== session.codex_rollout_path
        ? { codex_rollout_path: inspection.rolloutPath }
        : {}),
      ...(inspection.providerSessionId && inspection.providerSessionId !== session.provider_session_id
        ? {
            runtime_provider: "codex",
            provider_session_id: inspection.providerSessionId,
          }
        : {}),
      ...(inspection.latestSnapshot
        ? {
            last_context_snapshot: inspection.latestSnapshot,
            last_token_usage:
              inspection.latestSnapshot.last_token_usage
              ?? session.last_token_usage
              ?? null,
          }
        : {}),
      ...(recoveryStatus === "completed"
        ? {
            last_agent_reply: recoveredFinalReply,
          }
        : !hasRecoverableContinuity
        ? {
            last_agent_reply:
              recoveredFinalReply || recoveryText,
          }
        : {}),
    });
    const finalized = await persistRecoveredRunArtifacts({
      appendExchangeLog: inspection.hasFinalAnswer || !hasRecoverableContinuity,
      assistantReply: inspection.hasFinalAnswer
        ? recoveredFinalReply
        : recoveryText,
      finalReplyText: inspection.hasFinalAnswer
        ? recoveredFinalReply
        : hasRecoverableContinuity
          ? normalizeStoredText(updated.last_agent_reply)
        : recoveryText,
      finishedAt,
      recoveryText,
      session: updated,
      sessionStore,
      spikeFinalEventStore,
      status: recoveryStatus,
      userPrompt: normalizeStoredText(updated.last_user_prompt),
    });
    recovered.push(finalized);
  }

  return recovered;
}
