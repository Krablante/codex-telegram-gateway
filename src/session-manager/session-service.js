import { markSessionSeen } from "../runtime/service-state.js";
import { ingestIncomingAttachments } from "../telegram/incoming-attachments.js";
import { createWorkspaceDiffArtifact } from "../workspace/diff-artifact.js";
import { resolveWorkspaceBinding } from "../workspace/binding-resolver.js";
import { normalizeUiLanguage } from "../i18n/ui-language.js";
import {
  buildLegacyContextSnapshot,
  normalizeContextSnapshot,
  readLatestContextSnapshot,
} from "./context-snapshot.js";
import { normalizePromptSuffixText } from "./prompt-suffix.js";
import { getSessionKey, getTopicIdFromMessage } from "./session-key.js";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildGeneratedTopicName() {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  return `Codex ${timestamp} UTC`;
}

const DEFAULT_PENDING_PROMPT_ATTACHMENT_TTL_MS = 15 * 60 * 1000;

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

function readPendingPromptAttachmentsState(sessionLike) {
  const attachments = normalizePendingPromptAttachments(
    sessionLike?.pending_prompt_attachments,
  );
  const expiresAt =
    typeof sessionLike?.pending_prompt_attachments_expires_at === "string" &&
    sessionLike.pending_prompt_attachments_expires_at.trim()
      ? sessionLike.pending_prompt_attachments_expires_at
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
  }) {
    this.sessionStore = sessionStore;
    this.config = config;
    this.sessionCompactor = sessionCompactor;
    this.runtimeObserver = runtimeObserver;
    this.globalPromptSuffixStore = globalPromptSuffixStore;
    this.defaultBindingPromise = null;
  }

  async getDefaultBinding() {
    if (!this.defaultBindingPromise) {
      this.defaultBindingPromise = resolveWorkspaceBinding({
        workspaceRoot: this.config.workspaceRoot ?? this.config.atlasWorkspaceRoot,
        requestedPath: this.config.defaultSessionBindingPath,
      });
    }

    return this.defaultBindingPromise;
  }

  async resolveBindingPath(requestedPath) {
    return resolveWorkspaceBinding({
      workspaceRoot: this.config.workspaceRoot ?? this.config.atlasWorkspaceRoot,
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
    { ttlMs = DEFAULT_PENDING_PROMPT_ATTACHMENT_TTL_MS } = {},
  ) {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    const pendingState = readPendingPromptAttachmentsState(current);
    const nextAttachments = [
      ...pendingState.attachments,
      ...normalizePendingPromptAttachments(attachments),
    ];
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    return this.sessionStore.patch(current, {
      pending_prompt_attachments: nextAttachments,
      pending_prompt_attachments_expires_at: nextAttachments.length > 0
        ? expiresAt
        : null,
    });
  }

  async getPendingPromptAttachments(session) {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    const pendingState = readPendingPromptAttachmentsState(current);
    if (!pendingState.expired) {
      return pendingState.attachments;
    }

    await this.sessionStore.patch(current, {
      pending_prompt_attachments: [],
      pending_prompt_attachments_expires_at: null,
    });
    return [];
  }

  async clearPendingPromptAttachments(session) {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    return this.sessionStore.patch(current, {
      pending_prompt_attachments: [],
      pending_prompt_attachments_expires_at: null,
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

  getSessionKeyForMessage(message) {
    const topicId = getTopicIdFromMessage(message);
    if (!topicId) {
      return null;
    }

    return getSessionKey(message.chat.id, topicId);
  }
}
