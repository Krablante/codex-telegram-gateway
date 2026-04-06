import test from "node:test";
import assert from "node:assert/strict";

import { sendPromptToSpike } from "../src/omni/coordinator-delivery.js";
import { normalizeAutoModeState } from "../src/session-manager/auto-mode.js";

function buildSession(autoMode = {}) {
  return {
    session_key: "-1001234567890:77",
    chat_id: "-1001234567890",
    topic_id: "77",
    topic_name: "Omni delivery test",
    workspace_binding: {
      repo_root: "/workspace",
      cwd: "/workspace",
      branch: "main",
      worktree_path: "/workspace",
    },
    auto_mode: normalizeAutoModeState({
      enabled: true,
      phase: "blocked",
      literal_goal_text: "Ship Omni safely.",
      normalized_goal_interpretation: "Ship Omni safely.",
      blocked_reason: "Need fresh logs",
      pending_user_input: "Upload the latest logs.",
      continuation_count: 2,
      continuation_count_since_compact: 1,
      last_spike_exchange_log_entries: 3,
      first_omni_prompt_at: null,
      ...autoMode,
    }),
  };
}

test("sendPromptToSpike computes auto-mode and Omni memory patches from fresh state", async () => {
  const queued = [];
  let autoModePatchType = null;
  let omniMemoryPatchType = null;
  const staleSession = buildSession({
    continuation_count_since_compact: 1,
    first_omni_prompt_at: null,
    last_spike_exchange_log_entries: 3,
  });
  const liveSession = buildSession({
    continuation_count_since_compact: 4,
    first_omni_prompt_at: "2026-04-05T00:00:00.000Z",
    last_spike_exchange_log_entries: 11,
  });
  const liveMemory = {
    goal_constraints: ["Ship Omni safely."],
    continuation_count_since_compact: 6,
    first_omni_prompt_at: "2026-04-05T00:00:00.000Z",
    last_decision_mode: "pivot_to_next_line",
    primary_next_action: "Old action",
  };

  const updatedSession = await sendPromptToSpike(
    {
      serviceState: {},
      promptHandoffStore: {
        async queue(session, payload) {
          queued.push({ session, payload });
        },
      },
      async loadOmniMemory() {
        return liveMemory;
      },
      sessionService: {
        async updateAutoMode(_session, patch) {
          autoModePatchType = typeof patch;
          const resolvedPatch =
            typeof patch === "function"
              ? await patch({
                  session: liveSession,
                  autoMode: normalizeAutoModeState(liveSession.auto_mode),
                  now: "2026-04-05T12:00:00.000Z",
                })
              : patch;
          return {
            ...liveSession,
            auto_mode: normalizeAutoModeState({
              ...liveSession.auto_mode,
              ...resolvedPatch,
            }),
          };
        },
      },
      omniMemoryStore: {
        async patch(_session, patch) {
          omniMemoryPatchType = typeof patch;
          return typeof patch === "function"
            ? patch(liveMemory)
            : patch;
        },
      },
    },
    staleSession,
    "Run the next bounded verification.",
    {
      mode: "continuation",
      pendingUserInput: "Upload the latest logs.",
      decisionMode: "pivot_to_next_line",
      successPatch: {
        continuation_count: 7,
        last_result_summary: "Waiting on operator input.",
      },
    },
  );

  assert.equal(queued.length, 1);
  assert.equal(autoModePatchType, "function");
  assert.equal(omniMemoryPatchType, "function");
  assert.equal(
    updatedSession.auto_mode.first_omni_prompt_at,
    "2026-04-05T00:00:00.000Z",
  );
  assert.equal(updatedSession.auto_mode.last_spike_exchange_log_entries, 11);
  assert.equal(updatedSession.auto_mode.continuation_count_since_compact, 5);
  assert.equal(updatedSession.auto_mode.continuation_count, 7);
  assert.equal(updatedSession.auto_mode.blocked_reason, null);
  assert.equal(updatedSession.auto_mode.pending_user_input, null);
});

test("sendPromptToSpike uses a compact goal capsule for continuation on a live thread", async () => {
  const queued = [];
  const longGoal = [
    "Drive Arseed toward a real Snapseed-like daily-driver editor.",
    "Scope and product line: Linux, Android, local web.",
    "Hard success rules: ship working behavior, not shell progress.",
  ].join(" ");

  await sendPromptToSpike(
    {
      serviceState: {},
      promptHandoffStore: {
        async queue(_session, payload) {
          queued.push(payload);
        },
      },
      async loadOmniMemory() {
        return {
          goal_capsule: "Ship a Snapseed-like editor without losing daily-driver usability.",
          goal_constraints: [],
          continuation_count_since_compact: 0,
          first_omni_prompt_at: "2026-04-05T00:00:00.000Z",
          last_decision_mode: "continue_same_line",
          primary_next_action: "Old action",
        };
      },
      sessionService: {
        async updateAutoMode(session, patch) {
          const resolvedPatch =
            typeof patch === "function"
              ? await patch({
                  session,
                  autoMode: normalizeAutoModeState(session.auto_mode),
                  now: "2026-04-05T12:00:00.000Z",
                })
              : patch;
          return {
            ...session,
            auto_mode: normalizeAutoModeState({
              ...session.auto_mode,
              ...resolvedPatch,
            }),
          };
        },
      },
      omniMemoryStore: {
        async patch(_session, patch) {
          return typeof patch === "function" ? patch({}) : patch;
        },
      },
    },
    {
      ...buildSession({
        literal_goal_text: longGoal,
        normalized_goal_interpretation: longGoal,
      }),
      codex_thread_id: "thread-live",
    },
    "Run the next bounded verification.",
    {
      mode: "continuation",
      decisionMode: "continue_same_line",
    },
  );

  assert.equal(queued.length, 1);
  assert.match(queued[0].prompt, /Locked goal capsule:/u);
  assert.match(
    queued[0].prompt,
    /Ship a Snapseed-like editor without losing daily-driver usability\./u,
  );
  assert.doesNotMatch(queued[0].prompt, /Scope and product line:/u);
});

test("sendPromptToSpike keeps full goal context for a continuation after compact rebuild", async () => {
  const queued = [];
  const longGoal = [
    "Drive Arseed toward a real Snapseed-like daily-driver editor.",
    "Scope and product line: Linux, Android, local web.",
    "Hard success rules: ship working behavior, not shell progress.",
  ].join(" ");

  await sendPromptToSpike(
    {
      serviceState: {},
      promptHandoffStore: {
        async queue(_session, payload) {
          queued.push(payload);
        },
      },
      async loadOmniMemory() {
        return {
          goal_capsule: "Ship a Snapseed-like editor without losing daily-driver usability.",
          goal_constraints: [],
          continuation_count_since_compact: 0,
          first_omni_prompt_at: "2026-04-05T00:00:00.000Z",
          last_decision_mode: "pivot_to_next_line",
          primary_next_action: "Old action",
        };
      },
      sessionService: {
        async updateAutoMode(session, patch) {
          const resolvedPatch =
            typeof patch === "function"
              ? await patch({
                  session,
                  autoMode: normalizeAutoModeState(session.auto_mode),
                  now: "2026-04-05T12:00:00.000Z",
                })
              : patch;
          return {
            ...session,
            auto_mode: normalizeAutoModeState({
              ...session.auto_mode,
              ...resolvedPatch,
            }),
          };
        },
      },
      omniMemoryStore: {
        async patch(_session, patch) {
          return typeof patch === "function" ? patch({}) : patch;
        },
      },
    },
    {
      ...buildSession({
        literal_goal_text: longGoal,
        normalized_goal_interpretation: longGoal,
      }),
      codex_thread_id: null,
    },
    "Run the next bounded verification.",
    {
      mode: "continuation",
      decisionMode: "pivot_to_next_line",
    },
  );

  assert.equal(queued.length, 1);
  assert.match(queued[0].prompt, /Locked goal:/u);
  assert.match(queued[0].prompt, /Scope and product line: Linux, Android, local web\./u);
  assert.doesNotMatch(queued[0].prompt, /Locked goal capsule:/u);
});
