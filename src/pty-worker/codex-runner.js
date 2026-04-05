import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { appendCodexRuntimeConfigArgs } from "../codex-runtime/config-args.js";
import { spawnRuntimeCommand } from "../runtime/spawn-command.js";
import { signalChildProcessTree } from "../runtime/process-tree.js";
import { readLatestContextSnapshot } from "../session-manager/context-snapshot.js";
import {
  hasChildExited,
  isRelevantWarning,
  summarizeCodexEvent,
} from "./codex-runner-common.js";
import {
  createSummaryTracker,
  followRolloutAfterDisconnect,
} from "./codex-runner-recovery.js";
import {
  createJsonRpcClient,
  openWebSocket,
  waitForListenUrl,
} from "./codex-runner-transport.js";

const APP_SERVER_BOOT_TIMEOUT_MS = 15000;
const APP_SERVER_HOST = "127.0.0.1";
const APP_SERVER_SHUTDOWN_GRACE_MS = 5000;
const ROLLOUT_DISCOVERY_TIMEOUT_MS = 5000;
const ROLLOUT_POLL_INTERVAL_MS = 1000;
const ROLLOUT_STALL_AFTER_CHILD_EXIT_MS = 5000;
const TURN_COMPLETION_FINAL_MESSAGE_GRACE_MS = 200;
const CODEX_SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");

export { hasChildExited, summarizeCodexEvent } from "./codex-runner-common.js";
export { waitForListenUrl } from "./codex-runner-transport.js";

export function buildCodexArgs({
  listenUrl = `ws://${APP_SERVER_HOST}:0`,
  model = null,
  reasoningEffort = null,
} = {}) {
  const args = [
    "app-server",
    "--listen",
    listenUrl,
  ];
  return appendCodexRuntimeConfigArgs(args, {
    model,
    reasoningEffort,
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
  sessionThreadId = null,
  imagePaths = [],
  onEvent,
  onWarning,
  spawnImpl,
  openWebSocketImpl = openWebSocket,
  codexSessionsRoot = CODEX_SESSIONS_ROOT,
  appServerBootTimeoutMs = APP_SERVER_BOOT_TIMEOUT_MS,
  rolloutDiscoveryTimeoutMs = ROLLOUT_DISCOVERY_TIMEOUT_MS,
  rolloutPollIntervalMs = ROLLOUT_POLL_INTERVAL_MS,
  rolloutStallAfterChildExitMs = ROLLOUT_STALL_AFTER_CHILD_EXIT_MS,
  model = null,
  reasoningEffort = null,
  platform = process.platform,
}) {
  const args = buildCodexArgs({
    model,
    reasoningEffort,
  });
  const child = spawnRuntimeCommand(codexBinPath, args, {
    cwd,
    env: process.env,
    platform,
    stdio: ["ignore", "pipe", "pipe"],
    detached: platform !== "win32",
    spawnImpl,
  });

  const stdoutReader = readline.createInterface({ input: child.stdout });
  const stderrReader = readline.createInterface({ input: child.stderr });
  const warnings = [];
  const initialInput = buildTurnInput({ prompt, imagePaths });
  let latestThreadId = sessionThreadId;
  let primaryThreadId = sessionThreadId;
  let activeTurnId = null;
  let rolloutPath = null;
  let rolloutObservedOffset = null;
  let resumeReplacement = null;
  let rpc = null;
  let shuttingDown = false;
  let settled = false;
  let recoveringFromDisconnect = false;
  let recoveryChildExit = null;
  let flushChain = Promise.resolve();
  let notificationChain = Promise.resolve();
  const pendingSteerInputs = [];
  let sawPrimaryFinalAnswer = false;
  let pendingTurnCompletion = false;
  let pendingTurnCompletionTimer = null;
  let finishedResolve = () => {};
  let finishedReject = () => {};
  const summaryTracker = createSummaryTracker();

  const finished = new Promise((resolve, reject) => {
    finishedResolve = resolve;
    finishedReject = reject;
  });

  const finish = (payload) => {
    if (settled) {
      return;
    }

    settled = true;
    finishedResolve(payload);
  };

  const fail = (error) => {
    if (settled) {
      return;
    }

    settled = true;
    finishedReject(error);
  };

  const stopChild = () => {
    if (hasChildExited(child)) {
      return;
    }

    signalChildProcessTree(child, "SIGTERM");

    setTimeout(() => {
      if (!hasChildExited(child)) {
        signalChildProcessTree(child, "SIGKILL");
      }
    }, APP_SERVER_SHUTDOWN_GRACE_MS).unref();
  };

  const shutdownTransport = () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    try {
      rpc?.close();
    } catch {}
    stopChild();
  };

  const clearPendingTurnCompletion = () => {
    pendingTurnCompletion = false;
    if (!pendingTurnCompletionTimer) {
      return;
    }

    clearTimeout(pendingTurnCompletionTimer);
    pendingTurnCompletionTimer = null;
  };

  const finishCompletedTurn = () => {
    clearPendingTurnCompletion();
    shutdownTransport();
    finish({
      exitCode: 0,
      signal: null,
      threadId: latestThreadId,
      warnings,
      resumeReplacement: null,
    });
  };

  const scheduleCompletedTurnFinish = () => {
    if (sawPrimaryFinalAnswer) {
      finishCompletedTurn();
      return;
    }

    pendingTurnCompletion = true;
    if (pendingTurnCompletionTimer) {
      return;
    }

    pendingTurnCompletionTimer = setTimeout(() => {
      pendingTurnCompletionTimer = null;
      finishCompletedTurn();
    }, TURN_COMPLETION_FINAL_MESSAGE_GRACE_MS);
    pendingTurnCompletionTimer.unref?.();
  };

  const isPrimaryThreadEvent = (threadId) => {
    if (!threadId) {
      return true;
    }

    if (!primaryThreadId) {
      primaryThreadId = threadId;
      latestThreadId = threadId;
      return true;
    }

    return threadId === primaryThreadId;
  };

  const rememberSummary = (summary) => {
    return summaryTracker.rememberSummary(summary, {
      primaryThreadId,
      latestThreadId,
    });
  };

  const emitFallbackSummary = async (summary) => {
    if (!summary) {
      return;
    }

    summary.isPrimaryThreadEvent = true;
    await onEvent?.(summary, null);
  };

  const flushPendingSteers = async () => {
    if (!rpc || !latestThreadId || !activeTurnId || pendingSteerInputs.length === 0) {
      return { ok: true, reason: "steer-buffered", inputCount: pendingSteerInputs.length };
    }

    const input = pendingSteerInputs.splice(0, pendingSteerInputs.length);
    const expectedTurnId = activeTurnId;
    try {
      const steerResponse = await rpc.request("turn/steer", {
        threadId: latestThreadId,
        expectedTurnId,
        input,
      });
      activeTurnId =
        steerResponse?.turn?.id
        || steerResponse?.turnId
        || expectedTurnId;
    } catch (error) {
      pendingSteerInputs.unshift(...input);
      throw error;
    }

    return {
      ok: true,
      reason: "steered",
      inputCount: input.length,
      turnId: activeTurnId,
      threadId: latestThreadId,
    };
  };

  const queueSteer = (input = []) => {
    const normalizedInput = Array.isArray(input) ? input.filter(Boolean) : [];
    if (normalizedInput.length === 0) {
      return Promise.resolve({ ok: false, reason: "empty" });
    }

    if (recoveringFromDisconnect) {
      return Promise.resolve({
        ok: false,
        reason: "transport-recovering",
      });
    }

    pendingSteerInputs.push(...normalizedInput);
    if (!rpc || !latestThreadId || !activeTurnId) {
      return Promise.resolve({
        ok: true,
        reason: "steer-buffered",
        inputCount: normalizedInput.length,
      });
    }

    flushChain = flushChain
      .catch(() => {})
      .then(() => flushPendingSteers());
    return flushChain.catch((error) => ({
      ok: false,
      reason: "steer-failed",
      error,
    }));
  };

  stdoutReader.on("line", () => {});

  stderrReader.on("line", (line) => {
    if (!line || isRelevantWarning(line)) {
      return;
    }

    warnings.push(line);
    onWarning?.(line);
  });

  child.on("error", (error) => {
    fail(error);
  });

  child.on("close", (code, signal) => {
    if (settled) {
      return;
    }

    if (recoveringFromDisconnect) {
      recoveryChildExit = {
        code,
        signal,
      };
      return;
    }

    if (resumeReplacement) {
      finish({
        exitCode: code ?? 0,
        signal,
        threadId: latestThreadId,
        warnings,
        resumeReplacement,
      });
      return;
    }

    if (shuttingDown) {
      return;
    }

    notificationChain = notificationChain
      .catch(() => {})
      .then(() => {
        if (settled || shuttingDown || pendingTurnCompletion) {
          return;
        }

        finish({
          exitCode: code ?? 1,
          signal,
          threadId: latestThreadId,
          warnings,
          resumeReplacement: null,
        });
      });
  });

  const startup = (async () => {
    const listenUrl = await waitForListenUrl(stdoutReader, stderrReader, child, {
      timeoutMs: appServerBootTimeoutMs,
    });
    const ws = await openWebSocketImpl(listenUrl);
    const handleNotification = async (event) => {
      const summary = summarizeCodexEvent(event);
      const eventThreadId = summary?.threadId || event?.params?.threadId || null;
      const primaryEvent = isPrimaryThreadEvent(eventThreadId);

      if (summary) {
        summary.isPrimaryThreadEvent = primaryEvent;
      }

      if (summary?.threadId && primaryEvent) {
        latestThreadId = summary.threadId;
      }
      if (
        summary?.kind === "agent_message" &&
        summary?.messagePhase === "final_answer" &&
        primaryEvent
      ) {
        sawPrimaryFinalAnswer = true;
      }
      if (summary?.eventType === "turn.started" && summary.turnId && primaryEvent) {
        activeTurnId = summary.turnId;
        flushChain = flushChain
          .catch(() => {})
          .then(() => flushPendingSteers());
      } else if (summary?.eventType === "turn.completed" && primaryEvent) {
        activeTurnId = null;
      }

      if (summary) {
        rememberSummary(summary);
        try {
          await onEvent?.(summary, event);
        } catch {}
      }

      if (
        pendingTurnCompletion &&
        summary?.kind === "agent_message" &&
        summary?.messagePhase === "final_answer" &&
        primaryEvent
      ) {
        finishCompletedTurn();
        return;
      }

      if (event.method === "turn/completed" && primaryEvent) {
        scheduleCompletedTurnFinish();
      }
    };
    rpc = createJsonRpcClient(ws, {
      onNotification: (event) => {
        notificationChain = notificationChain
          .catch(() => {})
          .then(() => handleNotification(event));
      },
      onDisconnect: (error) => {
        if (
          shuttingDown ||
          settled ||
          recoveringFromDisconnect ||
          pendingTurnCompletion
        ) {
          return;
        }

        recoveringFromDisconnect = true;
        rpc = null;
        activeTurnId = null;
        Promise.resolve()
          .then(() => followRolloutAfterDisconnect({
            disconnectError: error,
            codexSessionsRoot,
            rolloutDiscoveryTimeoutMs,
            rolloutPollIntervalMs,
            rolloutStallAfterChildExitMs,
            getSettled: () => settled,
            getRecoveryChildExit: () => recoveryChildExit,
            getActiveTurnId: () => activeTurnId,
            getPrimaryThreadId: () => primaryThreadId,
            getLatestThreadId: () => latestThreadId,
            getRolloutPath: () => rolloutPath,
            setRolloutPath: (value) => {
              rolloutPath = value;
            },
            getRolloutObservedOffset: () => rolloutObservedOffset,
            rememberSummary: (summary, ids) => summaryTracker.rememberSummary(summary, ids),
            emitSummary: emitFallbackSummary,
            onFinalAnswer: async () => {
              shutdownTransport();
              finish({
                exitCode: 0,
                signal: null,
                threadId: latestThreadId,
                warnings,
                resumeReplacement: null,
              });
            },
          }))
          .catch((disconnectError) => {
            if (settled) {
              return;
            }
            shutdownTransport();
            fail(disconnectError);
          })
          .finally(() => {
            recoveringFromDisconnect = false;
          });
      },
    });

    await rpc.request("initialize", {
      clientInfo: {
        name: "codex-telegram-gateway",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    rpc.notify("initialized");

    const threadParams = {
      cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    };
    let threadResponse = null;
    try {
      threadResponse = sessionThreadId
        ? await rpc.request("thread/resume", {
            ...threadParams,
            threadId: sessionThreadId,
          })
        : await rpc.request("thread/start", threadParams);
    } catch (error) {
      if (sessionThreadId) {
        resumeReplacement = {
          requestedThreadId: sessionThreadId,
          replacementThreadId: null,
        };
        shutdownTransport();
        finish({
          exitCode: 0,
          signal: null,
          threadId: latestThreadId,
          warnings,
          resumeReplacement,
        });
        return;
      }

      throw error;
    }

    latestThreadId = threadResponse?.thread?.id || latestThreadId;
    primaryThreadId = latestThreadId;
    const latestContext = await readLatestContextSnapshot({
      threadId: primaryThreadId,
      sessionsRoot: codexSessionsRoot,
      knownRolloutPath: rolloutPath,
    });
    rolloutPath = latestContext.rolloutPath || rolloutPath;
    if (rolloutPath) {
      try {
        rolloutObservedOffset = await fs.stat(rolloutPath).then((stats) => stats.size);
      } catch {}
    }

    const turnResponse = await rpc.request("turn/start", {
      threadId: latestThreadId,
      input: initialInput,
    });
    activeTurnId = turnResponse?.turn?.id || activeTurnId;
    flushChain = flushChain
      .catch(() => {})
      .then(() => flushPendingSteers());
  })();

  startup.catch((error) => {
    shutdownTransport();
    fail(error);
  });

  return {
    child,
    finished,
    steer({ input } = {}) {
      return queueSteer(input);
    },
    interrupt({ threadId = latestThreadId, turnId = activeTurnId } = {}) {
      if (!rpc || !threadId || !turnId) {
        return Promise.resolve(false);
      }

      return rpc.request("turn/interrupt", {
        threadId,
        turnId,
      })
        .then(() => true)
        .catch(() => false);
    },
  };
}
