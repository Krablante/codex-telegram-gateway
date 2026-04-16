import { runCodexTask } from "./codex-runner.js";
import {
  deliverRunDocuments,
  deliverRunReply,
  emitSpikeFinalEvent,
  resolveDocumentDeliveryRoots,
} from "./worker-pool-delivery.js";
import {
  buildFreshBriefBootstrapPrompt,
  executeRunAttempts,
  executeRunLifecycle,
  interrupt,
  prepareResumeFallback,
  runAttempt,
  shutdown,
  startPromptRun,
} from "./worker-pool-lifecycle.js";
import {
  finalizeProgress,
  flushPendingLiveSteer,
  sendTypingAction,
  startProgressLoop,
  steerActiveRun,
  stopProgressLoop,
} from "./worker-pool-transport.js";

export class CodexWorkerPool {
  constructor({
    api,
    config,
    sessionStore,
    serviceState,
    runtimeObserver = null,
    sessionCompactor = null,
    sessionLifecycleManager = null,
    spikeFinalEventStore = null,
    globalCodexSettingsStore = null,
    serviceGenerationId = null,
    onRunTerminated = null,
    runTask = runCodexTask,
  }) {
    this.api = api;
    this.config = config;
    this.sessionStore = sessionStore;
    this.serviceState = serviceState;
    this.runtimeObserver = runtimeObserver;
    this.sessionCompactor = sessionCompactor;
    this.sessionLifecycleManager = sessionLifecycleManager;
    this.spikeFinalEventStore = spikeFinalEventStore;
    this.globalCodexSettingsStore = globalCodexSettingsStore;
    this.serviceGenerationId = serviceGenerationId;
    this.onRunTerminated = onRunTerminated;
    this.runTask = runTask;
    this.activeRuns = new Map();
    this.pendingLiveSteers = new Map();
    this.startingRuns = new Set();
    this.startingRunPromises = new Map();
  }

  getActiveRun(sessionKey) {
    return this.activeRuns.get(sessionKey) || null;
  }

  getActiveOrStartingRunCount() {
    return this.activeRuns.size + this.startingRuns.size;
  }

  hasActiveOrStartingRuns() {
    return this.getActiveOrStartingRunCount() > 0;
  }

  canStart(sessionKey) {
    if (this.activeRuns.has(sessionKey) || this.startingRuns.has(sessionKey)) {
      return { ok: false, reason: "busy" };
    }

    if (this.getActiveOrStartingRunCount() >= this.config.maxParallelSessions) {
      return { ok: false, reason: "capacity" };
    }

    return { ok: true };
  }

  async flushPendingLiveSteer(sessionKey, run) {
    return flushPendingLiveSteer(this, sessionKey, run);
  }

  steerActiveRun(args) {
    return steerActiveRun(this, args);
  }

  startProgressLoop(run) {
    return startProgressLoop(this, run);
  }

  stopProgressLoop(run) {
    return stopProgressLoop(run);
  }

  async finalizeProgress(run) {
    return finalizeProgress(run);
  }

  async sendTypingAction(run) {
    return sendTypingAction(this, run);
  }

  async startPromptRun(args) {
    return startPromptRun(this, args);
  }

  interrupt(sessionKey) {
    return interrupt(this, sessionKey);
  }

  async shutdown() {
    return shutdown(this);
  }

  async executeRunLifecycle(run, args) {
    return executeRunLifecycle(this, run, args);
  }

  async buildFreshBriefBootstrapPrompt(run, prompt) {
    return buildFreshBriefBootstrapPrompt(this, run, prompt);
  }

  async executeRunAttempts(run, args) {
    return executeRunAttempts(this, run, args);
  }

  async runAttempt(run, args) {
    return runAttempt(this, run, args);
  }

  async prepareResumeFallback(run, args) {
    return prepareResumeFallback(this, run, args);
  }

  async deliverRunDocuments(session, documents = []) {
    return deliverRunDocuments(this, session, documents);
  }

  async resolveDocumentDeliveryRoots(session) {
    return resolveDocumentDeliveryRoots(this, session);
  }

  async emitSpikeFinalEvent(run, options = {}) {
    return emitSpikeFinalEvent(this, run, options);
  }

  async deliverRunReply(session, text, options = {}) {
    return deliverRunReply(this, session, text, options);
  }
}
