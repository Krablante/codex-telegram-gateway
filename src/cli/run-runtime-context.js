import { loadRuntimeConfig } from "../config/runtime-config.js";
import { CodexLimitsService } from "../codex-runtime/limits.js";
import { createServiceState } from "../runtime/service-state.js";
import { RuntimeObserver } from "../runtime/runtime-observer.js";
import { ServiceGenerationStore } from "../runtime/service-generation-store.js";
import { buildForwardingEndpoint } from "../runtime/update-forwarding-ipc.js";
import { SessionCompactor } from "../session-manager/session-compactor.js";
import { SpikeFinalEventStore } from "../session-manager/spike-final-event-store.js";
import { GlobalCodexSettingsStore } from "../session-manager/global-codex-settings-store.js";
import { GlobalControlPanelStore } from "../session-manager/global-control-panel-store.js";
import { GeneralMessageLedgerStore } from "../session-manager/general-message-ledger-store.js";
import { GlobalPromptSuffixStore } from "../session-manager/global-prompt-suffix-store.js";
import { SessionLifecycleManager } from "../session-manager/session-lifecycle-manager.js";
import { SpikePromptQueueStore } from "../session-manager/prompt-queue.js";
import { RolloutCoordinationStore } from "../session-manager/rollout-coordination-store.js";
import { SessionService } from "../session-manager/session-service.js";
import { SessionStore } from "../session-manager/session-store.js";
import { TopicControlPanelStore } from "../session-manager/topic-control-panel-store.js";
import { UpdateOffsetStore } from "../session-manager/update-offset-store.js";
import { ensureStateLayout } from "../state/layout.js";
import { TelegramBotApiClient } from "../telegram/bot-api-client.js";
import { createTrackedGeneralApi } from "../telegram/general-message-cleanup.js";
import { runTelegramProbe } from "../telegram/probe.js";
import { OmniPromptHandoffStore } from "../omni/prompt-handoff.js";
import { ZooService } from "../zoo/service.js";

export async function createRunRuntimeContext({
  generationId,
  runOnce,
}) {
  const config = await loadRuntimeConfig();
  const layout = await ensureStateLayout(config.stateRoot);
  const api = new TelegramBotApiClient({
    token: config.telegramBotToken,
    baseUrl: config.telegramApiBaseUrl,
  });
  const probe = await runTelegramProbe(config, api);
  const serviceState = createServiceState(config, probe);
  serviceState.generationId = generationId;
  serviceState.isLeader = false;
  serviceState.retiring = false;
  const runtimeObserver = new RuntimeObserver({
    logsDir: layout.logs,
    config,
    serviceState,
    probe,
    mode: runOnce ? "smoke" : "poller",
  });
  const offsetStore = new UpdateOffsetStore(layout.indexes);
  const globalPromptSuffixStore = new GlobalPromptSuffixStore(layout.settings);
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(layout.settings);
  const globalControlPanelStore = new GlobalControlPanelStore(layout.settings);
  const generalMessageLedgerStore = new GeneralMessageLedgerStore(layout.settings);
  const codexLimitsService = new CodexLimitsService({
    sessionsRoot: config.codexLimitsSessionsRoot,
    command: config.codexLimitsCommand,
    cacheTtlMs: config.codexLimitsCacheTtlSecs * 1000,
    commandTimeoutMs: config.codexLimitsCommandTimeoutSecs * 1000,
  });
  const trackedApi = createTrackedGeneralApi(
    api,
    config,
    generalMessageLedgerStore,
  );
  const sessionStore = new SessionStore(layout.sessions);
  const generationStore = new ServiceGenerationStore({
    indexesRoot: layout.indexes,
    tmpRoot: layout.tmp,
    serviceKind: "spike",
    generationId,
  });
  const rolloutCoordinationStore = new RolloutCoordinationStore(layout.settings);
  const forwardingEndpoint = buildForwardingEndpoint({
    stateRoot: config.stateRoot,
    serviceKind: "spike",
    generationId,
  });
  const promptQueueStore = new SpikePromptQueueStore(sessionStore);
  const topicControlPanelStore = new TopicControlPanelStore(sessionStore);
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const promptHandoffStore = new OmniPromptHandoffStore(sessionStore);
  const sessionCompactor = new SessionCompactor({ sessionStore, config });
  const sessionLifecycleManager = new SessionLifecycleManager({
    config,
    sessionStore,
    sessionCompactor,
    runtimeObserver,
  });
  const sessionService = new SessionService({
    sessionStore,
    config,
    sessionCompactor,
    runtimeObserver,
    globalPromptSuffixStore,
    globalCodexSettingsStore,
    promptQueueStore,
    codexLimitsService,
  });
  const zooService = new ZooService({
    config,
    sessionService,
    globalControlPanelStore,
  });

  return {
    api,
    config,
    forwardingEndpoint,
    generalMessageLedgerStore,
    generationStore,
    globalCodexSettingsStore,
    globalControlPanelStore,
    offsetStore,
    probe,
    promptHandoffStore,
    runtimeObserver,
    rolloutCoordinationStore,
    serviceState,
    sessionCompactor,
    sessionLifecycleManager,
    sessionService,
    sessionStore,
    spikeFinalEventStore,
    topicControlPanelStore,
    trackedApi,
    zooService,
  };
}
