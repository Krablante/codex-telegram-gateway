import { SessionAttachmentService } from "./session-attachment-service.js";
import { SessionBindingService } from "./session-binding-service.js";
import { SessionCodexRuntimeService } from "./session-codex-runtime-service.js";
import { SessionContextService } from "./session-context-service.js";
import { SessionPromptQueueService } from "./session-prompt-queue-service.js";
import { SessionPromptSurfaceService } from "./session-prompt-surface-service.js";

export class SessionService {
  constructor({
    sessionStore,
    config,
    sessionCompactor = null,
    runtimeObserver = null,
    globalPromptSuffixStore = null,
    globalCodexSettingsStore = null,
    promptQueueStore = null,
    codexLimitsService = null,
    hostRegistryService = null,
  }) {
    this.sessionStore = sessionStore;
    this.config = config;
    this.sessionCompactor = sessionCompactor;
    this.runtimeObserver = runtimeObserver;
    this.bindingService = new SessionBindingService({
      sessionStore,
      config,
      runtimeObserver,
      hostRegistryService,
    });
    this.attachmentService = new SessionAttachmentService({ sessionStore });
    this.promptQueueService = new SessionPromptQueueService({
      sessionStore,
      promptQueueStore,
    });
    this.promptSurfaceService = new SessionPromptSurfaceService({
      sessionStore,
      globalPromptSuffixStore,
    });
    this.codexRuntimeService = new SessionCodexRuntimeService({
      sessionStore,
      config,
      globalCodexSettingsStore,
      codexLimitsService,
      hostRegistryService,
    });
    this.contextService = new SessionContextService({
      sessionStore,
      config,
    });
  }

  async getDefaultBinding() {
    return this.bindingService.getDefaultBinding();
  }

  async resolveBindingPath(requestedPath) {
    return this.bindingService.resolveBindingPath(requestedPath);
  }

  async resolveTopicCreationHost(executionHostId = null) {
    return this.bindingService.resolveTopicCreationHost(executionHostId);
  }

  async listTopicCreationHosts() {
    return this.bindingService.listTopicCreationHosts();
  }

  async resolveSessionExecution(session) {
    return this.bindingService.resolveSessionExecution(session);
  }

  async listKnownExecutionHostIds() {
    return this.bindingService.listKnownExecutionHostIds();
  }

  async ensureSessionForMessage(message) {
    return this.bindingService.ensureSessionForMessage(message);
  }

  async ensureRunnableSessionForMessage(message) {
    return this.bindingService.ensureRunnableSessionForMessage(message);
  }

  async createTopicSession(options) {
    return this.bindingService.createTopicSession(options);
  }

  async resolveInheritedBinding(message) {
    return this.bindingService.resolveInheritedBinding(message);
  }

  async recordHandledSession(serviceState, session, commandName) {
    return this.bindingService.recordHandledSession(serviceState, session, commandName);
  }

  async createDiffArtifact(session) {
    return this.bindingService.createDiffArtifact(session);
  }

  async ingestIncomingAttachments(api, session, message) {
    return this.attachmentService.ingestIncomingAttachments(api, session, message);
  }

  async bufferPendingPromptAttachments(session, attachments, options) {
    return this.attachmentService.bufferPendingPromptAttachments(
      session,
      attachments,
      options,
    );
  }

  async getPendingPromptAttachments(session, options) {
    return this.attachmentService.getPendingPromptAttachments(session, options);
  }

  async clearPendingPromptAttachments(session, options) {
    return this.attachmentService.clearPendingPromptAttachments(session, options);
  }

  async listPromptQueue(session) {
    return this.promptQueueService.listPromptQueue(session);
  }

  async enqueuePromptQueue(session, payload) {
    return this.promptQueueService.enqueuePromptQueue(session, payload);
  }

  async deletePromptQueueEntry(session, position) {
    return this.promptQueueService.deletePromptQueueEntry(session, position);
  }

  async drainPromptQueue(workerPool, options) {
    return this.promptQueueService.drainPromptQueue(workerPool, options);
  }

  async purgeSession(session, reason = "command/purge") {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    const purged = await this.sessionStore.purge(current, reason);
    await this.runtimeObserver?.noteSessionLifecycle({
      action: "purged",
      session: purged,
      reason,
      previousState: current.lifecycle_state,
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

  async isCompacting(session) {
    if (!this.sessionCompactor || !session?.chat_id || !session?.topic_id) {
      return false;
    }

    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    return this.sessionCompactor.isCompacting(current);
  }

  async updatePromptSuffix(session, options) {
    return this.promptSurfaceService.updatePromptSuffix(session, options);
  }

  async clearPromptSuffix(session) {
    return this.promptSurfaceService.clearPromptSuffix(session);
  }

  async updatePromptSuffixTopicState(session, options) {
    return this.promptSurfaceService.updatePromptSuffixTopicState(session, options);
  }

  async updateUiLanguage(session, options) {
    return this.promptSurfaceService.updateUiLanguage(session, options);
  }

  async getGlobalPromptSuffix() {
    return this.promptSurfaceService.getGlobalPromptSuffix();
  }

  async updateGlobalPromptSuffix(options) {
    return this.promptSurfaceService.updateGlobalPromptSuffix(options);
  }

  async clearGlobalPromptSuffix() {
    return this.promptSurfaceService.clearGlobalPromptSuffix();
  }

  async getGlobalCodexSettings() {
    return this.codexRuntimeService.getGlobalCodexSettings();
  }

  async loadAvailableCodexModels(session = null) {
    return this.codexRuntimeService.loadAvailableCodexModels(session);
  }

  async loadVisibleCodexModels(session = null) {
    return this.codexRuntimeService.loadVisibleCodexModels(session);
  }

  async clearIncompatibleGlobalReasoningSetting(target, globalSettings) {
    return this.codexRuntimeService.clearIncompatibleGlobalReasoningSetting(target, globalSettings);
  }

  async clearIncompatibleSessionReasoningSetting(session, target) {
    return this.codexRuntimeService.clearIncompatibleSessionReasoningSetting(session, target);
  }

  async updateGlobalCodexSetting(target, kind, value) {
    return this.codexRuntimeService.updateGlobalCodexSetting(target, kind, value);
  }

  async clearGlobalCodexSetting(target, kind) {
    return this.codexRuntimeService.clearGlobalCodexSetting(target, kind);
  }

  async updateSessionCodexSetting(session, target, kind, value) {
    return this.codexRuntimeService.updateSessionCodexSetting(session, target, kind, value);
  }

  async clearSessionCodexSetting(session, target, kind) {
    return this.codexRuntimeService.clearSessionCodexSetting(session, target, kind);
  }

  async resolveCodexRuntimeProfile(session, options) {
    return this.codexRuntimeService.resolveCodexRuntimeProfile(session, options);
  }

  async getCodexLimitsSummary(options) {
    return this.codexRuntimeService.getCodexLimitsSummary(options);
  }

  async resolveContextSnapshot(session, options) {
    return this.contextService.resolveContextSnapshot(session, options);
  }

  getSessionKeyForMessage(message) {
    return this.bindingService.getSessionKeyForMessage(message);
  }
}
