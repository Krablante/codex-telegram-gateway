function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function hasOwn(payload, key) {
  return Boolean(payload) && Object.hasOwn(payload, key);
}

function readOptionalTextField(payload, key) {
  if (!hasOwn(payload, key)) {
    return undefined;
  }

  return normalizeText(payload[key]);
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    const singleValue = normalizeText(value);
    return singleValue ? [singleValue] : [];
  }

  return [
    ...new Set(
      value
        .map((entry) => normalizeText(entry))
        .filter(Boolean),
    ),
  ];
}

function readOptionalStringListField(payload, key) {
  if (!hasOwn(payload, key)) {
    return undefined;
  }

  if (Array.isArray(payload[key])) {
    return normalizeStringList(payload[key]);
  }

  const singleValue = normalizeText(payload[key]);
  return singleValue ? [singleValue] : [];
}

function normalizeSleepMinutes(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("Invalid Omni sleep_minutes value");
  }

  const rounded = Math.trunc(parsed);
  if (rounded < 1 || rounded > 60) {
    throw new Error("Omni sleep_minutes must be between 1 and 60");
  }

  return rounded;
}

function extractJsonPayload(text) {
  const source = String(text ?? "").trim();
  if (!source) {
    throw new Error("Omni returned an empty decision payload");
  }

  try {
    return JSON.parse(source);
  } catch {}

  const fencedMatch = source.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  if (fencedMatch) {
    return JSON.parse(fencedMatch[1].trim());
  }

  const objectMatch = source.match(/\{[\s\S]*\}/u);
  if (objectMatch) {
    return JSON.parse(objectMatch[0]);
  }

  throw new Error("Could not parse Omni decision JSON");
}

function mapLegacyStatusToMode(status, sleepMinutes) {
  if (status === "continue") {
    return sleepMinutes ? "continue_after_sleep" : "continue_same_line";
  }
  if (status === "blocked") {
    return "blocked_external";
  }

  return status;
}

function mapModeToStatus(mode) {
  if (
    mode === "continue_same_line"
    || mode === "continue_after_sleep"
    || mode === "pivot_to_next_line"
  ) {
    return "continue";
  }
  if (mode === "blocked_external") {
    return "blocked";
  }

  return mode;
}

function normalizeProofLineStatus(mode, value) {
  const normalized = normalizeText(value)?.toLowerCase();
  if (normalized) {
    return normalized;
  }

  if (mode === "continue_after_sleep") {
    return "monitoring";
  }
  if (mode === "pivot_to_next_line") {
    return "pivoting";
  }
  if (mode === "blocked_external") {
    return "blocked";
  }
  if (mode === "done") {
    return "done";
  }
  if (mode === "failed") {
    return "failed";
  }

  return "active";
}

export function parseOmniDecision(text) {
  const payload = extractJsonPayload(text);
  const legacySleepMinutes = normalizeSleepMinutes(payload?.sleep_minutes);
  const legacyStatus = normalizeText(payload?.status)?.toLowerCase();
  const mode = (
    normalizeText(payload?.decision_mode)?.toLowerCase()
    || mapLegacyStatusToMode(legacyStatus, legacySleepMinutes)
  );
  if (
    ![
      "continue_same_line",
      "continue_after_sleep",
      "pivot_to_next_line",
      "blocked_external",
      "done",
      "failed",
    ].includes(mode)
  ) {
    throw new Error(
      `Invalid Omni decision mode: ${payload?.decision_mode ?? payload?.status ?? "none"}`,
    );
  }

  const nextAction =
    readOptionalTextField(payload, "primary_next_action")
    ?? readOptionalTextField(payload, "next_action")
    ?? readOptionalTextField(payload, "primaryNextAction")
    ?? readOptionalTextField(payload, "nextPrompt")
    ?? readOptionalTextField(payload, "next_prompt")
    ?? null;
  const blockedReason = normalizeText(payload?.blocked_reason);
  const userMessage = normalizeText(payload?.user_message);
  const summary = normalizeText(payload?.summary);
  const sleepMinutes =
    mode === "continue_after_sleep"
      ? normalizeSleepMinutes(payload?.sleep_minutes)
      : legacySleepMinutes;

  if (mode !== "continue_after_sleep" && sleepMinutes !== null) {
    throw new Error("Omni sleep_minutes is only valid for sleep continuations");
  }

  if (mode === "continue_after_sleep" && sleepMinutes === null) {
    throw new Error("Omni continue_after_sleep requires sleep_minutes");
  }

  if (mode === "blocked_external" && !blockedReason) {
    throw new Error("Omni blocked decision requires blocked_reason");
  }

  return {
    mode,
    status: mapModeToStatus(mode),
    nextPrompt: nextAction,
    nextAction,
    primaryNextAction: nextAction,
    blockedReason,
    userMessage,
    summary,
    sleepMinutes,
    goalCapsule: readOptionalTextField(payload, "goal_capsule"),
    currentProofLine: readOptionalTextField(payload, "current_proof_line"),
    proofLineStatus: normalizeProofLineStatus(
      mode,
      readOptionalTextField(payload, "proof_line_status"),
    ),
    whyThisMattersToGoal: readOptionalTextField(payload, "why_this_matters_to_goal"),
    whatChanged: readOptionalTextField(payload, "what_changed"),
    goalUnsatisfied:
      readOptionalTextField(payload, "goal_unsatisfied")
      ?? readOptionalTextField(payload, "remaining_goal_gap"),
    remainingGoalGap: readOptionalTextField(payload, "remaining_goal_gap"),
    sideWork:
      readOptionalStringListField(payload, "bounded_side_work")
      ?? readOptionalStringListField(payload, "side_work"),
    boundedSideWork:
      readOptionalStringListField(payload, "bounded_side_work")
      ?? readOptionalStringListField(payload, "side_work"),
    doNotRegress: readOptionalStringListField(payload, "do_not_regress"),
    knownBottlenecks:
      readOptionalStringListField(payload, "known_bottlenecks"),
    candidatePivots:
      readOptionalStringListField(payload, "candidate_pivots"),
    supervisorNotes:
      readOptionalStringListField(payload, "supervisor_notes"),
    goalConstraints:
      readOptionalStringListField(payload, "goal_constraints"),
  };
}
