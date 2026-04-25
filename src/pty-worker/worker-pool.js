import { createHostAwareRunTask } from "./host-aware-run-task.js";
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
  requeuePendingLiveSteer,
  sendTypingAction,
  startProgressLoop,
  steerActiveRun,
  stopProgressLoop,
} from "./worker-pool-transport.js";

const QUEUED_PROMPT_HOST_BACKOFF_INITIAL_MS = 30_000;
const QUEUED_PROMPT_HOST_BACKOFF_MAX_MS = 5 * 60_000;

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
    globalPromptSuffixStore = null,
    globalCodexSettingsStore = null,
    hostRegistryService = null,
    promptQueueStore = null,
    serviceGenerationId = null,
    onRunTerminated = null,
    runTask = createHostAwareRunTask({ config, hostRegistryService }),
  }) {
    this.api = api;
    this.config = config;
    this.sessionStore = sessionStore;
    this.serviceState = serviceState;
    this.runtimeObserver = runtimeObserver;
    this.sessionCompactor = sessionCompactor;
    this.sessionLifecycleManager = sessionLifecycleManager;
    this.spikeFinalEventStore = spikeFinalEventStore;
    this.globalPromptSuffixStore = globalPromptSuffixStore;
    this.globalCodexSettingsStore = globalCodexSettingsStore;
    this.hostRegistryService = hostRegistryService;
    this.promptQueueStore = promptQueueStore;
    this.serviceGenerationId = serviceGenerationId;
    this.onRunTerminated = onRunTerminated;
    this.runTask = runTask;
    this.activeRuns = new Map();
    this.pendingLiveSteers = new Map();
    this.startingRuns = new Set();
    this.startingRunSessions = new Map();
    this.startingRunPromises = new Map();
    this.queuedPromptBackoffBySessionKey = new Map();
    this.shuttingDown = false;
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
    if (this.shuttingDown) {
      return { ok: false, reason: "shutdown" };
    }

    if (this.activeRuns.has(sessionKey) || this.startingRuns.has(sessionKey)) {
      return { ok: false, reason: "busy" };
    }

    if (this.getActiveOrStartingRunCount() >= this.config.maxParallelSessions) {
      return { ok: false, reason: "capacity" };
    }

    return { ok: true };
  }

  shouldSkipQueuedPromptStart(sessionKey, now = Date.now()) {
    const backoff = this.queuedPromptBackoffBySessionKey.get(sessionKey);
    return Boolean(backoff && backoff.nextRetryAtMs > now);
  }

  noteQueuedPromptStartResult(sessionKey, result, now = Date.now()) {
    if (result?.ok || result?.reason !== "host-unavailable") {
      this.queuedPromptBackoffBySessionKey.delete(sessionKey);
      return;
    }

    const current = this.queuedPromptBackoffBySessionKey.get(sessionKey);
    const delayMs = current
      ? Math.min(current.delayMs * 2, QUEUED_PROMPT_HOST_BACKOFF_MAX_MS)
      : QUEUED_PROMPT_HOST_BACKOFF_INITIAL_MS;
    this.queuedPromptBackoffBySessionKey.set(sessionKey, {
      delayMs,
      nextRetryAtMs: now + delayMs,
    });
  }

  async flushPendingLiveSteer(sessionKey, run) {
    return flushPendingLiveSteer(this, sessionKey, run);
  }

  async requeuePendingLiveSteer(sessionKey, run) {
    return requeuePendingLiveSteer(this, sessionKey, run);
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

  async shutdown(options = undefined) {
    return shutdown(this, options);
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
