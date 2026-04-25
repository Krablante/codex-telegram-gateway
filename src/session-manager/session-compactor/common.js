const PERSISTED_COMPACTION_TTL_MS = 15 * 60 * 1000;
const ACTIVE_RULES_HEADING = "## Active rules";
const REQUIRED_BRIEF_HEADINGS = [
  "# Active brief",
  "## Workspace context",
  ACTIVE_RULES_HEADING,
  "## User preferences",
  "## Current state",
  "## Completed work",
  "## Open work",
  "## Latest exchange",
];

export function buildEmptyBrief(session, { reason, updatedAt }) {
  const lines = [
    "# Active brief",
    "",
    `updated_at: ${updatedAt}`,
    `updated_from_reason: ${reason}`,
    `session_key: ${session.session_key}`,
    `topic_name: ${session.topic_name ?? "unknown"}`,
    `cwd: ${session.workspace_binding.cwd}`,
    "",
    "## Workspace context",
    `- repo_root: ${session.workspace_binding.repo_root ?? "unknown"}`,
    `- worktree_path: ${session.workspace_binding.worktree_path ?? session.workspace_binding.cwd}`,
    `- branch: ${session.workspace_binding.branch ?? "unknown"}`,
    "",
    "## Summary",
    "- No exchange log entries yet.",
    "",
    ACTIVE_RULES_HEADING,
    "",
    "## User preferences",
    "- None captured yet.",
    "",
    "## Current state",
    "- No completed run has been summarized yet.",
    "- Wait for the next real exchange before inferring project state.",
    "",
    "## Completed work",
    "- Nothing summarized yet.",
    "",
    "## Open work",
    "- Wait for the next real exchange.",
    "",
    "## Latest exchange",
    "- No exchange log entries yet.",
    "",
  ];

  return `${lines.join("\n")}\n`;
}

export function normalizeBrief(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "";
  }

  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

export function hasRequiredBriefStructure(brief) {
  const normalized = normalizeBrief(brief);
  if (!normalized) {
    return false;
  }

  return REQUIRED_BRIEF_HEADINGS.every((heading) => normalized.includes(`${heading}\n`));
}

export function isPersistedCompactionActive(session) {
  if (!session?.compaction_in_progress) {
    return false;
  }

  const startedAt = Date.parse(String(session.compaction_started_at || ""));
  if (!Number.isFinite(startedAt)) {
    return true;
  }

  return (Date.now() - startedAt) <= PERSISTED_COMPACTION_TTL_MS;
}
