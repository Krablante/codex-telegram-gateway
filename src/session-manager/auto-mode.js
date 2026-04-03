const AUTO_PHASES = new Set([
  "off",
  "await_goal",
  "await_initial_prompt",
  "running",
  "evaluating",
  "sleeping",
  "blocked",
  "done",
  "failed",
]);

const AUTO_TERMINAL_PHASES = new Set([
  "off",
  "done",
]);

export const AUTO_LAST_SPIKE_FINAL_FILE_NAME = "omni-last-spike-final.txt";

function normalizeIntegerString(value) {
  const normalized = String(value ?? "").trim();
  if (!/^-?\d+$/u.test(normalized)) {
    return null;
  }

  return normalized;
}

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeCounter(value) {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.trunc(value);
}

export function normalizeGoalInterpretation(value) {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  return normalized || null;
}

export function buildDefaultAutoModeState() {
  return {
    enabled: false,
    phase: "off",
    activated_at: null,
    updated_at: null,
    last_state_changed_at: null,
    activated_by_user_id: null,
    omni_bot_id: null,
    spike_bot_id: null,
    literal_goal_text: null,
    normalized_goal_interpretation: null,
    initial_worker_prompt: null,
    pending_user_input: null,
    last_omni_prompt_message_id: null,
    last_spike_final_message_id: null,
    last_spike_exchange_log_entries: 0,
    last_evaluated_exchange_log_entries: 0,
    continuation_count: 0,
    continuation_count_since_compact: 0,
    first_omni_prompt_at: null,
    last_auto_compact_at: null,
    sleep_until: null,
    sleep_next_prompt: null,
    blocked_reason: null,
    last_result_summary: null,
  };
}

export function normalizeAutoModeState(value) {
  const defaults = buildDefaultAutoModeState();
  const phase = AUTO_PHASES.has(value?.phase) ? value.phase : defaults.phase;
  const enabled = Boolean(value?.enabled) && phase !== "off";
  const literalGoalText = normalizeText(value?.literal_goal_text);
  const normalizedGoalInterpretation = normalizeText(
    value?.normalized_goal_interpretation,
  ) ?? normalizeGoalInterpretation(literalGoalText);

  return {
    ...defaults,
    enabled,
    phase: enabled ? phase : "off",
    activated_at: normalizeText(value?.activated_at),
    updated_at: normalizeText(value?.updated_at),
    last_state_changed_at: normalizeText(value?.last_state_changed_at),
    activated_by_user_id: normalizeIntegerString(value?.activated_by_user_id),
    omni_bot_id: normalizeIntegerString(value?.omni_bot_id),
    spike_bot_id: normalizeIntegerString(value?.spike_bot_id),
    literal_goal_text: literalGoalText,
    normalized_goal_interpretation: normalizedGoalInterpretation,
    initial_worker_prompt: normalizeText(value?.initial_worker_prompt),
    pending_user_input: normalizeText(value?.pending_user_input),
    last_omni_prompt_message_id: normalizeIntegerString(
      value?.last_omni_prompt_message_id,
    ),
    last_spike_final_message_id: normalizeIntegerString(
      value?.last_spike_final_message_id,
    ),
    last_spike_exchange_log_entries: normalizeCounter(
      value?.last_spike_exchange_log_entries,
    ),
    last_evaluated_exchange_log_entries: normalizeCounter(
      value?.last_evaluated_exchange_log_entries,
    ),
    continuation_count: normalizeCounter(value?.continuation_count),
    continuation_count_since_compact: normalizeCounter(
      value?.continuation_count_since_compact,
    ),
    first_omni_prompt_at: normalizeText(value?.first_omni_prompt_at),
    last_auto_compact_at: normalizeText(value?.last_auto_compact_at),
    sleep_until: normalizeText(value?.sleep_until),
    sleep_next_prompt: normalizeText(value?.sleep_next_prompt),
    blocked_reason: normalizeText(value?.blocked_reason),
    last_result_summary: normalizeText(value?.last_result_summary),
  };
}

export function isAutoModeEnabled(sessionLike) {
  return normalizeAutoModeState(sessionLike?.auto_mode).enabled;
}

export function isAutoModeTerminalPhase(phase) {
  return AUTO_TERMINAL_PHASES.has(phase);
}

export function isAutoModeHumanInputLocked(sessionLike) {
  const autoMode = normalizeAutoModeState(sessionLike?.auto_mode);
  return autoMode.enabled && !isAutoModeTerminalPhase(autoMode.phase);
}

export function canAutoModeAcceptPromptFromMessage(sessionLike, message) {
  const autoMode = normalizeAutoModeState(sessionLike?.auto_mode);
  if (!isAutoModeHumanInputLocked(sessionLike)) {
    return true;
  }
  if (autoMode.phase === "await_goal") {
    return false;
  }

  const senderId = normalizeIntegerString(message?.from?.id);
  return Boolean(senderId && autoMode.omni_bot_id && senderId === autoMode.omni_bot_id);
}
