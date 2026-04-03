import test from "node:test";
import assert from "node:assert/strict";

import { parseOmniDecision } from "../src/omni/decision.js";

test("parseOmniDecision parses Omni v2 pivot decisions", () => {
  const decision = parseOmniDecision(JSON.stringify({
    decision_mode: "pivot_to_next_line",
    summary: "Current line exhausted.",
    current_proof_line: "session-compactor integration",
    proof_line_status: "pivoting",
    why_this_matters_to_goal: "Goal still needs seamless long-run continuity.",
    what_changed: "Spike proved the current line is done.",
    remaining_goal_gap: "Auto-compact trigger is still missing.",
    next_action: "Implement the auto-compact handshake.",
    side_work: ["Inspect the queue boundary."],
    do_not_regress: ["Keep manual /compact intact."],
    known_bottlenecks: ["Compaction timing."],
    candidate_pivots: ["session-compactor"],
    supervisor_notes: ["Prefer internal state over public chatter."],
    goal_constraints: ["Stay topic-scoped."],
    blocked_reason: null,
    user_message: null,
  }));

  assert.equal(decision.mode, "pivot_to_next_line");
  assert.equal(decision.status, "continue");
  assert.equal(decision.nextAction, "Implement the auto-compact handshake.");
  assert.deepEqual(decision.sideWork, ["Inspect the queue boundary."]);
  assert.deepEqual(decision.doNotRegress, ["Keep manual /compact intact."]);
  assert.deepEqual(decision.goalConstraints, ["Stay topic-scoped."]);
});

test("parseOmniDecision keeps legacy continue payloads working", () => {
  const decision = parseOmniDecision(JSON.stringify({
    status: "continue",
    summary: "Keep going.",
    next_prompt: "Verify the remaining branch.",
    blocked_reason: null,
    user_message: null,
  }));

  assert.equal(decision.mode, "continue_same_line");
  assert.equal(decision.status, "continue");
  assert.equal(decision.nextAction, "Verify the remaining branch.");
});

test("parseOmniDecision rejects sleep continuations without sleep_minutes", () => {
  assert.throws(
    () => parseOmniDecision(JSON.stringify({
      decision_mode: "continue_after_sleep",
      next_action: "Wake later and keep watching.",
    })),
    /requires sleep_minutes/u,
  );
});
