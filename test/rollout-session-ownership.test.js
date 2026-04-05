import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSessionOwnershipPatch,
  clearSessionOwnershipPatch,
  isSessionOwnedByDifferentGeneration,
  isSessionOwnedByGeneration,
  normalizeSessionOwnership,
  shouldForwardSessionToOwner,
} from "../src/rollout/session-ownership.js";

test("normalizeSessionOwnership keeps only supported ownership fields", () => {
  assert.deepEqual(
    normalizeSessionOwnership({
      session_owner_generation_id: " gen-2 ",
      session_owner_mode: "RETIRING",
      session_owner_claimed_at: "2026-04-05T00:00:00.000Z",
    }),
    {
      session_owner_generation_id: "gen-2",
      session_owner_mode: "retiring",
      session_owner_claimed_at: "2026-04-05T00:00:00.000Z",
    },
  );
});

test("buildSessionOwnershipPatch and clearSessionOwnershipPatch shape ownership values", () => {
  assert.deepEqual(
    buildSessionOwnershipPatch("gen-1", "active", "2026-04-05T00:00:00.000Z"),
    {
      session_owner_generation_id: "gen-1",
      session_owner_mode: "active",
      session_owner_claimed_at: "2026-04-05T00:00:00.000Z",
    },
  );
  assert.deepEqual(clearSessionOwnershipPatch(), {
    session_owner_generation_id: null,
    session_owner_mode: null,
    session_owner_claimed_at: null,
  });
});

test("shouldForwardSessionToOwner routes active foreign-owned sessions to a different generation", () => {
  const ownedSession = {
    last_run_status: "running",
    session_owner_generation_id: "gen-old",
    session_owner_mode: "active",
  };
  assert.equal(shouldForwardSessionToOwner(ownedSession, "gen-new"), true);
  assert.equal(shouldForwardSessionToOwner(ownedSession, "gen-old"), false);
  assert.equal(
    shouldForwardSessionToOwner(
      {
        ...ownedSession,
        last_run_status: "completed",
      },
      "gen-new",
    ),
    false,
  );
});

test("ownership match helpers distinguish local and foreign owners", () => {
  const session = {
    session_owner_generation_id: "gen-owner",
  };
  assert.equal(isSessionOwnedByGeneration(session, "gen-owner"), true);
  assert.equal(isSessionOwnedByDifferentGeneration(session, "gen-other"), true);
  assert.equal(isSessionOwnedByDifferentGeneration(session, "gen-owner"), false);
});
