import { runCodexTask } from "../pty-worker/codex-runner.js";

const MAX_SUMMARIZER_RETRIES = 1;
const COMPACTION_APP_SERVER_BOOT_TIMEOUT_MS = 60000;
const COMPACTION_ROLLOUT_DISCOVERY_TIMEOUT_MS = 30000;
const COMPACTION_ROLLOUT_STALL_AFTER_CHILD_EXIT_MS = 30000;

function buildEmptyBrief(session, { reason, updatedAt }) {
  const lines = [
    "# Active brief",
    "",
    `updated_at: ${updatedAt}`,
    `reason: ${reason}`,
    `session_key: ${session.session_key}`,
    `cwd: ${session.workspace_binding.cwd}`,
    "",
    "## Summary",
    "- No exchange log entries yet.",
    "",
    "## User preferences",
    "- None captured yet.",
    "",
    "## Completed work",
    "- Nothing summarized yet.",
    "",
    "## Open work",
    "- Wait for the next real exchange.",
    "",
  ];

  return `${lines.join("\n")}\n`;
}

function buildCompactionPrompt(session, { reason, exchangeLogEntries, exchangeLogPath }) {
  const lines = [
    "You are generating active-brief.md for a Telegram Codex session recovery flow.",
    "The exchange log file contains only user prompts and final agent replies.",
    "Write a concise markdown brief that helps a fresh Codex run continue work after thread loss.",
    "",
    "Rules:",
    "- Output only markdown for active-brief.md.",
    "- Start with '# Active brief'.",
    "- Be concrete, concise, and practical.",
    "- Keep only durable context: user preferences, completed work, open work, and the latest relevant state.",
    "- Do not mention hidden reasoning, chain-of-thought, tools, or process chatter.",
    "- Do not wrap the answer in code fences.",
    "",
    "Use this structure:",
    "# Active brief",
    "updated_from_reason: ...",
    "session_key: ...",
    "cwd: ...",
    "## User preferences",
    "## Completed work",
    "## Open work",
    "## Latest exchange",
    "",
    "Session metadata:",
    `- session_key: ${session.session_key}`,
    `- topic_name: ${session.topic_name ?? "unknown"}`,
    `- cwd: ${session.workspace_binding.cwd}`,
    `- last_run_status: ${session.last_run_status ?? "none"}`,
    `- reason: ${reason}`,
    `- exchange_log_entries: ${exchangeLogEntries}`,
    "",
    "Read the exchange log from this file:",
    exchangeLogPath,
    "",
    "Use that file as the source of truth for the brief.",
  ];

  return `${lines.join("\n")}\n`;
}

function normalizeBrief(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "";
  }

  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

async function generateBriefWithCodex({
  config,
  exchangeLogEntries,
  exchangeLogPath,
  reason,
  runTask,
  session,
}) {
  if (!config?.codexBinPath) {
    throw new Error("Session compactor requires codexBinPath");
  }

  const prompt = buildCompactionPrompt(session, {
    reason,
    exchangeLogEntries,
    exchangeLogPath,
  });
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_SUMMARIZER_RETRIES; attempt += 1) {
    try {
      let finalAgentMessage = "";
      const { finished } = runTask({
        codexBinPath: config.codexBinPath,
        cwd: session.workspace_binding.cwd,
        prompt,
        sessionThreadId: null,
        imagePaths: [],
        appServerBootTimeoutMs: COMPACTION_APP_SERVER_BOOT_TIMEOUT_MS,
        rolloutDiscoveryTimeoutMs: COMPACTION_ROLLOUT_DISCOVERY_TIMEOUT_MS,
        rolloutStallAfterChildExitMs: COMPACTION_ROLLOUT_STALL_AFTER_CHILD_EXIT_MS,
        onEvent: async (summary) => {
          if (summary?.kind === "agent_message" && typeof summary.text === "string") {
            finalAgentMessage = summary.text;
          }
        },
        onWarning: () => {},
      });
      const result = await finished;
      const brief = normalizeBrief(finalAgentMessage);

      if (brief) {
        return brief;
      }

      if (result.exitCode !== 0) {
        throw new Error(`Compaction summarizer exited with code ${result.exitCode}`);
      }

      throw new Error("Compaction summarizer returned an empty brief");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

export class SessionCompactor {
  constructor({
    sessionStore,
    config = null,
    runTask = runCodexTask,
  }) {
    this.sessionStore = sessionStore;
    this.config = config;
    this.runTask = runTask;
    this.activeCompactions = new Map();
  }

  isCompacting(sessionOrKey) {
    const sessionKey = typeof sessionOrKey === "string"
      ? sessionOrKey
      : sessionOrKey?.session_key;
    return Boolean(sessionKey) && this.activeCompactions.has(sessionKey);
  }

  async compact(session, { reason = "manual" } = {}) {
    const sessionKey = session.session_key;
    const previous = this.activeCompactions.get(sessionKey) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.compactOnce(session, { reason }));

    this.activeCompactions.set(sessionKey, current);

    try {
      return await current;
    } finally {
      if (this.activeCompactions.get(sessionKey) === current) {
        this.activeCompactions.delete(sessionKey);
      }
    }
  }

  async compactOnce(session, { reason }) {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    if (current.lifecycle_state === "purged") {
      return {
        session: current,
        skipped: "purged",
        reason,
      };
    }

    const exchangeLog = await this.sessionStore.loadExchangeLog(current);
    const updatedAt = new Date().toISOString();
    const exchangeLogPath = this.sessionStore.getExchangeLogPath(
      current.chat_id,
      current.topic_id,
    );
    const activeBrief =
      exchangeLog.length === 0
        ? buildEmptyBrief(current, { reason, updatedAt })
        : await generateBriefWithCodex({
            config: this.config,
            exchangeLogEntries: exchangeLog.length,
            exchangeLogPath,
            reason,
            runTask: this.runTask,
            session: current,
          });

    await this.sessionStore.writeSessionText(current, "active-brief.md", activeBrief);
    await this.sessionStore.removeLegacyMemoryFiles(current);
    const updated = await this.sessionStore.patch(current, {
      last_compacted_at: updatedAt,
      last_compaction_reason: reason,
      exchange_log_entries: exchangeLog.length,
      codex_thread_id: null,
      codex_rollout_path: null,
      last_context_snapshot: null,
      last_token_usage: null,
    });

    return {
      session: updated,
      reason,
      activeBrief,
      exchangeLogEntries: exchangeLog.length,
      generatedWithCodex: exchangeLog.length > 0,
    };
  }
}
