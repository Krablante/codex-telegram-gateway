import { getSessionUiLanguage, normalizeUiLanguage } from "../i18n/ui-language.js";
import { parseOmniDecision } from "./decision.js";
import {
  buildAutoBlockedMessage,
  buildAutoContinuationDispatchMessage,
  buildAutoDoneMessage,
  buildAutoFailedMessage,
  buildAutoSleepingMessage,
  buildOmniEvaluationPrompt,
  buildOmniFallbackNextPrompt,
  buildOmniOperatorQueryPrompt,
  buildOmniStructuredNextPrompt,
} from "./prompting.js";
import { isAutoModeEnabled, normalizeAutoModeState } from "../session-manager/auto-mode.js";
import {
  buildOmniQueryAcceptedMessage,
  buildOmniQueryBusyMessage,
  buildOmniQueryFailureMessage,
  resolveSessionRepoRoot,
} from "./coordinator-common.js";

function extractExactReplyToken(goalText) {
  const text = String(goalText || "").trim();
  if (!text) {
    return null;
  }

  const match =
    text.match(/reply contains exactly\s+(.+?)(?:[.]|$)/iu)
    || text.match(/reply with exactly\s+(.+?)(?:[.]|$)/iu);
  if (!match) {
    return null;
  }

  const token = String(match[1] || "")
    .trim()
    .replace(/^["'`]+|["'`]+$/gu, "")
    .trim();
  return token || null;
}

function resolveExactReplyGoalToken(autoMode) {
  return (
    extractExactReplyToken(autoMode?.normalized_goal_interpretation)
    || extractExactReplyToken(autoMode?.literal_goal_text)
  );
}

function finalReplySatisfiesExactGoal(autoMode, spikeFinalEvent, session) {
  const token = resolveExactReplyGoalToken(autoMode);
  if (!token) {
    return null;
  }

  const finalReply = String(
    spikeFinalEvent?.final_reply_text || session?.last_agent_reply || "",
  ).trim();
  if (finalReply !== token) {
    return null;
  }

  return token;
}

export async function answerOmniQuery(
  coordinator,
  {
    autoMode,
    language,
    message,
    operatorQuestion,
    session,
  },
) {
  const normalizedQuestion = String(operatorQuestion || "").trim()
    || (normalizeUiLanguage(language) === "eng"
      ? "Describe what the latest Spike turn achieved, what remains, and what Omni plans next."
      : "Опиши, чего достиг последний ход Spike, что осталось и какой следующий шаг планирует Omni.");

  const sessionKey = session.session_key;
  if (coordinator.activeOperatorQueries.has(sessionKey)) {
    const delivery = await coordinator.sendReplyMessage(
      message,
      buildOmniQueryBusyMessage(language),
      { session },
    );
    if (delivery?.parked) {
      return { handled: true, reason: "topic-unavailable" };
    }
    return { handled: true, reason: "omni-query-busy" };
  }

  coordinator.activeOperatorQueries.add(sessionKey);
  try {
    const acceptedDelivery = await coordinator.sendReplyMessage(
      message,
      buildOmniQueryAcceptedMessage(language),
      { session },
    );
    if (acceptedDelivery?.parked) {
      return { handled: true, reason: "topic-unavailable" };
    }
    const runtimeProfile = await coordinator.sessionService.resolveCodexRuntimeProfile(
      session,
      { target: "omni" },
    );
    const omniMemory = await coordinator.loadOmniMemory(session);
    const queryPrompt = buildOmniOperatorQueryPrompt({
      autoMode,
      exchangeEntry: {
        user_prompt: session.last_user_prompt,
        assistant_reply: session.last_agent_reply,
      },
      omniMemory,
      operatorQuestion: normalizedQuestion,
      session,
    });
    const run = coordinator.startExecRun({
      codexBinPath: coordinator.config.codexBinPath,
      repoRoot: resolveSessionRepoRoot(session, coordinator.config.repoRoot),
      outputDir: coordinator.omniRunsRoot,
      outputPrefix: "query",
      prompt: queryPrompt,
      model: runtimeProfile.model,
      reasoningEffort: runtimeProfile.reasoningEffort,
    });
    const result = await run.done;
    if (!result.ok) {
      await coordinator.sendReplyMessage(
        message,
        buildOmniQueryFailureMessage(
          result.stderr || result.stdout || "Omni query failed",
          language,
        ),
        { session },
      );
      return { handled: true, reason: "omni-query-failed" };
    }

    await coordinator.sendReplyMessage(
      message,
      String(result.finalReply || "").trim()
        || buildOmniQueryFailureMessage("Empty Omni query reply", language),
      { session },
    );
    return { handled: true, reason: "omni-query-answered" };
  } finally {
    coordinator.activeOperatorQueries.delete(sessionKey);
  }
}

export async function evaluateSession(coordinator, session, { force = false } = {}) {
  const sessionKey = session.session_key;
  if (coordinator.activeEvaluations.has(sessionKey)) {
    return { handled: false, reason: "evaluation-already-running" };
  }

  coordinator.activeEvaluations.add(sessionKey);
  try {
    const current =
      (await coordinator.sessionStore.load(session.chat_id, session.topic_id)) || session;
    const autoMode = normalizeAutoModeState(current.auto_mode);
    const spikeFinalEvent = await coordinator.spikeFinalEventStore.load(current);

    if (!autoMode.enabled) {
      return { handled: false, reason: "auto-disabled" };
    }

    if (
      !force &&
      spikeFinalEvent.exchange_log_entries <= autoMode.last_evaluated_exchange_log_entries
    ) {
      return { handled: false, reason: "nothing-new-to-evaluate" };
    }

    const evaluatingSession = await coordinator.sessionService.markAutoSpikeFinal(
      current,
      {
        messageId:
          spikeFinalEvent.telegram_message_ids.at(-1) ??
          autoMode.last_spike_final_message_id,
        exchangeLogEntries: spikeFinalEvent.exchange_log_entries,
        summary: spikeFinalEvent.final_reply_text,
      },
    );
    const latestAutoMode = normalizeAutoModeState(evaluatingSession.auto_mode);
    if (
      spikeFinalEvent.status === "interrupted" &&
      !latestAutoMode.pending_user_input
    ) {
      const pausedSession = await coordinator.sessionService.markAutoDecision(
        evaluatingSession,
        {
          phase: "blocked",
          blockedReason: "Interrupted by operator",
          resultSummary: "Interrupted by operator",
          clearPendingUserInput: false,
        },
      );
      return {
        handled: true,
        reason: "auto-paused-after-interrupt",
        session: pausedSession,
      };
    }

    const exactGoalToken = finalReplySatisfiesExactGoal(
      latestAutoMode,
      spikeFinalEvent,
      evaluatingSession,
    );
    if (exactGoalToken) {
      const doneSummary = `Locked goal satisfied by exact reply token ${exactGoalToken}.`;
      const doneSession = await coordinator.sessionService.markAutoDecision(
        evaluatingSession,
        {
          phase: "done",
          resultSummary: doneSummary,
          clearPendingUserInput: true,
        },
      );
      await coordinator.sendTopicMessage(
        doneSession,
        buildAutoDoneMessage(
          doneSummary,
          getSessionUiLanguage(doneSession),
        ),
      );
      return {
        handled: true,
        reason: "auto-done-exact-token",
        session: doneSession,
      };
    }

    const preDecisionMemory = await coordinator.loadOmniMemory(evaluatingSession);
    const evaluationPrompt = buildOmniEvaluationPrompt({
      autoMode: latestAutoMode,
      exchangeEntry: {
        user_prompt: evaluatingSession.last_user_prompt,
        assistant_reply:
          spikeFinalEvent.final_reply_text || evaluatingSession.last_agent_reply,
      },
      omniMemory: preDecisionMemory,
      pendingUserInput: latestAutoMode.pending_user_input,
      session: evaluatingSession,
    });
    const runtimeProfile = await coordinator.sessionService.resolveCodexRuntimeProfile(
      evaluatingSession,
      { target: "omni" },
    );
    const run = coordinator.startExecRun({
      codexBinPath: coordinator.config.codexBinPath,
      repoRoot: resolveSessionRepoRoot(
        evaluatingSession,
        coordinator.config.repoRoot,
      ),
      outputDir: coordinator.omniRunsRoot,
      outputPrefix: "decision",
      prompt: evaluationPrompt,
      model: runtimeProfile.model,
      reasoningEffort: runtimeProfile.reasoningEffort,
    });
    coordinator.activeDecisionChildren.set(sessionKey, run.child);
    const result = await run.done;
    const postDecisionSession =
      (await coordinator.sessionStore.load(session.chat_id, session.topic_id)) ||
      evaluatingSession;
    const postDecisionAutoMode = normalizeAutoModeState(
      postDecisionSession.auto_mode,
    );
    if (!postDecisionAutoMode.enabled) {
      return { handled: true, reason: "auto-disabled-during-evaluation" };
    }

    if (!result.ok) {
      const failedSession = await coordinator.sessionService.markAutoDecision(
        postDecisionSession,
        {
          phase: "failed",
          resultSummary: result.stderr || result.stdout || "Omni decision failed",
        },
      );
      await coordinator.sendTopicMessage(
        failedSession,
        buildAutoFailedMessage(
          result.stderr || result.stdout || "Omni decision failed",
          getSessionUiLanguage(failedSession),
        ),
      );
      return { handled: true, reason: "omni-decision-failed" };
    }

    let decision;
    const evaluationExchangeEntry = {
      user_prompt: evaluatingSession.last_user_prompt,
      assistant_reply:
        spikeFinalEvent.final_reply_text || evaluatingSession.last_agent_reply,
    };
    const lockedGoal =
      latestAutoMode.normalized_goal_interpretation
      || latestAutoMode.literal_goal_text
      || null;
    try {
      decision = parseOmniDecision(result.finalReply);
    } catch (error) {
      const failedSession = await coordinator.sessionService.markAutoDecision(
        postDecisionSession,
        {
          phase: "failed",
          resultSummary: error.message,
        },
      );
      await coordinator.sendTopicMessage(
        failedSession,
        buildAutoFailedMessage(
          error.message,
          getSessionUiLanguage(failedSession),
        ),
      );
      return { handled: true, reason: "omni-decision-invalid" };
    }

    const updatedOmniMemory = await coordinator.updateOmniMemoryFromDecision(
      postDecisionSession,
      decision,
      {
        lockedGoal,
        spikeSummary: evaluationExchangeEntry.assistant_reply,
      },
    );

    if (decision.status === "continue") {
      const nextPrompt = buildOmniStructuredNextPrompt({
        decision,
        omniMemory: updatedOmniMemory,
        fallbackAction: buildOmniFallbackNextPrompt({
          exchangeEntry: evaluationExchangeEntry,
        }),
      });
      const compactResult = await coordinator.maybeAutoCompactBeforeContinuation(
        postDecisionSession,
      );
      if (compactResult?.parked) {
        return { handled: true, reason: "auto-continuation-parked" };
      }
      const continuationSession = compactResult?.session || postDecisionSession;
      const continuationAutoMode = normalizeAutoModeState(
        continuationSession.auto_mode,
      );
      const continuationMemory = compactResult?.compacted
        ? await coordinator.loadOmniMemory(continuationSession)
        : updatedOmniMemory;

      if (decision.mode === "continue_after_sleep") {
        const sleepingSession = await coordinator.sessionService.scheduleAutoSleep(
          continuationSession,
          {
            sleepMinutes: decision.sleepMinutes,
            nextPrompt,
            resultSummary: decision.summary,
            clearPendingUserInput: true,
          },
        );
        await coordinator.sendTopicMessage(
          sleepingSession,
          buildAutoSleepingMessage({
            sleepMinutes: decision.sleepMinutes,
            nextPrompt,
            pendingUserInput: continuationAutoMode.pending_user_input,
            language: getSessionUiLanguage(sleepingSession),
            omniMemory: continuationMemory,
          }),
        );
        return {
          handled: true,
          reason: "auto-sleeping",
          session: sleepingSession,
        };
      }

      await coordinator.sendTopicMessage(
        continuationSession,
        buildAutoContinuationDispatchMessage({
          nextPrompt,
          pendingUserInput: continuationAutoMode.pending_user_input,
          language: getSessionUiLanguage(continuationSession),
          omniMemory: continuationMemory,
          decisionMode: decision.mode,
        }),
      );
      const nextSession = await coordinator.sendPromptToSpike(
        continuationSession,
        nextPrompt,
        {
          mode: decision.mode,
          pendingUserInput: continuationAutoMode.pending_user_input,
          decisionMode: decision.mode,
          omniMemory: continuationMemory,
          successPatch: {
            continuation_count: continuationAutoMode.continuation_count + 1,
            last_evaluated_exchange_log_entries:
              continuationAutoMode.last_spike_exchange_log_entries,
            last_result_summary: decision.summary,
          },
        },
      );
      if (nextSession?.parked) {
        return { handled: true, reason: "auto-continuation-parked" };
      }

      return { handled: true, reason: "auto-continued", session: nextSession };
    }

    if (decision.mode === "done") {
      const doneSession = await coordinator.sessionService.markAutoDecision(
        postDecisionSession,
        {
          phase: "done",
          resultSummary: decision.summary,
          clearPendingUserInput: true,
        },
      );
      await coordinator.sendTopicMessage(
        doneSession,
        decision.userMessage
          || buildAutoDoneMessage(
            decision.summary,
            getSessionUiLanguage(doneSession),
          ),
      );
      return { handled: true, reason: "auto-done", session: doneSession };
    }

    if (decision.mode === "blocked_external") {
      const blockedSession = await coordinator.sessionService.markAutoDecision(
        postDecisionSession,
        {
          phase: "blocked",
          blockedReason: decision.blockedReason,
          resultSummary: decision.summary || decision.blockedReason,
        },
      );
      await coordinator.sendTopicMessage(
        blockedSession,
        decision.userMessage
          || buildAutoBlockedMessage(
            decision.blockedReason,
            getSessionUiLanguage(blockedSession),
          ),
      );
      return { handled: true, reason: "auto-blocked", session: blockedSession };
    }

    const failedSession = await coordinator.sessionService.markAutoDecision(
      postDecisionSession,
      {
        phase: "failed",
        resultSummary: decision.summary,
      },
    );
    await coordinator.sendTopicMessage(
      failedSession,
      decision.userMessage
        || buildAutoFailedMessage(
          decision.summary,
          getSessionUiLanguage(failedSession),
        ),
    );
    return { handled: true, reason: "auto-failed", session: failedSession };
  } finally {
    coordinator.activeDecisionChildren.delete(sessionKey);
    coordinator.activeEvaluations.delete(sessionKey);
  }
}

export async function scanPendingSpikeFinals(coordinator) {
  const sessions = await coordinator.sessionStore.listSessions();

  for (const session of sessions) {
    const autoMode = normalizeAutoModeState(session.auto_mode);
    if (!autoMode.enabled) {
      continue;
    }

    if (!["running", "evaluating", "blocked", "failed"].includes(autoMode.phase)) {
      continue;
    }

    const spikeFinalEvent = await coordinator.spikeFinalEventStore.load(session);
    const hasNewFinal =
      spikeFinalEvent.exchange_log_entries >
      autoMode.last_evaluated_exchange_log_entries;
    if (!hasNewFinal) {
      continue;
    }

    if (session.lifecycle_state === "parked") {
      if (!finalReplySatisfiesExactGoal(autoMode, spikeFinalEvent, session)) {
        continue;
      }
    } else if (session.lifecycle_state !== "active") {
      continue;
    }

    await coordinator.evaluateSession(session);
  }
}

export async function resumeDueSleepingSessions(coordinator) {
  const sessions = await coordinator.sessionStore.listSessions();

  for (const session of sessions) {
    if (session.lifecycle_state !== "active") {
      continue;
    }

    const autoMode = normalizeAutoModeState(session.auto_mode);
    if (!autoMode.enabled || autoMode.phase !== "sleeping") {
      continue;
    }

    if (!autoMode.sleep_until || !autoMode.sleep_next_prompt) {
      await coordinator.failBrokenSleepState(
        session,
        "Omni sleep state is incomplete and cannot resume.",
      );
      continue;
    }

    const wakeAtMs = Date.parse(autoMode.sleep_until);
    if (!Number.isFinite(wakeAtMs)) {
      await coordinator.failBrokenSleepState(
        session,
        "Omni sleep state has an invalid wake timestamp.",
      );
      continue;
    }
    if (wakeAtMs > Date.now()) {
      continue;
    }

    if (await coordinator.promptHandoffStore.load(session)) {
      continue;
    }

    const compactResult = await coordinator.maybeAutoCompactBeforeContinuation(session);
    if (compactResult?.parked) {
      continue;
    }
    const continuationSession = compactResult?.session || session;
    const continuationAutoMode = normalizeAutoModeState(continuationSession.auto_mode);
    if (!continuationAutoMode.sleep_next_prompt) {
      await coordinator.failBrokenSleepState(
        continuationSession,
        "Omni sleep state is missing the queued wake-up prompt.",
      );
      continue;
    }

    const wakeMemory = await coordinator.loadOmniMemory(continuationSession);
    await coordinator.sendTopicMessage(
      continuationSession,
      buildAutoContinuationDispatchMessage({
        nextPrompt: continuationAutoMode.sleep_next_prompt,
        pendingUserInput: continuationAutoMode.pending_user_input,
        language: getSessionUiLanguage(continuationSession),
        omniMemory: wakeMemory,
        decisionMode: wakeMemory.last_decision_mode,
      }),
    );
    await coordinator.sendPromptToSpike(continuationSession, continuationAutoMode.sleep_next_prompt, {
      mode: "continuation",
      pendingUserInput: continuationAutoMode.pending_user_input,
      decisionMode: wakeMemory.last_decision_mode,
      omniMemory: wakeMemory,
      successPatch: {
        continuation_count: continuationAutoMode.continuation_count + 1,
        last_evaluated_exchange_log_entries:
          continuationAutoMode.last_evaluated_exchange_log_entries,
        last_result_summary: continuationAutoMode.last_result_summary,
      },
    });
  }
}
