import { runCodexTask } from "../pty-worker/codex-runner.js";
import { normalizeAutoModeState } from "./auto-mode.js";
import {
  buildEmptyGlobalCodexSettingsState,
  loadAvailableCodexModels,
  resolveCodexRuntimeProfile,
} from "./codex-runtime-settings.js";

const MAX_SUMMARIZER_RETRIES = 1;
const COMPACTION_APP_SERVER_BOOT_TIMEOUT_MS = 60000;
const COMPACTION_ROLLOUT_DISCOVERY_TIMEOUT_MS = 30000;
const COMPACTION_ROLLOUT_STALL_AFTER_CHILD_EXIT_MS = 30000;

function buildEmptyBrief(session, { reason, updatedAt }) {
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

function buildCompactionPrompt(session, { reason, exchangeLogEntries, exchangeLogPath }) {
  const lines = [
    "You are generating active-brief.md for a Telegram Codex session recovery flow.",
    "The exchange log file contains only user prompts and final agent replies.",
    "Write a dense but readable markdown brief that lets a fresh Codex run continue work without rereading the full exchange log.",
    "",
    "Rules:",
    "- Output only markdown for active-brief.md.",
    "- Start with '# Active brief'.",
    "- Be concrete, practical, and continuity-first.",
    "- Preserve enough context for the next run to understand where it is working, what was happening, what was just said, and what still needs to be done.",
    "- Do not mention hidden reasoning, chain-of-thought, tools, or process chatter.",
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
    "## User preferences",
    "## Current state",
    "## Completed work",
    "## Open work",
    "## Latest exchange",
    "",
    "Section guidance:",
    "- Workspace context: where work is happening, which repo/path/module matters, and any environment/runtime facts the next run should know immediately.",
    "- User preferences: durable style, workflow, autonomy, safety, or delivery preferences that keep showing up in the log.",
    "- Current state: what the session was recently doing, latest meaningful outcome, and any active constraints or blockers.",
    "- Completed work: concrete fixes, decisions, or verified outcomes already achieved.",
    "- Open work: unresolved tasks, next likely moves, and unfinished threads that should not be forgotten.",
    "- Latest exchange: capture the latest user ask and the latest assistant outcome in concrete terms.",
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
  runtimeProfile,
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
        model: runtimeProfile?.model ?? null,
        reasoningEffort: runtimeProfile?.reasoningEffort ?? null,
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
    globalCodexSettingsStore = null,
    runTask = runCodexTask,
  }) {
    this.sessionStore = sessionStore;
    this.config = config;
    this.globalCodexSettingsStore = globalCodexSettingsStore;
    this.runTask = runTask;
    this.activeCompactions = new Map();
  }

  async loadCompactRuntimeProfile() {
    const availableModels = await loadAvailableCodexModels({
      configPath: this.config?.codexConfigPath,
    });
    const globalSettings = this.globalCodexSettingsStore
      ? await this.globalCodexSettingsStore.load({ force: true })
      : buildEmptyGlobalCodexSettingsState();

    return resolveCodexRuntimeProfile({
      session: null,
      globalSettings,
      config: this.config,
      target: "compact",
      availableModels,
    });
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
            runtimeProfile: await this.loadCompactRuntimeProfile(),
            reason,
            runTask: this.runTask,
            session: current,
          });

    await this.sessionStore.writeSessionText(current, "active-brief.md", activeBrief);
    await this.sessionStore.removeLegacyMemoryFiles(current);
    const currentAutoMode = normalizeAutoModeState(current.auto_mode);
    const nextAutoMode = currentAutoMode.enabled
      ? {
          ...currentAutoMode,
          continuation_count_since_compact: 0,
          updated_at: updatedAt,
          last_auto_compact_at: String(reason || "").startsWith("auto-compact:")
            ? updatedAt
            : currentAutoMode.last_auto_compact_at,
        }
      : currentAutoMode;
    const updated = await this.sessionStore.patch(current, {
      last_compacted_at: updatedAt,
      last_compaction_reason: reason,
      exchange_log_entries: exchangeLog.length,
      provider_session_id: null,
      codex_thread_id: null,
      codex_rollout_path: null,
      last_context_snapshot: null,
      last_token_usage: null,
      auto_mode: nextAutoMode,
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
