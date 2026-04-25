import { markSessionSeen } from "../runtime/service-state.js";
import { cloneJson } from "../state/file-utils.js";
import { appendTopicHostSuffix, getHostRecordId } from "../hosts/topic-host.js";
import { createWorkspaceDiffArtifact } from "../workspace/diff-artifact.js";
import { resolveWorkspaceBinding } from "../workspace/binding-resolver.js";
import { getSessionKey, getTopicIdFromMessage } from "./session-key.js";

function buildGeneratedTopicName() {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  return `Codex ${timestamp} UTC`;
}

function normalizeTopicName(rawArgs) {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return buildGeneratedTopicName();
  }

  return trimmed.slice(0, 128);
}

function buildFallbackExecutionHost(config = {}) {
  const currentHostId = config?.currentHostId || "local";
  return {
    ok: true,
    hostId: currentHostId,
    hostLabel: currentHostId,
    lastReadyAt: new Date().toISOString(),
    failureReason: null,
  };
}

function buildExecutionHostUnavailableError(executionHost = {}) {
  const hostId = String(executionHost.hostId || "unknown").trim() || "unknown";
  const hostLabel = String(executionHost.hostLabel || hostId).trim() || hostId;
  const error = new Error(`Execution host unavailable: ${hostLabel}`);
  error.code = "EXECUTION_HOST_UNAVAILABLE";
  error.hostId = hostId;
  error.hostLabel = hostLabel;
  error.failureReason = executionHost.failureReason || "host-unavailable";
  return error;
}

export class SessionBindingService {
  constructor({
    sessionStore,
    config,
    runtimeObserver = null,
    hostRegistryService = null,
  }) {
    this.sessionStore = sessionStore;
    this.config = config;
    this.runtimeObserver = runtimeObserver;
    this.hostRegistryService = hostRegistryService;
    this.defaultBindingPromise = null;
  }

  async getDefaultBinding() {
    if (!this.defaultBindingPromise) {
      this.defaultBindingPromise = resolveWorkspaceBinding({
        workspaceRoot: this.config.workspaceRoot,
        requestedPath: this.config.defaultSessionBindingPath,
      }).catch((error) => {
        this.defaultBindingPromise = null;
        throw error;
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

  async resolveTopicCreationHost(executionHostId = null) {
    return typeof this.hostRegistryService?.resolveTopicCreationHost === "function"
      ? this.hostRegistryService.resolveTopicCreationHost(executionHostId)
      : buildFallbackExecutionHost(this.config);
  }

  async listTopicCreationHosts() {
    if (typeof this.hostRegistryService?.listTopicCreationHosts === "function") {
      return this.hostRegistryService.listTopicCreationHosts();
    }

    return [buildFallbackExecutionHost(this.config)];
  }

  async resolveSessionExecution(session) {
    return typeof this.hostRegistryService?.resolveSessionExecution === "function"
      ? this.hostRegistryService.resolveSessionExecution(session)
      : buildFallbackExecutionHost(this.config);
  }

  async listKnownExecutionHostIds() {
    if (typeof this.hostRegistryService?.listHosts === "function") {
      const hosts = await this.hostRegistryService.listHosts();
      return [...new Set(
        hosts
          .map((host) => getHostRecordId(host))
          .filter(Boolean),
      )];
    }

    const currentHostId = String(this.config?.currentHostId ?? "").trim().toLowerCase();
    return currentHostId ? [currentHostId] : [];
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

    const existingSession = await this.sessionStore.load(message.chat.id, topicId);
    const workspaceBinding = await this.getDefaultBinding();
    if (!existingSession) {
      return this.sessionStore.ensure({
        chatId: message.chat.id,
        topicId,
        workspaceBinding,
        createdVia: "topic/implicit-attach",
        executionHostId: null,
        executionHostLabel: null,
        executionHostBoundAt: null,
        executionHostLastReadyAt: null,
        executionHostLastFailure: "binding-missing",
        reactivate: false,
      });
    }

    const shouldBackfillExecutionHost =
      !existingSession.execution_host_id
      && existingSession.created_via !== "topic/implicit-attach";
    const executionHost = existingSession.execution_host_id
      ? await this.resolveTopicCreationHost(existingSession.execution_host_id)
      : shouldBackfillExecutionHost
        ? await this.resolveTopicCreationHost()
        : null;
    return this.sessionStore.ensure({
      chatId: message.chat.id,
      topicId,
      workspaceBinding,
      createdVia: reactivate ? "topic/reactivate" : "topic/implicit-attach",
      executionHostId: executionHost?.ok ? executionHost.hostId : null,
      executionHostLabel: executionHost?.ok ? executionHost.hostLabel : null,
      executionHostBoundAt: executionHost?.ok ? new Date().toISOString() : null,
      executionHostLastReadyAt:
        executionHost?.ok ? executionHost.lastReadyAt ?? null : null,
      executionHostLastFailure:
        executionHost?.ok ? null : executionHost?.failureReason ?? null,
      reactivate,
    });
  }

  async createTopicSession({
    api,
    executionHostId = null,
    message,
    title,
    uiLanguage = null,
    workspaceBinding,
    inheritedFromSessionKey,
  }) {
    const executionHost = await this.resolveTopicCreationHost(executionHostId);
    if (!executionHost?.ok) {
      throw buildExecutionHostUnavailableError(executionHost);
    }
    const knownHostIds = await this.listKnownExecutionHostIds();
    const topicName = appendTopicHostSuffix(
      normalizeTopicName(title),
      executionHost.hostId,
      128,
      knownHostIds,
    );
    const forumTopic = await api.createForumTopic({
      chat_id: message.chat.id,
      name: topicName,
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
      executionHostId: executionHost.hostId,
      executionHostLabel: executionHost.hostLabel,
      executionHostBoundAt: new Date().toISOString(),
      executionHostLastReadyAt: executionHost.lastReadyAt ?? null,
      executionHostLastFailure: null,
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
      config: this.config,
      hostRegistryService: this.hostRegistryService,
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
