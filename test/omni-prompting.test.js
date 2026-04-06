import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOmniEvaluationPrompt,
  buildOmniTopicPrompt,
} from "../src/omni/prompting.js";
import { normalizeAutoModeState } from "../src/session-manager/auto-mode.js";

function buildSession() {
  return {
    session_key: "-1003577434463:77",
    chat_id: "-1003577434463",
    topic_id: "77",
    topic_name: "Omni prompting test",
    workspace_binding: {
      repo_root: "/home/bloob/atlas",
      cwd: "/home/bloob/atlas",
      branch: "main",
      worktree_path: "/home/bloob/atlas",
    },
  };
}

test("buildOmniEvaluationPrompt uses a compact goal reference and worker instruction extract", () => {
  const longGoal = [
    "Drive Arseed toward a real Snapseed-like daily-driver editor.",
    "Scope and product line: Linux, Android, local web.",
    "Hard success rules: ship working behavior, not shell progress.",
  ].join(" ");
  const prompt = buildOmniEvaluationPrompt({
    autoMode: normalizeAutoModeState({
      enabled: true,
      phase: "running",
      literal_goal_text: longGoal,
      normalized_goal_interpretation: longGoal,
    }),
    exchangeEntry: {
      user_prompt: [
        "Goal-locked handoff from Omni.",
        "",
        "Locked goal:",
        longGoal,
        "",
        "Primary next action:",
        "Fix Android import determinism without regressing the green smoke path.",
      ].join("\n"),
      assistant_reply:
        "Android smoke is green except for exact-file import determinism on the picker path.",
    },
    omniMemory: {
      goal_capsule:
        "Ship a Snapseed-like editor that is honestly usable on Linux, Android, and local web.",
      goal_constraints: [],
      current_proof_line: "Android import determinism",
      proof_line_status: "active",
      why_this_matters_to_goal:
        "Android import reliability gates honest daily-driver use.",
      goal_unsatisfied:
        "The app still cannot deterministically reopen the intended JPEG on Android 15.",
      what_changed_since_last_cycle:
        "Save/reopen smoke is green; only import targeting remains.",
      known_bottlenecks: ["Android 15 photo picker ambiguity"],
      candidate_pivots: ["release-safe open-with flow"],
      do_not_regress: ["Keep signed-release smoke green."],
      supervisor_notes: ["Prefer exact-file targeting over thumbnail heuristics."],
    },
    pendingUserInput: null,
    session: buildSession(),
  });

  assert.match(prompt, /Locked goal capsule:/u);
  assert.match(
    prompt,
    /Ship a Snapseed-like editor that is honestly usable on Linux, Android, and local web\./u,
  );
  assert.match(prompt, /Latest Spike worker instruction:/u);
  assert.match(
    prompt,
    /Fix Android import determinism without regressing the green smoke path\./u,
  );
  assert.doesNotMatch(prompt, /Latest Spike prompt:/u);
  assert.doesNotMatch(prompt, /Scope and product line:/u);
});

test("buildOmniEvaluationPrompt keeps the full locked goal until Omni memory has a goal capsule", () => {
  const longGoal = [
    "Drive Arseed toward a real Snapseed-like daily-driver editor.",
    "Scope and product line: Linux, Android, local web.",
    "Hard success rules: ship working behavior, not shell progress.",
  ].join(" ");
  const prompt = buildOmniEvaluationPrompt({
    autoMode: normalizeAutoModeState({
      enabled: true,
      phase: "running",
      literal_goal_text: longGoal,
      normalized_goal_interpretation: longGoal,
    }),
    exchangeEntry: {
      user_prompt: "Primary next action:\nFix Android import determinism.",
      assistant_reply: "Import determinism is still open.",
    },
    omniMemory: {
      goal_capsule: null,
      goal_constraints: [],
    },
    pendingUserInput: null,
    session: buildSession(),
  });

  assert.match(prompt, /Locked goal:/u);
  assert.match(prompt, /Scope and product line: Linux, Android, local web\./u);
  assert.match(
    prompt,
    /Distill it into a short faithful goal_capsule for future continuation prompts\./u,
  );
});

test("buildOmniTopicPrompt uses a goal capsule for live continuation but full goal for bootstrap", () => {
  const longGoal = [
    "Drive Arseed toward a real Snapseed-like daily-driver editor.",
    "Scope and product line: Linux, Android, local web.",
    "Hard success rules: ship working behavior, not shell progress.",
  ].join(" ");
  const autoMode = normalizeAutoModeState({
    enabled: true,
    phase: "running",
    literal_goal_text: longGoal,
    normalized_goal_interpretation: longGoal,
  });
  const omniMemory = {
    goal_capsule:
      "Ship a Snapseed-like editor without losing daily-driver usability.",
    goal_constraints: [],
  };

  const continuationPrompt = buildOmniTopicPrompt({
    autoMode,
    initialWorkerPrompt: "Run the next bounded verification.",
    session: buildSession(),
    mode: "continuation",
    omniMemory,
    decisionMode: "continue_same_line",
    useFullGoalContext: false,
  });
  const bootstrapPrompt = buildOmniTopicPrompt({
    autoMode,
    initialWorkerPrompt: "Run the next bounded verification.",
    session: buildSession(),
    mode: "continuation",
    omniMemory,
    decisionMode: "pivot_to_next_line",
    useFullGoalContext: true,
  });

  assert.match(continuationPrompt, /Locked goal capsule:/u);
  assert.match(
    continuationPrompt,
    /Ship a Snapseed-like editor without losing daily-driver usability\./u,
  );
  assert.doesNotMatch(continuationPrompt, /Scope and product line:/u);

  assert.match(bootstrapPrompt, /Locked goal:/u);
  assert.match(bootstrapPrompt, /Scope and product line: Linux, Android, local web\./u);
  assert.doesNotMatch(bootstrapPrompt, /Locked goal capsule:/u);
});
