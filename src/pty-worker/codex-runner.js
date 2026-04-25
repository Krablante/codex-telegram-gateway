import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { appendCodexRuntimeConfigArgs } from "../codex-runtime/config-args.js";
import { buildCodexChildEnv } from "../runtime/codex-child-env.js";
import { spawnRuntimeCommand } from "../runtime/spawn-command.js";
import { createSummaryTracker } from "./codex-runner-recovery.js";
import { openWebSocket } from "./codex-runner-transport.js";
import { attachChildProcessHandlers } from "./codex-runner-transport-lifecycle.js";
import { queueSteer } from "./codex-runner-steer.js";
import { handleStartupFailure, startCodexTaskStartup } from "./codex-runner-startup.js";
import { normalizeOptionalText } from "./codex-runner-thread-history.js";

const APP_SERVER_BOOT_TIMEOUT_MS = 15000;
const APP_SERVER_HOST = "127.0.0.1";
const APP_SERVER_SHUTDOWN_GRACE_MS = 5000;
const ROLLOUT_DISCOVERY_TIMEOUT_MS = 5000;
const ROLLOUT_POLL_INTERVAL_MS = 1000;
const ROLLOUT_STALL_AFTER_CHILD_EXIT_MS = 5000;
const ROLLOUT_STALL_WITHOUT_CHILD_EXIT_MS = 30000;
const TRANSPORT_REATTACH_RETRY_DELAY_MS = 50;
const TRANSPORT_REATTACH_TIMEOUT_MS = 1500;
const STEER_ACTIVE_TURN_REFRESH_RETRY_DELAYS_MS = [150, 350, 750, 1500];
const STEER_REQUEST_TIMEOUT_MS = 3000;
const TURN_COMPLETION_FINAL_MESSAGE_GRACE_MS = 1000;
const CODEX_SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");

export {
  hasChildExited,
  isRelevantWarning,
  summarizeCodexEvent,
} from "./codex-runner-common.js";
export { waitForListenUrl } from "./codex-runner-transport.js";

export function buildCodexArgs({
  listenUrl = `ws://${APP_SERVER_HOST}:0`,
  model = null,
  reasoningEffort = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  sandboxMode = "danger-full-access",
  approvalPolicy = "never",
} = {}) {
  const args = [
    "app-server",
    "--listen",
    listenUrl,
  ];
  return appendCodexRuntimeConfigArgs(args, {
    model,
    reasoningEffort,
    contextWindow,
    autoCompactTokenLimit,
    sandboxMode,
    approvalPolicy,
  });
}

export function buildTurnInput({
  prompt = "",
  imagePaths = [],
}) {
  const input = [];
  const normalizedPrompt = String(prompt || "");
  if (normalizedPrompt.trim()) {
    input.push({
      type: "text",
      text: normalizedPrompt,
    });
  }

  for (const imagePath of imagePaths) {
    input.push({
      type: "localImage",
      path: imagePath,
    });
  }

  return input;
}

export function runCodexTask({
  codexBinPath,
  cwd,
  prompt,
  developerInstructions = null,
  baseInstructions = null,
  sessionKey = null,
  sessionThreadId = null,
  providerSessionId = null,
  skipThreadHistoryLookup = false,
  imagePaths = [],
  onEvent,
  onWarning,
  onRuntimeState = null,
  spawnImpl,
  openWebSocketImpl = openWebSocket,
  codexSessionsRoot = CODEX_SESSIONS_ROOT,
  appServerBootTimeoutMs = APP_SERVER_BOOT_TIMEOUT_MS,
  rolloutDiscoveryTimeoutMs = ROLLOUT_DISCOVERY_TIMEOUT_MS,
  rolloutPollIntervalMs = ROLLOUT_POLL_INTERVAL_MS,
  rolloutStallAfterChildExitMs = ROLLOUT_STALL_AFTER_CHILD_EXIT_MS,
  rolloutStallWithoutChildExitMs = ROLLOUT_STALL_WITHOUT_CHILD_EXIT_MS,
  transportReattachRetryDelayMs = TRANSPORT_REATTACH_RETRY_DELAY_MS,
  transportReattachTimeoutMs = TRANSPORT_REATTACH_TIMEOUT_MS,
  steerRequestTimeoutMs = STEER_REQUEST_TIMEOUT_MS,
  model = null,
  reasoningEffort = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  platform = process.platform,
}) {
  const args = buildCodexArgs({
    model,
    reasoningEffort,
    contextWindow,
    autoCompactTokenLimit,
  });
  const child = spawnRuntimeCommand(codexBinPath, args, {
    cwd,
    env: buildCodexChildEnv(),
    platform,
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32",
    spawnImpl,
  });

  const stdoutReader = readline.createInterface({ input: child.stdout });
  const stderrReader = readline.createInterface({ input: child.stderr });
  const normalizedDeveloperInstructions =
    normalizeOptionalText(developerInstructions)
    || normalizeOptionalText(baseInstructions);
  const threadParams = {
    cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ...(normalizedDeveloperInstructions
      ? { developerInstructions: normalizedDeveloperInstructions }
      : {}),
  };

  const state = {
    warnings: [],
    latestThreadId: sessionThreadId,
    primaryThreadId: sessionThreadId,
    latestProviderSessionId: providerSessionId,
    activeTurnId: null,
    listenUrl: null,
    rolloutPath: null,
    rolloutObservedOffset: null,
    latestContextSnapshot: null,
    resumeReplacement: null,
    rpc: null,
    shuttingDown: false,
    settled: false,
    recoveringFromDisconnect: false,
    allowRolloutWatcherDuringRecovery: false,
    interruptRequested: false,
    recoveryChildExit: null,
    flushChain: Promise.resolve(),
    notificationChain: Promise.resolve(),
    pendingSteerInputs: [],
    sawPrimaryFinalAnswer: false,
    pendingTurnCompletion: false,
    pendingTurnCompletionTimer: null,
    rolloutTaskCompleteWatcher: null,
  };

  let finishedResolve = () => {};
  let finishedReject = () => {};
  const finished = new Promise((resolve, reject) => {
    finishedResolve = resolve;
    finishedReject = reject;
  });

  const context = {
    child,
    stdoutReader,
    stderrReader,
    cwd,
    sessionKey,
    sessionThreadId,
    skipThreadHistoryLookup,
    initialInput: buildTurnInput({ prompt, imagePaths }),
    threadParams,
    state,
    summaryTracker: createSummaryTracker(),
    onEvent,
    onWarning,
    onRuntimeState,
    openWebSocketImpl,
    codexSessionsRoot,
    appServerBootTimeoutMs,
    appServerShutdownGraceMs: APP_SERVER_SHUTDOWN_GRACE_MS,
    rolloutDiscoveryTimeoutMs,
    rolloutPollIntervalMs,
    rolloutStallAfterChildExitMs,
    rolloutStallWithoutChildExitMs,
    transportReattachRetryDelayMs,
    transportReattachTimeoutMs,
    steerActiveTurnRefreshRetryDelaysMs: STEER_ACTIVE_TURN_REFRESH_RETRY_DELAYS_MS,
    steerRequestTimeoutMs,
    turnCompletionFinalMessageGraceMs: TURN_COMPLETION_FINAL_MESSAGE_GRACE_MS,
    finish(payload) {
      if (state.settled) {
        return;
      }

      state.settled = true;
      finishedResolve(payload);
    },
    fail(error) {
      if (state.settled) {
        return;
      }

      state.settled = true;
      finishedReject(error);
    },
  };

  attachChildProcessHandlers(context);

  startCodexTaskStartup(context).catch((error) => {
    handleStartupFailure(context, error);
  });

  return {
    child,
    finished,
    steer({ input } = {}) {
      return queueSteer(context, input);
    },
    interrupt({ threadId = state.latestThreadId, turnId = state.activeTurnId } = {}) {
      state.interruptRequested = true;
      if (!state.rpc || !threadId || !turnId) {
        return Promise.resolve(false);
      }

      return state.rpc.request("turn/interrupt", {
        threadId,
        turnId,
      })
        .then(() => true)
        .catch(() => false);
    },
  };
}
