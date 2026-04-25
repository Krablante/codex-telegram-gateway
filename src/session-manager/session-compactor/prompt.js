import { isContextWindowExceededText } from "../../codex-runtime/context-window.js";

export const isContextLengthExceededError = isContextWindowExceededText;

export function buildCompactionPrompt(session, { reason, source }) {
  const isBoundedSource = source?.kind === "bounded-compaction-source";
  const isFullCompactionSource = source?.kind === "full-compaction-source";
  const sourceDescription = isBoundedSource
    ? "The source file is a bounded compaction artifact built from the previous active brief, recent natural-language progress notes, older continuity excerpts, and a recent exchange-log slice."
    : isFullCompactionSource
      ? "The source file is a compact artifact that keeps the full exchange log because it is still small enough, while also adding pending natural-language progress notes."
      : "The exchange log file contains only user prompts and final agent replies.";
  const continuityGoal = isBoundedSource || isFullCompactionSource
    ? "Write a dense but readable markdown brief that lets a fresh Codex run continue work without rereading more history than necessary."
    : "Write a dense but readable markdown brief that lets a fresh Codex run continue work without rereading the full exchange log.";
  const lines = [
    "You are generating active-brief.md for a Telegram Codex session recovery flow.",
    sourceDescription,
    continuityGoal,
    "",
    "Rules:",
    "- Output only markdown for active-brief.md.",
    "- Start with '# Active brief'.",
    "- Be concrete, practical, and continuity-first.",
    "- Preserve enough context for the next run to understand where it is working, what was happening, what was just said, and what still needs to be done.",
    "- Fresh evidence is most important. In long-running topics, treat the latest exchanges, latest progress notes, and current active brief as stronger continuity than older log history.",
    "- Do not lose explicit user-specific rules that are still active just because they appeared only once earlier in the log.",
    "- Preserve concrete delivery, routing, account-usage, artifact-destination, and output-format instructions whenever they are still current.",
    "- Session-specific operator rules outrank generic evergreen behavior.",
    "- Optimize for handoff fidelity. A fresh run should be able to continue without rediscovering rules that were already settled.",
    "- Latest settled production state overrides older plans, experiments, fallbacks, or superseded architecture ideas.",
    "- When multiple milestones exist, prefer the latest settled build, release, commit, or production direction over earlier accepted checkpoints.",
    "- If the log shows a later explicit correction, migration, replacement, or 'actually do X instead of Y', do not carry Y forward as an active rule, current state, or open work item.",
    "- Treat superseded history as background only; do not resurrect it into Active rules, Current state, or Open work.",
    "- Keep exact command/workflow names and exact latest proof identifiers when they materially affect continuity.",
    "- Do not mention hidden reasoning, chain-of-thought, tools, or process chatter.",
    "- Recent progress notes are user-visible natural-language work notes; use them only to recover concrete current state and open work, not as hidden chain-of-thought.",
    "- Ignore plan/todo/file/tool/command/web/subagent chatter if it appears in any source; it is not canonical memory.",
    "- Do not wrap the answer in code fences.",
    "- Prefer real repo/module names, concrete facts, current focus, recent outcomes, and actionable next steps over vague summaries.",
    "- Do not collapse the session into a one-line recap like 'continue previous work'.",
    "",
    "Use this structure:",
    "# Active brief",
    "updated_from_reason: ...",
    "session_key: ...",
    "topic_name: ...",
    "cwd: ...",
    "## Workspace context",
    "## Active rules",
    "## User preferences",
    "## Current state",
    "## Completed work",
    "## Open work",
    "## Latest exchange",
    "",
    "Section guidance:",
    "- Workspace context: where work is happening, which repo/path/module matters, and any environment/runtime facts the next run should know immediately. Include exact repo/runtime/state anchors when they materially help the next run orient quickly.",
    "- Active rules: explicit user-specific instructions that are still in force, especially ones that are not guaranteed by repo docs or agents. Preserve delivery/account rules, artifact destinations, reply-routing expectations, output constraints, and similar operational directives in concrete bullets. Keep only rules still in force by the end of the log. Bias toward operator instructions, sync/restart rules, suffix/reviewer constraints, and style constraints. Avoid generic capabilities unless the user treated them as explicit rules.",
    "- User preferences: softer durable style, workflow, autonomy, or communication preferences. Keep this separate from hard rules.",
    "- Current state: what the session was recently doing, latest meaningful outcome, and any active constraints or blockers. Prefer the latest settled milestone and active direction over abandoned intermediate plans.",
    "- Completed work: concrete fixes, decisions, or verified outcomes already achieved. Compress older history when it no longer drives the present.",
    "- Open work: unresolved tasks, next likely moves, and unfinished threads that should not be forgotten. Keep explicitly parked backlog that still matters, but drop stale branches that were replaced later.",
    "- Latest exchange: capture the latest user ask and the latest assistant outcome in concrete terms, keeping exact identifiers when they matter for continuity.",
    "",
    "Before finalizing, silently verify that the brief preserves still-active rules, exact latest proof, and the next likely continuation path while excluding superseded policy.",
    "",
    "Session metadata:",
    `- session_key: ${session.session_key}`,
    `- topic_name: ${session.topic_name ?? "unknown"}`,
    `- cwd: ${session.workspace_binding.cwd}`,
    `- repo_root: ${session.workspace_binding.repo_root ?? "unknown"}`,
    `- worktree_path: ${session.workspace_binding.worktree_path ?? session.workspace_binding.cwd}`,
    `- branch: ${session.workspace_binding.branch ?? "unknown"}`,
    `- last_run_status: ${session.last_run_status ?? "none"}`,
    `- last_run_started_at: ${session.last_run_started_at ?? "none"}`,
    `- last_run_finished_at: ${session.last_run_finished_at ?? "none"}`,
    `- reason: ${reason}`,
    `- exchange_log_entries: ${source.exchangeLogEntries}`,
    `- progress_notes: ${source.progressNotes ?? 0}`,
    "",
    ...(isBoundedSource
      ? [
          `- recent_exchange_entries_included: ${source.recentExchangeEntries}`,
          `- older_exchange_entries_omitted: ${source.omittedExchangeEntries}`,
          `- older_high_signal_exchange_entries_included: ${source.highSignalExchangeEntries ?? 0}`,
          `- older_chronology_checkpoint_entries_included: ${source.chronologyCheckpointEntries ?? 0}`,
          `- recent_progress_notes_included: ${source.recentProgressNotes}`,
          `- older_progress_notes_omitted: ${source.omittedProgressNotes}`,
          "",
          "Read the bounded compaction source from this file:",
        ]
      : isFullCompactionSource
        ? [
            `- full_exchange_entries_included: ${source.fullExchangeEntries}`,
            `- recent_progress_notes_included: ${source.recentProgressNotes}`,
            `- older_progress_notes_omitted: ${source.omittedProgressNotes}`,
            "",
            "Read the full compaction source from this file:",
          ]
        : ["Read the exchange log from this file:"]),
    source.path,
    "",
    ...(isBoundedSource
      ? [
          "Use the previous active brief as baseline continuity, but let newer facts in the recent exchange slice override anything stale or superseded.",
          "Older high-signal excerpts are only continuity candidates for durable user rules/preferences; discard them when the recent slice or active brief supersedes them.",
          "Older chronology checkpoints preserve first-time oversized-session shape; keep only durable facts that are not superseded by newer evidence.",
          "The omitted older exchanges are intentionally excluded for context safety and may already be captured by the previous active brief.",
        ]
      : isFullCompactionSource
        ? [
            "Use the full exchange-log section as source of truth for conversation history.",
            "Use the progress-note section only as recent user-visible work-state hints, not as hidden reasoning.",
            "Let newer full-log exchanges override stale prior active-brief content.",
          ]
        : ["Use that file as the source of truth for the brief."]),
  ];

  return `${lines.join("\n")}\n`;
}
