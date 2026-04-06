const GOAL_CAPSULE_MAX_CHARS = 650;
const GOAL_SECTION_MARKERS = [
  " Scope and product line:",
  " Hard success rules:",
  " Path and priority:",
  " Active-wait rule:",
  " Treat the run as complete only when",
];

function normalizeText(value) {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  return normalized || null;
}

function truncateAtBoundary(text, maxChars = GOAL_CAPSULE_MAX_CHARS) {
  if (!text || text.length <= maxChars) {
    return text || null;
  }

  const boundary = Math.max(
    text.lastIndexOf(". ", maxChars),
    text.lastIndexOf("; ", maxChars),
    text.lastIndexOf(": ", maxChars),
    text.lastIndexOf(", ", maxChars),
    text.lastIndexOf(" ", maxChars),
  );
  if (boundary >= Math.floor(maxChars * 0.55)) {
    return `${text.slice(0, boundary + 1).trim()}...`;
  }

  return `${text.slice(0, maxChars).trim()}...`;
}

export function getLockedGoalText(autoMode = null) {
  return normalizeText(
    autoMode?.normalized_goal_interpretation || autoMode?.literal_goal_text,
  );
}

export function buildFallbackGoalCapsule(lockedGoal, { maxChars } = {}) {
  const normalized = normalizeText(lockedGoal);
  if (!normalized) {
    return null;
  }

  let capsuleSource = normalized;
  for (const marker of GOAL_SECTION_MARKERS) {
    const index = capsuleSource.indexOf(marker);
    if (index > 0) {
      capsuleSource = capsuleSource.slice(0, index).trim();
      break;
    }
  }

  return truncateAtBoundary(
    capsuleSource,
    maxChars ?? GOAL_CAPSULE_MAX_CHARS,
  );
}

export function resolveGoalCapsule({ autoMode = null, omniMemory = null } = {}) {
  return normalizeText(omniMemory?.goal_capsule)
    || buildFallbackGoalCapsule(getLockedGoalText(autoMode));
}
