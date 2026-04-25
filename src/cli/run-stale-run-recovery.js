import fs from "node:fs/promises";

import { readLatestContextSnapshot } from "../session-manager/context-snapshot.js";
import { clearSessionOwnershipPatch } from "../rollout/session-ownership.js";
import { summarizeCodexExecEvent } from "../codex-exec/telegram-exec-runner.js";
import {
  extractRolloutTaskStartedTurnId,
  readRolloutDelta,
  summarizeRolloutLine,
} from "../pty-worker/codex-runner-recovery.js";

export const STALE_RUN_RECOVERY_TEXT =
  "Recovered a stale running session at startup after its owner generation was no longer live.";

function normalizeStoredText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeBackend(value) {
  return String(value || "").trim().toLowerCase();
}

function isLegacyAppServerBackend(value) {
  const backend = normalizeBackend(value);
  return backend === "app-server" || backend === "appserver";
}

function isLegacyAppServerSession(session, { codexGatewayBackend = "exec-json" } = {}) {
  if (!isLegacyAppServerBackend(codexGatewayBackend)) {
    return false;
  }

  const backend = normalizeBackend(
    session?.codex_backend || session?.last_run_backend,
  );
  return isLegacyAppServerBackend(backend);
}

function stripLegacySnapshotFields(snapshot) {
  if (!snapshot) {
    return null;
  }

  return {
    ...snapshot,
    session_id: null,
    rollout_path: null,
  };
}

function resolveStoredThreadId(session, { legacyAppServer = true } = {}) {
  return normalizeStoredText(
    session?.codex_thread_id
      ?? (legacyAppServer
        ? (
            session?.last_context_snapshot?.thread_id
            ?? session?.last_context_snapshot?.threadId
          )
        : null),
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
  legacyAppServer = false,
  session,
  sessionStore = null,
}) {
  const threadId = resolveStoredThreadId(session, { legacyAppServer });
  let providerSessionId = resolveStoredProviderSessionId(session);
  let rolloutPath = resolveStoredRolloutPath(session);
  let latestSnapshot = null;

  if (legacyAppServer && (threadId || providerSessionId) && codexSessionsRoot) {
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

  if (!legacyAppServer) {
    const execJsonOutcome = await inspectExecJsonRunLog({
      session,
      sessionStore,
      fallbackThreadId: threadId,
    });
    if (threadId && codexSessionsRoot) {
      const resolved = await readLatestContextSnapshot({
        threadId,
        providerSessionId: null,
        sessionsRoot: codexSessionsRoot,
        knownRolloutPath: null,
      });
      latestSnapshot = stripLegacySnapshotFields(resolved.snapshot);
    }

    return {
      finalReplyText: execJsonOutcome.finalReplyText,
      hasFinalAnswer: execJsonOutcome.hasFinalAnswer,
      latestSnapshot,
      providerSessionId: null,
      rolloutPath: null,
      threadId: execJsonOutcome.threadId || threadId,
    };
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

  let delta;
  try {
    delta = await readRolloutDelta({
      filePath: rolloutPath,
      offset: 0,
      carryover: Buffer.alloc(0),
      flushTailAtEof: true,
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
  let currentTurnId = null;
  for (const line of delta.lines) {
    const taskStarted = extractRolloutTaskStartedTurnId(line.text);
    if (taskStarted.seen) {
      hasFinalAnswer = false;
      finalReplyText = null;
      currentTurnId = taskStarted.turnId || currentTurnId;
      continue;
    }

    const summary = summarizeRolloutLine(line.text, {
      primaryThreadId: threadId,
      activeTurnId: currentTurnId,
    });
    if (
      summary?.eventType === "rollout.task_complete"
      && currentTurnId
      && summary.turnId
      && summary.turnId !== currentTurnId
    ) {
      continue;
    }
    if (
      summary?.messagePhase !== "final_answer"
      && summary?.eventType !== "rollout.task_complete"
    ) {
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

async function inspectExecJsonRunLog({
  fallbackThreadId = null,
  session,
  sessionStore,
}) {
  if (!sessionStore || typeof sessionStore.getExecJsonRunLogPath !== "function") {
    return {
      finalReplyText: null,
      hasFinalAnswer: false,
      threadId: fallbackThreadId,
    };
  }

  let text;
  try {
    text = await fs.readFile(
      sessionStore.getExecJsonRunLogPath(session.chat_id, session.topic_id),
      "utf8",
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return {
      finalReplyText: null,
      hasFinalAnswer: false,
      threadId: fallbackThreadId,
    };
  }

  let threadId = fallbackThreadId;
  let latestAgentMessageText = null;
  let finalReplyText = null;
  let hasFinalAnswer = false;
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const summary = summarizeCodexExecEvent(event);
    if (summary?.threadId) {
      threadId = summary.threadId;
    }
    if (
      summary?.kind === "agent_message"
      && summary.eventType === "item.completed"
      && summary.progressSource === "agent_message"
      && normalizeStoredText(summary.text)
    ) {
      latestAgentMessageText = summary.text;
    }
    if (summary?.eventType === "turn.started") {
      latestAgentMessageText = null;
      finalReplyText = null;
      hasFinalAnswer = false;
    }
    if (summary?.eventType === "turn.completed") {
      const normalized = normalizeStoredText(latestAgentMessageText);
      if (normalized) {
        finalReplyText = normalized;
        hasFinalAnswer = true;
      }
    }
    if (summary?.eventType === "turn.failed") {
      finalReplyText = null;
      hasFinalAnswer = false;
    }
  }

  return {
    finalReplyText,
    hasFinalAnswer,
    threadId,
  };
}

export async function recoverStaleRunningSessions({
  codexGatewayBackend = "exec-json",
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
    const legacyAppServer = isLegacyAppServerSession(session, {
      codexGatewayBackend,
    });
    const inspection = await inspectRecoveredRunOutcome({
      codexSessionsRoot,
      legacyAppServer,
      session,
      sessionStore,
    });
    const recoveredFinalReply = normalizeStoredText(inspection.finalReplyText);
    const hasRecoverableContinuity = legacyAppServer
      ? Boolean(
          inspection.providerSessionId
            || inspection.latestSnapshot?.session_id
            || session.provider_session_id
            || inspection.threadId
            || inspection.rolloutPath
            || inspection.latestSnapshot
            || session.last_context_snapshot,
        )
      : Boolean(inspection.threadId);
    const recoveryStatus = inspection.hasFinalAnswer
      ? "completed"
      : hasRecoverableContinuity
        ? "interrupted"
        : "failed";
    const backendContinuityPatch = legacyAppServer
      ? {
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
        }
      : {
          codex_backend: normalizeBackend(codexGatewayBackend) || "exec-json",
          last_run_backend: normalizeBackend(codexGatewayBackend) || "exec-json",
          provider_session_id: null,
          codex_thread_id: inspection.threadId ?? null,
          codex_thread_model:
            inspection.threadId
              ? session.codex_thread_model ?? session.last_run_model ?? null
              : null,
          codex_thread_reasoning_effort:
            inspection.threadId
              ? (
                  session.codex_thread_reasoning_effort
                  ?? session.last_run_reasoning_effort
                  ?? null
                )
              : null,
          codex_rollout_path: null,
          last_context_snapshot: inspection.latestSnapshot ?? null,
          last_token_usage:
            inspection.latestSnapshot?.last_token_usage
            ?? session.last_token_usage
            ?? null,
        };
    let staleRunAlreadyHandled = false;
    const updated = await sessionStore.patchWithCurrent(session, async (current) => {
      if (
        !current
        || current.lifecycle_state === "purged"
        || current.last_run_status !== "running"
        || await isOwnerGenerationLive(
          generationStore,
          normalizeOwnerGenerationId(current),
        )
      ) {
        staleRunAlreadyHandled = true;
        return null;
      }

      return {
        ...clearSessionOwnershipPatch(),
        ...backendContinuityPatch,
        last_run_finished_at: finishedAt,
        last_run_status: recoveryStatus,
        last_agent_reply:
          recoveryStatus === "completed"
            ? recoveredFinalReply ?? null
            : !hasRecoverableContinuity
              ? recoveryText
              : null,
      };
    });
    if (staleRunAlreadyHandled) {
      continue;
    }
    const finalized = await persistRecoveredRunArtifacts({
      appendExchangeLog: inspection.hasFinalAnswer || !hasRecoverableContinuity,
      assistantReply: inspection.hasFinalAnswer
        ? recoveredFinalReply
        : recoveryText,
      finalReplyText: inspection.hasFinalAnswer
        ? recoveredFinalReply
        : hasRecoverableContinuity
          ? null
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
