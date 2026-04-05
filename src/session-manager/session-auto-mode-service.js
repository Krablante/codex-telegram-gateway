import { cloneJson } from "../state/file-utils.js";
import {
  buildDefaultAutoModeState,
  normalizeAutoModeState,
  normalizeGoalInterpretation,
} from "./auto-mode.js";

function appendUserInput(existingInput, nextInput) {
  const base = String(existingInput || "").trim();
  const next = String(nextInput || "").trim();
  if (!base) {
    return next || null;
  }
  if (!next) {
    return base;
  }

  return `${base}\n\n${next}`;
}

export class SessionAutoModeService {
  constructor({ sessionStore }) {
    this.sessionStore = sessionStore;
  }

  getAutoMode(session) {
    return normalizeAutoModeState(session?.auto_mode);
  }

  async loadCurrentAutoMode(session) {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    return {
      session: current,
      autoMode: normalizeAutoModeState(current.auto_mode),
    };
  }

  async updateAutoMode(session, patch = {}) {
    return this.sessionStore.patchWithCurrent(session, async (current) => {
      const previous = normalizeAutoModeState(current.auto_mode);
      const now = new Date().toISOString();
      const nextPatch =
        typeof patch === "function"
          ? await patch({
              session: current,
              autoMode: previous,
              now,
            })
          : patch;

      if (nextPatch === null || nextPatch === undefined) {
        return null;
      }

      const clonedPatch = cloneJson(nextPatch);
      const next = normalizeAutoModeState({
        ...previous,
        ...clonedPatch,
        updated_at: now,
        last_state_changed_at:
          clonedPatch.phase && clonedPatch.phase !== previous.phase
            ? now
            : previous.last_state_changed_at ?? now,
      });

      if (!next.enabled) {
        next.phase = "off";
      }

      return {
        auto_mode: next,
      };
    });
  }

  async activateAutoMode(
    session,
    {
      activatedByUserId = null,
      omniBotId = null,
      spikeBotId = null,
    } = {},
  ) {
    const now = new Date().toISOString();
    return this.updateAutoMode(session, {
      ...buildDefaultAutoModeState(),
      enabled: true,
      phase: "await_goal",
      activated_at: now,
      last_state_changed_at: now,
      updated_at: now,
      activated_by_user_id: activatedByUserId,
      omni_bot_id: omniBotId,
      spike_bot_id: spikeBotId,
    });
  }

  async clearAutoMode(session) {
    return this.updateAutoMode(session, buildDefaultAutoModeState());
  }

  async captureAutoGoal(session, literalGoalText) {
    return this.updateAutoMode(session, () => ({
      enabled: true,
      phase: "await_initial_prompt",
      literal_goal_text: String(literalGoalText || "").trim() || null,
      normalized_goal_interpretation: normalizeGoalInterpretation(
        literalGoalText,
      ),
      blocked_reason: null,
      pending_user_input: null,
    }));
  }

  async captureAutoInitialPrompt(session, initialWorkerPrompt) {
    return this.updateAutoMode(session, () => ({
      enabled: true,
      phase: "await_initial_prompt",
      initial_worker_prompt: String(initialWorkerPrompt || "").trim() || null,
      blocked_reason: null,
      pending_user_input: null,
      last_result_summary: null,
    }));
  }

  async queueAutoUserInput(session, userInput) {
    return this.updateAutoMode(session, ({ autoMode }) => ({
      pending_user_input: appendUserInput(
        autoMode.pending_user_input,
        userInput,
      ),
      blocked_reason:
        autoMode.phase === "blocked"
          ? autoMode.blocked_reason
          : null,
    }));
  }

  async scheduleAutoSleep(
    session,
    {
      sleepMinutes,
      nextPrompt,
      resultSummary = null,
      clearPendingUserInput = true,
    } = {},
  ) {
    return this.updateAutoMode(session, ({ autoMode }) => ({
      phase: "sleeping",
      sleep_until: new Date(
        Date.now() + (sleepMinutes * 60 * 1000),
      ).toISOString(),
      sleep_next_prompt: String(nextPrompt || "").trim() || null,
      blocked_reason: null,
      last_result_summary: resultSummary,
      last_evaluated_exchange_log_entries:
        autoMode.last_spike_exchange_log_entries,
      pending_user_input: clearPendingUserInput
        ? null
        : autoMode.pending_user_input,
    }));
  }

  async markAutoSpikeFinal(
    session,
    {
      messageId = null,
      exchangeLogEntries = 0,
      summary = null,
    } = {},
  ) {
    return this.updateAutoMode(session, ({ autoMode }) => {
      if (!autoMode.enabled) {
        return null;
      }

      return {
        phase: "evaluating",
        last_spike_final_message_id: messageId,
        last_spike_exchange_log_entries: exchangeLogEntries,
        last_result_summary: summary,
      };
    });
  }

  async markAutoDecision(
    session,
    {
      phase,
      blockedReason = null,
      resultSummary = null,
      incrementContinuation = false,
      clearPendingUserInput = false,
    } = {},
  ) {
    return this.updateAutoMode(session, ({ autoMode }) => ({
      enabled: phase !== "off",
      phase,
      blocked_reason: blockedReason,
      last_result_summary: resultSummary,
      last_evaluated_exchange_log_entries:
        autoMode.last_spike_exchange_log_entries,
      continuation_count: incrementContinuation
        ? autoMode.continuation_count + 1
        : autoMode.continuation_count,
      pending_user_input: clearPendingUserInput
        ? null
        : autoMode.pending_user_input,
    }));
  }
}
