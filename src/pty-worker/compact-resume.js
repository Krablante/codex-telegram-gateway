function truncateBlock(text, limit = 12000) {
  if (!text) {
    return "";
  }

  if (text.length <= limit) {
    return text.trim();
  }

  return `${text.slice(0, limit).trim()}\n\n[truncated]`;
}

export function summarizeCompactState(compactState) {
  const activeBrief = truncateBlock(compactState?.activeBrief || "");
  const exchangeLogEntries = Array.isArray(compactState?.exchangeLog)
    ? compactState.exchangeLog.length
    : 0;

  return {
    hasActiveBrief: activeBrief.length > 0,
    activeBriefChars: activeBrief.length,
    exchangeLogEntries,
  };
}

export function buildCompactResumePrompt({
  session,
  prompt,
  compactState,
  mode = "resume-fallback",
}) {
  const activeBrief = truncateBlock(compactState?.activeBrief || "");
  const exchangeLogEntries = Array.isArray(compactState?.exchangeLog)
    ? compactState.exchangeLog.length
    : session.exchange_log_entries ?? 0;
  const introLines =
    mode === "fresh-brief"
      ? [
          "This Telegram topic has no live Codex thread, but it does have a stored active brief.",
          "Use the brief as bootstrap context for a fresh run, inspect the workspace if anything looks stale, and continue with the latest user request.",
        ]
      : [
          "The previous Codex thread for this Telegram topic could not be resumed.",
          "A fresh active brief was generated from the session exchange log.",
          "Use it as bootstrap context, inspect the workspace if anything looks stale, and continue with the latest user request.",
        ];

  const lines = [
    ...introLines,
    "",
    `session_key: ${session.session_key}`,
    `topic_name: ${session.topic_name ?? "unknown"}`,
    `cwd: ${session.workspace_binding.cwd}`,
    `previous_thread_id: ${session.codex_thread_id ?? "none"}`,
    `last_run_status: ${session.last_run_status ?? "none"}`,
    `last_compacted_at: ${session.last_compacted_at ?? "none"}`,
    `last_compaction_reason: ${session.last_compaction_reason ?? "none"}`,
    `exchange_log_entries: ${exchangeLogEntries}`,
    "",
    "## Active brief",
  ];

  if (activeBrief) {
    lines.push("```markdown", activeBrief, "```");
  } else {
    lines.push("- no active brief available");
  }

  lines.push(
    "",
    "## Latest user request",
    prompt,
  );

  return `${lines.join("\n")}\n`;
}
