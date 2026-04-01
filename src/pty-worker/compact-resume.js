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

export function buildCompactResumePrompt({ session, prompt, compactState }) {
  const activeBrief = truncateBlock(compactState?.activeBrief || "");

  const lines = [
    "The previous Codex thread for this Telegram topic could not be resumed.",
    "A fresh active brief was generated from the session exchange log.",
    "Use it as bootstrap context, inspect the workspace if anything looks stale, and continue with the latest user request.",
    "",
    `session_key: ${session.session_key}`,
    `cwd: ${session.workspace_binding.cwd}`,
    `previous_thread_id: ${session.codex_thread_id ?? "none"}`,
    `last_run_status: ${session.last_run_status ?? "none"}`,
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
