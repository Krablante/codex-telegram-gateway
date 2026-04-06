import { getSessionUiLanguage } from "../i18n/ui-language.js";
import { buildDefaultOmniMemory } from "./memory.js";
import {
  buildAutoCompactingMessage,
  buildAutoContinuityRefreshFailedMessage,
} from "./prompting.js";
import { normalizeAutoModeState } from "../session-manager/auto-mode.js";
import { buildFallbackGoalCapsule, getLockedGoalText } from "./goal-capsule.js";

const AUTO_COMPACT_MIN_PROMPTS = 10;

export async function loadOmniMemory(coordinator, session) {
  return coordinator.omniMemoryStore?.load(session) || buildDefaultOmniMemory();
}

export async function resetOmniMemory(coordinator, session) {
  await coordinator.omniMemoryStore?.clear(session);
}

export async function seedOmniMemoryFromGoal(coordinator, session) {
  const autoMode = normalizeAutoModeState(session.auto_mode);
  const lockedGoal = getLockedGoalText(autoMode);

  if (!lockedGoal || !coordinator.omniMemoryStore) {
    return coordinator.loadOmniMemory(session);
  }

  return coordinator.omniMemoryStore.write(session, {
    goal_capsule: null,
    goal_constraints: [],
    current_proof_line: null,
    proof_line_status: null,
    last_spike_summary: null,
    last_decision_mode: null,
    known_bottlenecks: [],
    candidate_pivots: [],
    side_work_queue: [],
    supervisor_notes: [],
    why_this_matters_to_goal: null,
    goal_unsatisfied: null,
    remaining_goal_gap: null,
    what_changed_since_last_cycle: null,
    last_what_changed: null,
    primary_next_action: null,
    bounded_side_work: [],
    do_not_regress: [],
  });
}

export async function updateOmniMemoryFromDecision(
  coordinator,
  session,
  decision,
  {
    lockedGoal = null,
    spikeSummary = null,
  } = {},
) {
  if (!coordinator.omniMemoryStore) {
    return coordinator.loadOmniMemory(session);
  }

  const fallbackGoalCapsule = buildFallbackGoalCapsule(lockedGoal);

  return coordinator.omniMemoryStore.patch(session, (currentMemory) => ({
    goal_capsule:
      decision.goalCapsule === undefined
        ? currentMemory.goal_capsule || fallbackGoalCapsule
        : decision.goalCapsule || fallbackGoalCapsule,
    goal_constraints:
      decision.goalConstraints
      ?? (currentMemory.goal_constraints.length > 0
        ? currentMemory.goal_constraints
        : []),
    current_proof_line:
      decision.currentProofLine === undefined
        ? currentMemory.current_proof_line
        : decision.currentProofLine,
    proof_line_status:
      decision.proofLineStatus ?? currentMemory.proof_line_status,
    last_spike_summary:
      String(spikeSummary || "").trim() || currentMemory.last_spike_summary,
    last_decision_mode: decision.mode,
    known_bottlenecks:
      decision.knownBottlenecks ?? currentMemory.known_bottlenecks,
    candidate_pivots:
      decision.candidatePivots ?? currentMemory.candidate_pivots,
    side_work_queue: decision.sideWork ?? currentMemory.side_work_queue,
    supervisor_notes:
      decision.supervisorNotes ?? currentMemory.supervisor_notes,
    why_this_matters_to_goal:
      decision.whyThisMattersToGoal === undefined
        ? currentMemory.why_this_matters_to_goal
        : decision.whyThisMattersToGoal,
    goal_unsatisfied:
      decision.goalUnsatisfied === undefined
        ? currentMemory.goal_unsatisfied
        : decision.goalUnsatisfied,
    remaining_goal_gap:
      decision.remainingGoalGap === undefined
        ? currentMemory.remaining_goal_gap
        : decision.remainingGoalGap,
    what_changed_since_last_cycle:
      decision.whatChanged === undefined
        ? currentMemory.what_changed_since_last_cycle
        : decision.whatChanged,
    last_what_changed:
      decision.whatChanged === undefined
        ? currentMemory.last_what_changed
        : decision.whatChanged,
    primary_next_action:
      decision.primaryNextAction
      ?? decision.nextAction
      ?? currentMemory.primary_next_action,
    bounded_side_work:
      decision.boundedSideWork
      ?? decision.sideWork
      ?? currentMemory.bounded_side_work,
    do_not_regress:
      decision.doNotRegress ?? currentMemory.do_not_regress,
  }));
}

export function shouldAutoCompact(autoMode, coordinator) {
  return Boolean(coordinator.sessionService?.sessionCompactor)
    && autoMode.enabled
    && autoMode.continuation_count_since_compact >= AUTO_COMPACT_MIN_PROMPTS;
}

export async function maybeAutoCompactBeforeContinuation(coordinator, session) {
  const current =
    (await coordinator.sessionStore.load(session.chat_id, session.topic_id)) || session;
  const autoMode = normalizeAutoModeState(current.auto_mode);
  if (!shouldAutoCompact(autoMode, coordinator)) {
    return { session: current, compacted: false };
  }

  const delivery = await coordinator.sendTopicMessage(
    current,
    buildAutoCompactingMessage(getSessionUiLanguage(current)),
  );
  if (delivery?.parked) {
    return { parked: true, session: delivery.session || current };
  }

  try {
    const compacted = await coordinator.sessionService.compactSession(
      current,
      "auto-compact:omni-cycle-boundary",
    );
    const compactedSession = await coordinator.sessionService.updateAutoMode(
      compacted.session || current,
      {
        ...normalizeAutoModeState((compacted.session || current).auto_mode),
        last_auto_compact_at: new Date().toISOString(),
        first_omni_prompt_at: null,
        continuation_count_since_compact: 0,
      },
    );
    await coordinator.omniMemoryStore?.patch(compactedSession, {
      last_auto_compact_at: new Date().toISOString(),
      continuation_count_since_compact: 0,
      first_omni_prompt_at: null,
      last_auto_compact_reason: "auto-compact:omni-cycle-boundary",
      last_auto_compact_exchange_log_entries: compacted.exchangeLogEntries ?? 0,
    });
    return {
      session: compactedSession,
      compacted: true,
    };
  } catch (error) {
    const failureDelivery = await coordinator.sendTopicMessage(
      current,
      buildAutoContinuityRefreshFailedMessage(
        error.message,
        getSessionUiLanguage(current),
      ),
    );
    if (failureDelivery?.parked) {
      return {
        parked: true,
        session: failureDelivery.session || current,
        compacted: false,
      };
    }
    return {
      session: current,
      compacted: false,
    };
  }
}
