import { markSessionSeen } from "../runtime/service-state.js";
import { ingestIncomingAttachments } from "../telegram/incoming-attachments.js";
import { createWorkspaceDiffArtifact } from "../workspace/diff-artifact.js";
import { resolveWorkspaceBinding } from "../workspace/binding-resolver.js";
import { normalizeUiLanguage } from "../i18n/ui-language.js";
import {
  buildDefaultAutoModeState,
  normalizeAutoModeState,
  normalizeGoalInterpretation,
} from "./auto-mode.js";
import {
  buildEmptyGlobalCodexSettingsState,
  getGlobalRuntimeSettingFieldName,
  getSessionRuntimeSettingFieldName,
  loadAvailableCodexModels,
  resolveCodexRuntimeProfile,
} from "./codex-runtime-settings.js";
import {
  buildLegacyContextSnapshot,
  normalizeContextSnapshot,
  readLatestContextSnapshot,
} from "./context-snapshot.js";
import { drainPendingSpikePromptQueue } from "./prompt-queue.js";
import { normalizePromptSuffixText } from "./prompt-suffix.js";
import { getSessionKey, getTopicIdFromMessage } from "./session-key.js";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function appendUserInput(existingInput, nextInput) {
  const base = String(existingInput || "").trim();
  const next = String(nextInput || "").trim();
  if (!base) {
    return next || null;
  }
  if (!next) {
    return base;
  }

  return `${base}\n\n${next}`;
}

function buildGeneratedTopicName() {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  return `Codex ${timestamp} UTC`;
}

const DEFAULT_PENDING_PROMPT_ATTACHMENT_TTL_MS = 15 * 60 * 1000;

function resolvePendingAttachmentFieldNames(scope = "prompt") {
  return scope === "queue"
    ? {
        attachments: "pending_queue_attachments",
        expiresAt: "pending_queue_attachments_expires_at",
      }
    : {
        attachments: "pending_prompt_attachments",
        expiresAt: "pending_prompt_attachments_expires_at",
      };
}

function normalizeTopicName(rawArgs) {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return buildGeneratedTopicName();
  }

  return trimmed.slice(0, 128);
}

function normalizePendingPromptAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .filter((attachment) => attachment && typeof attachment === "object")
    .map((attachment) => cloneJson(attachment));
}

function readPendingPromptAttachmentsState(sessionLike, scope = "prompt") {
  const fields = resolvePendingAttachmentFieldNames(scope);
  const attachments = normalizePendingPromptAttachments(sessionLike?.[fields.attachments]);
  const expiresAt =
    typeof sessionLike?.[fields.expiresAt] === "string" &&
    sessionLike[fields.expiresAt].trim()
      ? sessionLike[fields.expiresAt]
      : null;
  if (!expiresAt || attachments.length === 0) {
    return {
      attachments: [],
      expiresAt: null,
      expired: false,
    };
  }

  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return {
      attachments: [],
      expiresAt: null,
      expired: attachments.length > 0,
    };
  }

  if (expiresAtMs <= Date.now()) {
    return {
      attachments: [],
      expiresAt,
      expired: attachments.length > 0,
    };
  }

  return {
    attachments,
    expiresAt,
    expired: false,
  };
}

export class SessionService {
  constructor({
    sessionStore,
    config,
    sessionCompactor = null,
    runtimeObserver = null,
    globalPromptSuffixStore = null,
    globalCodexSettingsStore = null,
    promptQueueStore = null,
  }) {
    this.sessionStore = sessionStore;
    this.config = config;
    this.sessionCompactor = sessionCompactor;
    this.runtimeObserver = runtimeObserver;
    this.globalPromptSuffixStore = globalPromptSuffixStore;
    this.globalCodexSettingsStore = globalCodexSettingsStore;
    this.promptQueueStore = promptQueueStore;
    this.defaultBindingPromise = null;
  }

  async getDefaultBinding() {
    if (!this.defaultBindingPromise) {
      this.defaultBindingPromise = resolveWorkspaceBinding({
        workspaceRoot: this.config.workspaceRoot,
        requestedPath: this.config.defaultSessionBindingPath,
      });
    }

    return this.defaultBindingPromise;
  }

  async resolveBindingPath(requestedPath) {
    return resolveWorkspaceBinding({
      workspaceRoot: this.config.workspaceRoot,
      requestedPath,
    });
  }

  async ensureSessionForMessage(message) {
    return this.ensureSessionForMessageInternal(message, { reactivate: false });
  }

  async ensureRunnableSessionForMessage(message) {
    return this.ensureSessionForMessageInternal(message, { reactivate: true });
  }

  async ensureSessionForMessageInternal(message, { reactivate }) {
    const topicId = getTopicIdFromMessage(message);
    if (!topicId) {
      return null;
    }

    const workspaceBinding = await this.getDefaultBinding();
    return this.sessionStore.ensure({
      chatId: message.chat.id,
      topicId,
      workspaceBinding,
      createdVia: reactivate ? "topic/reactivate" : "topic/auto-attach",
      reactivate,
    });
  }

  async createTopicSession({
    api,
    message,
    title,
    uiLanguage = null,
    workspaceBinding,
    inheritedFromSessionKey,
  }) {
    const forumTopic = await api.createForumTopic({
      chat_id: message.chat.id,
      name: normalizeTopicName(title),
    });
    const resolvedBinding = workspaceBinding || (await this.getDefaultBinding());
    const session = await this.sessionStore.ensure({
      chatId: message.chat.id,
      topicId: forumTopic.message_thread_id,
      topicName: forumTopic.name,
      uiLanguage,
      workspaceBinding: resolvedBinding,
      createdVia: "command/new",
      inheritedFromSessionKey,
    });

    return {
      forumTopic,
      session,
    };
  }

  async resolveInheritedBinding(message) {
    const currentSession = await this.ensureSessionForMessage(message);
    if (!currentSession) {
      return {
        binding: cloneJson(await this.getDefaultBinding()),
        inheritedFromSessionKey: null,
      };
    }

    return {
      binding: cloneJson(currentSession.workspace_binding),
      inheritedFromSessionKey: currentSession.session_key,
      inheritedFromSession: currentSession,
    };
  }

  async recordHandledSession(serviceState, session, commandName) {
    const updated = await this.sessionStore.touchCommand(session, commandName);
    markSessionSeen(serviceState, updated.session_key);
    return updated;
  }

  async createDiffArtifact(session) {
    return createWorkspaceDiffArtifact({
      session,
      sessionStore: this.sessionStore,
    });
  }

  async ingestIncomingAttachments(api, session, message) {
    return ingestIncomingAttachments({
      api,
      message,
      session,
      sessionStore: this.sessionStore,
    });
  }

  async bufferPendingPromptAttachments(
    session,
    attachments,
    {
      scope = "prompt",
      ttlMs = DEFAULT_PENDING_PROMPT_ATTACHMENT_TTL_MS,
    } = {},
  ) {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    const pendingState = readPendingPromptAttachmentsState(current, scope);
    const nextAttachments = [
      ...pendingState.attachments,
      ...normalizePendingPromptAttachments(attachments),
    ];
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const fields = resolvePendingAttachmentFieldNames(scope);

    return this.sessionStore.patch(current, {
      [fields.attachments]: nextAttachments,
      [fields.expiresAt]: nextAttachments.length > 0 ? expiresAt : null,
    });
  }

  async getPendingPromptAttachments(session, { scope = "prompt" } = {}) {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    const pendingState = readPendingPromptAttachmentsState(current, scope);
    if (!pendingState.expired) {
      return pendingState.attachments;
    }

    const fields = resolvePendingAttachmentFieldNames(scope);
    await this.sessionStore.patch(current, {
      [fields.attachments]: [],
      [fields.expiresAt]: null,
    });
    return [];
  }

  async clearPendingPromptAttachments(session, { scope = "prompt" } = {}) {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    const fields = resolvePendingAttachmentFieldNames(scope);
    return this.sessionStore.patch(current, {
      [fields.attachments]: [],
      [fields.expiresAt]: null,
    });
  }

  async listPromptQueue(session) {
    if (!this.promptQueueStore) {
      return [];
    }

    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    return this.promptQueueStore.load(current);
  }

  async enqueuePromptQueue(session, payload) {
    if (!this.promptQueueStore) {
      throw new Error("Prompt queue store is not configured");
    }

    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    return this.promptQueueStore.enqueue(current, payload);
  }

  async deletePromptQueueEntry(session, position) {
    if (!this.promptQueueStore) {
      return {
        entry: null,
        position: null,
        size: 0,
      };
    }

    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    return this.promptQueueStore.deleteAt(current, position);
  }

  async drainPromptQueue(workerPool, { session = null } = {}) {
    if (!this.promptQueueStore) {
      return [];
    }

    return drainPendingSpikePromptQueue({
      session,
      sessionStore: this.sessionStore,
      workerPool,
      promptQueueStore: this.promptQueueStore,
    });
  }

  async purgeSession(session, reason = "command/purge") {
    await this.sessionStore.park(session, reason);
    const purged = await this.sessionStore.purge(session, reason);
    await this.runtimeObserver?.noteSessionLifecycle({
      action: "purged",
      session: purged,
      reason,
      previousState: session.lifecycle_state,
      nextState: purged.lifecycle_state,
      trigger: "command",
    });
    return purged;
  }

  async compactSession(session, reason = "command/compact") {
    if (!this.sessionCompactor) {
      throw new Error("Session compactor is not configured");
    }

    return this.sessionCompactor.compact(session, { reason });
  }

  isCompacting(session) {
    return this.sessionCompactor?.isCompacting(session) ?? false;
  }

  async updatePromptSuffix(
    session,
    {
      text = session.prompt_suffix_text ?? null,
      enabled = session.prompt_suffix_enabled ?? false,
    } = {},
  ) {
    return this.sessionStore.patch(session, {
      prompt_suffix_text: normalizePromptSuffixText(text),
      prompt_suffix_enabled: Boolean(enabled),
    });
  }

  async clearPromptSuffix(session) {
    return this.sessionStore.patch(session, {
      prompt_suffix_text: null,
      prompt_suffix_enabled: false,
    });
  }

  async updatePromptSuffixTopicState(
    session,
    { enabled = session.prompt_suffix_topic_enabled !== false } = {},
  ) {
    return this.sessionStore.patch(session, {
      prompt_suffix_topic_enabled: Boolean(enabled),
    });
  }

  async updateUiLanguage(session, { language = session.ui_language } = {}) {
    return this.sessionStore.patch(session, {
      ui_language: normalizeUiLanguage(language),
    });
  }

  async getGlobalPromptSuffix() {
    if (!this.globalPromptSuffixStore) {
      return {
        prompt_suffix_text: null,
        prompt_suffix_enabled: false,
      };
    }

    return this.globalPromptSuffixStore.load();
  }

  async updateGlobalPromptSuffix({
    text,
    enabled,
  } = {}) {
    const current = await this.getGlobalPromptSuffix();
    if (!this.globalPromptSuffixStore) {
      const suffixText = normalizePromptSuffixText(
        text ?? current.prompt_suffix_text ?? null,
      );

      return {
        updated_at: current.updated_at ?? null,
        prompt_suffix_text: suffixText,
        prompt_suffix_enabled: Boolean(enabled ?? current.prompt_suffix_enabled) && Boolean(suffixText),
      };
    }

    return this.globalPromptSuffixStore.patch({
      prompt_suffix_text: normalizePromptSuffixText(
        text ?? current.prompt_suffix_text ?? null,
      ),
      prompt_suffix_enabled: Boolean(enabled ?? current.prompt_suffix_enabled),
    });
  }

  async clearGlobalPromptSuffix() {
    if (!this.globalPromptSuffixStore) {
      return {
        updated_at: null,
        prompt_suffix_text: null,
        prompt_suffix_enabled: false,
      };
    }

    return this.globalPromptSuffixStore.patch({
      prompt_suffix_text: null,
      prompt_suffix_enabled: false,
    });
  }

  async getGlobalCodexSettings() {
    if (!this.globalCodexSettingsStore) {
      return buildEmptyGlobalCodexSettingsState();
    }

    return this.globalCodexSettingsStore.load({ force: true });
  }

  async updateGlobalCodexSetting(target, kind, value) {
    const fieldName = getGlobalRuntimeSettingFieldName(target, kind);
    if (!fieldName) {
      throw new Error(`Unsupported global Codex setting target=${target} kind=${kind}`);
    }

    if (!this.globalCodexSettingsStore) {
      return {
        ...(await this.getGlobalCodexSettings()),
        [fieldName]: value,
      };
    }

    return this.globalCodexSettingsStore.patch({
      [fieldName]: value,
    });
  }

  async clearGlobalCodexSetting(target, kind) {
    return this.updateGlobalCodexSetting(target, kind, null);
  }

  async updateSessionCodexSetting(session, target, kind, value) {
    const fieldName = getSessionRuntimeSettingFieldName(target, kind);
    if (!fieldName) {
      throw new Error(`Unsupported session Codex setting target=${target} kind=${kind}`);
    }

    return this.sessionStore.patch(session, {
      [fieldName]: value,
    });
  }

  async clearSessionCodexSetting(session, target, kind) {
    return this.updateSessionCodexSetting(session, target, kind, null);
  }

  async resolveCodexRuntimeProfile(session, { target = "spike" } = {}) {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    const globalSettings = await this.getGlobalCodexSettings();
    const availableModels = await loadAvailableCodexModels({
      configPath: this.config.codexConfigPath,
    });
    return resolveCodexRuntimeProfile({
      session: current,
      globalSettings,
      config: this.config,
      target,
      availableModels,
    });
  }

  async resolveContextSnapshot(
    session,
    {
      threadId = session.codex_thread_id ?? null,
      rolloutPath = session.codex_rollout_path ?? null,
    } = {},
  ) {
    const storedSnapshot = normalizeContextSnapshot(session.last_context_snapshot);

    if (threadId && this.config.codexSessionsRoot) {
      const resolved = await readLatestContextSnapshot({
        threadId,
        sessionsRoot: this.config.codexSessionsRoot,
        knownRolloutPath: rolloutPath || storedSnapshot?.rollout_path || null,
      });

      if (resolved.snapshot) {
        const patch = {};
        const normalizedStoredUsage = JSON.stringify(
          storedSnapshot?.last_token_usage ?? null,
        );
        const normalizedNextUsage = JSON.stringify(
          resolved.snapshot.last_token_usage ?? null,
        );

        if (resolved.rolloutPath && resolved.rolloutPath !== session.codex_rollout_path) {
          patch.codex_rollout_path = resolved.rolloutPath;
        }
        if (
          JSON.stringify(storedSnapshot) !== JSON.stringify(resolved.snapshot)
        ) {
          patch.last_context_snapshot = resolved.snapshot;
        }
        if (normalizedStoredUsage !== normalizedNextUsage) {
          patch.last_token_usage = resolved.snapshot.last_token_usage;
        }

        if (Object.keys(patch).length > 0) {
          return {
            session: await this.sessionStore.patch(session, patch),
            snapshot: resolved.snapshot,
          };
        }

        return {
          session,
          snapshot: resolved.snapshot,
        };
      }
    }

    return {
      session,
      snapshot:
        storedSnapshot ??
        buildLegacyContextSnapshot({
          usage: session.last_token_usage,
          contextWindow: this.config.codexContextWindow ?? null,
        }),
    };
  }

  getAutoMode(session) {
    return normalizeAutoModeState(session?.auto_mode);
  }

  async loadCurrentAutoMode(session) {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    return {
      session: current,
      autoMode: normalizeAutoModeState(current.auto_mode),
    };
  }

  async updateAutoMode(session, patch = {}) {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    const previous = normalizeAutoModeState(current.auto_mode);
    const now = new Date().toISOString();
    const next = normalizeAutoModeState({
      ...previous,
      ...cloneJson(patch),
      updated_at: now,
      last_state_changed_at:
        patch.phase && patch.phase !== previous.phase
          ? now
          : previous.last_state_changed_at ?? now,
    });

    if (!next.enabled) {
      next.phase = "off";
    }

    return this.sessionStore.patch(current, {
      auto_mode: next,
    });
  }

  async activateAutoMode(session, {
    activatedByUserId = null,
    omniBotId = null,
    spikeBotId = null,
  } = {}) {
    const now = new Date().toISOString();
    return this.updateAutoMode(session, {
      ...buildDefaultAutoModeState(),
      enabled: true,
      phase: "await_goal",
      activated_at: now,
      last_state_changed_at: now,
      updated_at: now,
      activated_by_user_id: activatedByUserId,
      omni_bot_id: omniBotId,
      spike_bot_id: spikeBotId,
    });
  }

  async clearAutoMode(session) {
    return this.updateAutoMode(session, buildDefaultAutoModeState());
  }

  async captureAutoGoal(session, literalGoalText) {
    const { session: currentSession, autoMode: currentAutoMode } =
      await this.loadCurrentAutoMode(session);
    return this.updateAutoMode(currentSession, {
      ...currentAutoMode,
      enabled: true,
      phase: "await_initial_prompt",
      literal_goal_text: String(literalGoalText || "").trim() || null,
      normalized_goal_interpretation: normalizeGoalInterpretation(
        literalGoalText,
      ),
      blocked_reason: null,
      pending_user_input: null,
    });
  }

  async captureAutoInitialPrompt(session, initialWorkerPrompt) {
    const { session: currentSession, autoMode: currentAutoMode } =
      await this.loadCurrentAutoMode(session);
    return this.updateAutoMode(currentSession, {
      ...currentAutoMode,
      enabled: true,
      phase: "await_initial_prompt",
      initial_worker_prompt: String(initialWorkerPrompt || "").trim() || null,
      blocked_reason: null,
      pending_user_input: null,
      last_result_summary: null,
    });
  }

  async queueAutoUserInput(session, userInput) {
    const { session: currentSession, autoMode: currentAutoMode } =
      await this.loadCurrentAutoMode(session);
    return this.updateAutoMode(currentSession, {
      ...currentAutoMode,
      pending_user_input: appendUserInput(
        currentAutoMode.pending_user_input,
        userInput,
      ),
      blocked_reason:
        currentAutoMode.phase === "blocked"
          ? currentAutoMode.blocked_reason
          : null,
    });
  }

  async scheduleAutoSleep(session, {
    sleepMinutes,
    nextPrompt,
    resultSummary = null,
    clearPendingUserInput = true,
  } = {}) {
    const { session: currentSession, autoMode: currentAutoMode } =
      await this.loadCurrentAutoMode(session);
    const wakeAt = new Date(Date.now() + (sleepMinutes * 60 * 1000)).toISOString();
    return this.updateAutoMode(currentSession, {
      ...currentAutoMode,
      phase: "sleeping",
      sleep_until: wakeAt,
      sleep_next_prompt: String(nextPrompt || "").trim() || null,
      blocked_reason: null,
      last_result_summary: resultSummary,
      last_evaluated_exchange_log_entries:
        currentAutoMode.last_spike_exchange_log_entries,
      pending_user_input: clearPendingUserInput
        ? null
        : currentAutoMode.pending_user_input,
    });
  }

  async markAutoSpikeFinal(
    session,
    {
      messageId = null,
      exchangeLogEntries = 0,
      summary = null,
    } = {},
  ) {
    const { session: currentSession, autoMode: currentAutoMode } =
      await this.loadCurrentAutoMode(session);
    if (!currentAutoMode.enabled) {
      return currentSession;
    }

    return this.updateAutoMode(currentSession, {
      ...currentAutoMode,
      phase: "evaluating",
      last_spike_final_message_id: messageId,
      last_spike_exchange_log_entries: exchangeLogEntries,
      last_result_summary: summary,
    });
  }

  async markAutoDecision(session, {
    phase,
    blockedReason = null,
    resultSummary = null,
    incrementContinuation = false,
    clearPendingUserInput = false,
  } = {}) {
    const { session: currentSession, autoMode: currentAutoMode } =
      await this.loadCurrentAutoMode(session);
    return this.updateAutoMode(currentSession, {
      ...currentAutoMode,
      enabled: phase !== "off",
      phase,
      blocked_reason: blockedReason,
      last_result_summary: resultSummary,
      last_evaluated_exchange_log_entries:
        currentAutoMode.last_spike_exchange_log_entries,
      continuation_count: incrementContinuation
        ? currentAutoMode.continuation_count + 1
        : currentAutoMode.continuation_count,
      pending_user_input: clearPendingUserInput
        ? null
        : currentAutoMode.pending_user_input,
    });
  }

  getSessionKeyForMessage(message) {
    const topicId = getTopicIdFromMessage(message);
    if (!topicId) {
      return null;
    }

    return getSessionKey(message.chat.id, topicId);
  }
}
