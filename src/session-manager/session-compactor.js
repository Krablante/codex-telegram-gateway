import { createHostAwareRunTask } from "../pty-worker/host-aware-run-task.js";
import {
  buildEmptyGlobalCodexSettingsState,
  loadAvailableCodexModels,
  resolveCodexRuntimeProfile,
} from "./codex-runtime-settings.js";
import {
  buildEmptyBrief,
  isPersistedCompactionActive,
} from "./session-compactor/common.js";
import { generateBriefWithCodex } from "./session-compactor/codex-run.js";
import { buildCompactionSourceSelection } from "./session-compactor/source.js";

function parseTimestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function filterProgressNotesAfter(notes = [], consumedUntil = null) {
  const consumedMs = parseTimestampMs(consumedUntil);
  if (consumedMs === null) {
    return notes;
  }

  return notes.filter((entry) => {
    const createdMs = parseTimestampMs(entry?.created_at);
    return createdMs === null || createdMs > consumedMs;
  });
}

function getMaxProgressNoteTimestamp(notes = []) {
  let maxMs = null;
  let maxValue = null;
  for (const entry of notes) {
    const createdAt = typeof entry?.created_at === "string"
      ? entry.created_at
      : null;
    const createdMs = parseTimestampMs(createdAt);
    if (createdMs === null) {
      continue;
    }
    if (maxMs === null || createdMs > maxMs) {
      maxMs = createdMs;
      maxValue = createdAt;
    }
  }

  return maxValue;
}

export class SessionCompactor {
  constructor({
    sessionStore,
    config = null,
    globalCodexSettingsStore = null,
    hostRegistryService = null,
    runTask = createHostAwareRunTask({ config, hostRegistryService }),
  }) {
    this.sessionStore = sessionStore;
    this.config = config;
    this.globalCodexSettingsStore = globalCodexSettingsStore;
    this.hostRegistryService = hostRegistryService;
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
    if (Boolean(sessionKey) && this.activeCompactions.has(sessionKey)) {
      return true;
    }

    return isPersistedCompactionActive(
      typeof sessionOrKey === "string" ? null : sessionOrKey,
    );
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

    const compactionStartedAt = new Date().toISOString();
    const prepared = await this.sessionStore.patch(current, {
      compaction_in_progress: true,
      compaction_owner_generation_id: this.config?.serviceGenerationId ?? null,
      compaction_started_at: compactionStartedAt,
    });

    try {
      const exchangeLog = await this.sessionStore.loadExchangeLog(prepared);
      const progressNotes = filterProgressNotesAfter(
        await this.sessionStore.loadProgressNotes(prepared, { limit: null }),
        prepared.progress_notes_consumed_until,
      );
      const updatedAt = new Date().toISOString();
      const activeBriefBaseline = await this.sessionStore.loadActiveBrief(prepared);
      const exchangeLogPath = this.sessionStore.getExchangeLogPath(
        prepared.chat_id,
        prepared.topic_id,
      );
      const hasCompactionSource =
        exchangeLog.length > 0 || progressNotes.length > 0;
      let sourceSelection = null;
      const activeBrief =
        !hasCompactionSource
          ? buildEmptyBrief(prepared, { reason, updatedAt })
          : await (async () => {
              sourceSelection = await buildCompactionSourceSelection({
                  activeBrief: activeBriefBaseline,
                  exchangeLog,
                  exchangeLogPath,
                  progressNotes,
                  reason,
                  session: prepared,
                  sessionStore: this.sessionStore,
                });
              return generateBriefWithCodex({
                config: this.config,
                runtimeProfile: await this.loadCompactRuntimeProfile(),
                reason,
                runTask: this.runTask,
                session: prepared,
                primarySource: sourceSelection.primarySource,
                fallbackSource: sourceSelection.fallbackSource,
              });
            })();
      const progressNotesConsumedUntil =
        progressNotes.length > 0
        && (sourceSelection?.primarySource?.omittedProgressNotes ?? 0) === 0
          ? getMaxProgressNoteTimestamp(progressNotes)
          : null;

      await this.sessionStore.writeSessionText(prepared, "active-brief.md", activeBrief);
      await this.sessionStore.removeLegacyMemoryFiles(prepared);
      const updated = await this.sessionStore.patch(prepared, {
        compaction_in_progress: false,
        compaction_owner_generation_id: null,
        compaction_started_at: null,
        last_compacted_at: updatedAt,
        last_compaction_reason: reason,
        exchange_log_entries: exchangeLog.length,
        provider_session_id: null,
        codex_thread_id: null,
        codex_thread_model: null,
        codex_thread_reasoning_effort: null,
        codex_rollout_path: null,
        last_context_snapshot: null,
        last_token_usage: null,
        last_run_status: null,
        last_run_model: null,
        last_run_reasoning_effort: null,
        session_owner_generation_id: null,
        session_owner_mode: null,
        session_owner_claimed_at: null,
        spike_run_owner_generation_id: null,
        last_run_started_at: null,
        last_run_finished_at: null,
        last_progress_message_id: null,
        ...(progressNotesConsumedUntil
          ? { progress_notes_consumed_until: progressNotesConsumedUntil }
          : {}),
      });

      return {
        session: updated,
        reason,
        activeBrief,
        exchangeLogEntries: exchangeLog.length,
        progressNoteEntries: progressNotes.length,
        generatedWithCodex: hasCompactionSource,
      };
    } catch (error) {
      await this.sessionStore.patch(prepared, {
        compaction_in_progress: false,
        compaction_owner_generation_id: null,
        compaction_started_at: null,
      }).catch(() => null);
      throw error;
    }
  }
}
