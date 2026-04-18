function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

const SESSION_OWNER_MODES = new Set([
  "active",
  "retiring",
]);

export function normalizeSessionOwnerMode(value) {
  const normalized = normalizeText(value)?.toLowerCase() ?? null;
  return SESSION_OWNER_MODES.has(normalized) ? normalized : null;
}

export function normalizeSessionOwnership(payload = null) {
  return {
    session_owner_generation_id: normalizeText(payload?.session_owner_generation_id),
    session_owner_mode: normalizeSessionOwnerMode(payload?.session_owner_mode),
    session_owner_claimed_at: normalizeText(payload?.session_owner_claimed_at),
  };
}

export function buildSessionOwnershipPatch(
  generationId,
  mode = "active",
  claimedAt = new Date().toISOString(),
) {
  const normalizedGenerationId = normalizeText(generationId);
  const normalizedMode = normalizeSessionOwnerMode(mode);
  if (!normalizedGenerationId || !normalizedMode) {
    return clearSessionOwnershipPatch();
  }

  return {
    session_owner_generation_id: normalizedGenerationId,
    session_owner_mode: normalizedMode,
    session_owner_claimed_at: normalizeText(claimedAt),
  };
}

export function clearSessionOwnershipPatch() {
  return {
    session_owner_generation_id: null,
    session_owner_mode: null,
    session_owner_claimed_at: null,
  };
}

export function isSessionOwnedByGeneration(session, generationId) {
  return (
    normalizeText(session?.session_owner_generation_id)
    === normalizeText(generationId)
  );
}

export function isSessionOwnedByDifferentGeneration(session, generationId) {
  const ownerGenerationId = normalizeText(session?.session_owner_generation_id);
  if (!ownerGenerationId) {
    return false;
  }

  return ownerGenerationId !== normalizeText(generationId);
}

export function shouldForwardSessionToOwner(session, generationId) {
  const ownerMode = normalizeSessionOwnerMode(session?.session_owner_mode);
  const runStatus = String(session?.last_run_status ?? "").trim().toLowerCase();
  return (
    isSessionOwnedByDifferentGeneration(session, generationId)
    && (
      runStatus === "running"
      || (
        (ownerMode === "active" || ownerMode === "retiring")
        && !["completed", "failed", "interrupted"].includes(runStatus)
      )
    )
  );
}
