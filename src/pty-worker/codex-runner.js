import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

import { appendCodexRuntimeConfigArgs } from "../codex-runtime/config-args.js";
import { readLatestContextSnapshot } from "../session-manager/context-snapshot.js";

const APP_SERVER_BOOT_TIMEOUT_MS = 15000;
const APP_SERVER_HOST = "127.0.0.1";
const APP_SERVER_SHUTDOWN_GRACE_MS = 5000;
const ROLLOUT_DISCOVERY_TIMEOUT_MS = 5000;
const ROLLOUT_POLL_INTERVAL_MS = 1000;
const ROLLOUT_STALL_AFTER_CHILD_EXIT_MS = 5000;
const ROLLOUT_REPLAY_OVERLAP_BYTES = 64 * 1024;
const CODEX_SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");

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

export function hasChildExited(child) {
  if (!child) {
    return true;
  }

  return child.exitCode !== null || child.signalCode !== null;
}

function createErrorFromJsonRpc(error, fallbackMessage) {
  const message =
    error?.message || fallbackMessage || "Codex app-server request failed";
  const normalized = new Error(message);
  if (Number.isFinite(error?.code)) {
    normalized.code = error.code;
  }
  if (error?.data !== undefined) {
    normalized.data = error.data;
  }
  return normalized;
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isRelevantWarning(line) {
  return (
    line.includes("codex app-server (") ||
    line.includes("listening on:") ||
    line.includes("readyz:") ||
    line.includes("healthz:") ||
    line.includes("binds localhost only") ||
    line.includes("failed to open state db") ||
    line.includes("state db discrepancy") ||
    line.includes("Failed to delete shell snapshot") ||
    line.includes("failed to unwatch")
  );
}

export function waitForListenUrl(
  stdoutReader,
  stderrReader,
  child,
  { timeoutMs = APP_SERVER_BOOT_TIMEOUT_MS } = {},
) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Codex app-server to start"));
    }, timeoutMs);

    const onLine = (line) => {
      const match = String(line || "").match(/listening on:\s*(\S+)/iu);
      if (!match) {
        return;
      }

      cleanup();
      resolve(match[1]);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onClose = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `Codex app-server exited before startup (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    };

    const cleanup = () => {
      clearTimeout(timer);
      stdoutReader.off("line", onLine);
      stderrReader.off("line", onLine);
      child.off("error", onError);
      child.off("close", onClose);
    };

    stdoutReader.on("line", onLine);
    stderrReader.on("line", onLine);
    child.on("error", onError);
    child.on("close", onClose);
  });
}

function openWebSocket(listenUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(listenUrl);
    let settled = false;

    const cleanup = () => {
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
    };

    ws.onopen = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(ws);
    };

    ws.onerror = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error(`Failed to connect to Codex app-server at ${listenUrl}`));
    };

    ws.onclose = (event) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(
        new Error(
          `Codex app-server closed before connection completed (code=${event.code})`,
        ),
      );
    };
  });
}

function createJsonRpcClient(ws, { onNotification, onDisconnect }) {
  let nextId = 1;
  const pending = new Map();

  const settlePending = (error) => {
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
  };

  ws.onmessage = (event) => {
    const raw = typeof event.data === "string" ? event.data : event.data.toString();
    const message = safeJsonParse(raw);
    if (!message) {
      return;
    }

    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) {
        return;
      }

      pending.delete(message.id);
      if (message.error) {
        entry.reject(
          createErrorFromJsonRpc(message.error, `Codex request ${entry.method} failed`),
        );
        return;
      }

      entry.resolve(message.result);
      return;
    }

    if (message.method) {
      onNotification?.(message);
    }
  };

  ws.onclose = (event) => {
    const error = new Error(
      `Codex app-server websocket closed (code=${event.code}, clean=${event.wasClean})`,
    );
    settlePending(error);
    onDisconnect?.(error);
  };

  ws.onerror = () => {};

  return {
    request(method, params = {}) {
      const id = nextId;
      nextId += 1;

      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        try {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
          }));
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },

    notify(method, params = undefined) {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method,
          ...(params === undefined ? {} : { params }),
        }),
      );
    },

    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}

function summarizeUsage(event) {
  const usage = event?.params?.tokenUsage?.last || event?.params?.tokenUsage?.total;
  if (!usage) {
    return null;
  }

  return {
    input_tokens: usage.inputTokens ?? null,
    cached_input_tokens: usage.cachedInputTokens ?? null,
    output_tokens: usage.outputTokens ?? null,
    reasoning_tokens: usage.reasoningOutputTokens ?? null,
    total_tokens: usage.totalTokens ?? null,
  };
}

export function summarizeCodexEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  if (event.type === "thread.started") {
    return {
      kind: "thread",
      eventType: "thread.started",
      text: `Codex thread started: ${event.thread_id}`,
      threadId: event.thread_id,
    };
  }

  if (event.type === "turn.started") {
    return {
      kind: "turn",
      eventType: "turn.started",
      text: "Codex turn started",
      turnId: event.turn_id ?? null,
    };
  }

  if (event.type === "turn.completed") {
    return {
      kind: "turn",
      eventType: "turn.completed",
      text: "Codex turn completed",
      turnId: event.turn_id ?? null,
      usage: event.usage || null,
    };
  }

  if (event.type === "item.started" && event.item?.type === "command_execution") {
    return {
      kind: "command",
      eventType: "item.started",
      text: `Running command: ${event.item.command}`,
      command: event.item.command,
    };
  }

  if (event.type === "item.completed" && event.item?.type === "command_execution") {
    return {
      kind: "command",
      eventType: "item.completed",
      text: `Completed command: ${event.item.command}`,
      command: event.item.command,
      exitCode: event.item.exit_code,
      aggregatedOutput: event.item.aggregated_output || "",
    };
  }

  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    return {
      kind: "agent_message",
      eventType: "item.completed",
      text: event.item.text || "",
      messagePhase: "final_answer",
    };
  }

  const method = event.method;
  if (method === "thread/started") {
    const threadId = event.params?.thread?.id || null;
    if (!threadId) {
      return null;
    }

    return {
      kind: "thread",
      eventType: "thread.started",
      text: `Codex thread started: ${threadId}`,
      threadId,
    };
  }

  if (method === "turn/started") {
    return {
      kind: "turn",
      eventType: "turn.started",
      text: "Codex turn started",
      threadId: event.params?.threadId || null,
      turnId: event.params?.turn?.id || null,
    };
  }

  if (method === "turn/completed") {
    return {
      kind: "turn",
      eventType: "turn.completed",
      text: "Codex turn completed",
      threadId: event.params?.threadId || null,
      turnId: event.params?.turn?.id || null,
      usage: null,
    };
  }

  if (method === "thread/tokenUsage/updated") {
    return {
      kind: "turn",
      eventType: "thread.tokenUsage.updated",
      text: "Codex token usage updated",
      threadId: event.params?.threadId || null,
      turnId: event.params?.turnId || null,
      usage: summarizeUsage(event),
    };
  }

  const item = event.params?.item;
  if (method === "item/started" && item?.type === "commandExecution") {
    return {
      kind: "command",
      eventType: "item.started",
      text: `Running command: ${item.command}`,
      command: item.command,
      threadId: event.params?.threadId || null,
      turnId: event.params?.turnId || null,
    };
  }

  if (method === "item/completed" && item?.type === "commandExecution") {
    return {
      kind: "command",
      eventType: "item.completed",
      text: `Completed command: ${item.command}`,
      command: item.command,
      exitCode: item.exitCode,
      aggregatedOutput: item.aggregatedOutput || "",
      threadId: event.params?.threadId || null,
      turnId: event.params?.turnId || null,
    };
  }

  if (method === "item/completed" && item?.type === "agentMessage") {
    return {
      kind: "agent_message",
      eventType: "item.completed",
      text: item.text || "",
      messagePhase: item.phase || "final_answer",
      threadId: event.params?.threadId || null,
      turnId: event.params?.turnId || null,
    };
  }

  return null;
}

export function runCodexTask({
  codexBinPath,
  cwd,
  prompt,
  sessionThreadId = null,
  imagePaths = [],
  onEvent,
  onWarning,
  spawnImpl = spawn,
  openWebSocketImpl = openWebSocket,
  codexSessionsRoot = CODEX_SESSIONS_ROOT,
  appServerBootTimeoutMs = APP_SERVER_BOOT_TIMEOUT_MS,
  rolloutDiscoveryTimeoutMs = ROLLOUT_DISCOVERY_TIMEOUT_MS,
  rolloutPollIntervalMs = ROLLOUT_POLL_INTERVAL_MS,
  rolloutStallAfterChildExitMs = ROLLOUT_STALL_AFTER_CHILD_EXIT_MS,
  model = null,
  reasoningEffort = null,
}) {
  const args = buildCodexArgs({
    model,
    reasoningEffort,
  });
  const child = spawnImpl(codexBinPath, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
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
  let finishedResolve = () => {};
  let finishedReject = () => {};
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

    if (Number.isInteger(child.pid)) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {}
      }
    } else {
      try {
        child.kill("SIGTERM");
      } catch {}
    }

    setTimeout(() => {
      if (!hasChildExited(child)) {
        if (Number.isInteger(child.pid)) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
        } else {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
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

  const emitFallbackSummary = async (summary) => {
    if (!summary) {
      return;
    }

    summary.isPrimaryThreadEvent = true;
    await onEvent?.(summary, null);
  };

  const buildSummaryReplayKey = (summary) => {
    if (!summary || typeof summary !== "object") {
      return null;
    }

    return JSON.stringify({
      kind: summary.kind || null,
      eventType: summary.eventType || null,
      text: summary.text || "",
      messagePhase: summary.messagePhase || null,
      threadId: summary.threadId || primaryThreadId || latestThreadId || null,
      turnId: summary.turnId || null,
      usage: summary.usage || null,
      command: summary.command || null,
      exitCode: summary.exitCode ?? null,
    });
  };

  const seenSummaryKeys = new Set();

  const rememberSummary = (summary) => {
    const replayKey = buildSummaryReplayKey(summary);
    if (!replayKey) {
      return false;
    }

    if (seenSummaryKeys.has(replayKey)) {
      return false;
    }

    seenSummaryKeys.add(replayKey);
    return true;
  };

  const summarizeRolloutLine = (line) => {
    const event = safeJsonParse(line);
    if (event?.type !== "event_msg" || !event.payload) {
      return null;
    }

    if (event.payload.type === "agent_message") {
      return {
        kind: "agent_message",
        eventType: "rollout.agent_message",
        text: event.payload.message || "",
        messagePhase: event.payload.phase || "final_answer",
        threadId: primaryThreadId,
      };
    }

    if (event.payload.type === "token_count") {
      return {
        kind: "turn",
        eventType: "thread.tokenUsage.updated",
        text: "Codex token usage updated",
        threadId: primaryThreadId,
        turnId: activeTurnId,
        usage: {
          input_tokens: event.payload.info?.last_token_usage?.input_tokens ?? null,
          cached_input_tokens:
            event.payload.info?.last_token_usage?.cached_input_tokens ?? null,
          output_tokens: event.payload.info?.last_token_usage?.output_tokens ?? null,
          reasoning_tokens:
            event.payload.info?.last_token_usage?.reasoning_output_tokens ?? null,
          total_tokens: event.payload.info?.last_token_usage?.total_tokens ?? null,
        },
      };
    }

    return null;
  };

  const readRolloutDelta = async ({
    filePath,
    offset,
    carryover,
  }) => {
    const handle = await fs.open(filePath, "r");
    try {
      const stats = await handle.stat();
      let nextOffset = offset;
      let nextCarryover = Buffer.isBuffer(carryover)
        ? carryover
        : Buffer.from(String(carryover || ""), "utf8");
      if (stats.size < offset) {
        nextOffset = 0;
        nextCarryover = Buffer.alloc(0);
      }
      if (stats.size === nextOffset) {
        return {
          lines: [],
          nextOffset,
          carryover: nextCarryover,
        };
      }

      const bytesToRead = stats.size - nextOffset;
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, nextOffset);
      const chunk = nextCarryover.length > 0
        ? Buffer.concat([nextCarryover, buffer.subarray(0, bytesRead)])
        : buffer.subarray(0, bytesRead);
      const chunkStartOffset = nextOffset - nextCarryover.length;
      const lines = [];
      let lineStartIndex = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0A) {
          continue;
        }

        let lineBuffer = chunk.subarray(lineStartIndex, index);
        if (
          lineBuffer.length > 0 &&
          lineBuffer[lineBuffer.length - 1] === 0x0D
        ) {
          lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
        }

        const text = lineBuffer.toString("utf8").trim();
        if (text) {
          lines.push({
            text,
            startOffset: chunkStartOffset + lineStartIndex,
            endOffset: chunkStartOffset + index + 1,
          });
        }
        lineStartIndex = index + 1;
      }
      nextCarryover = chunk.subarray(lineStartIndex);
      return {
        lines,
        nextOffset: nextOffset + bytesRead,
        carryover: nextCarryover,
      };
    } finally {
      await handle.close();
    }
  };

  const followRolloutAfterDisconnect = async (disconnectError) => {
    const rolloutPathWasKnownAtDisconnect = Boolean(rolloutPath);
    const replayFloorOffset = rolloutPathWasKnownAtDisconnect &&
      Number.isInteger(rolloutObservedOffset)
      ? rolloutObservedOffset
      : 0;
    const startedAt = Date.now();
    while (!rolloutPath) {
      const resolved = await readLatestContextSnapshot({
        threadId: primaryThreadId || latestThreadId,
        sessionsRoot: codexSessionsRoot,
        knownRolloutPath: rolloutPath,
      });
      rolloutPath = resolved.rolloutPath || rolloutPath;
      if (rolloutPath) {
        break;
      }
      if (Date.now() - startedAt >= rolloutDiscoveryTimeoutMs) {
        throw disconnectError;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    let offset = rolloutPathWasKnownAtDisconnect &&
      Number.isInteger(rolloutObservedOffset)
      ? Math.max(0, rolloutObservedOffset - ROLLOUT_REPLAY_OVERLAP_BYTES)
      : 0;
    let carryover = Buffer.alloc(0);
    let lastObservedGrowthAt = Date.now();
    while (!settled) {
      const previousOffset = offset;
      const delta = await readRolloutDelta({
        filePath: rolloutPath,
        offset,
        carryover,
      });
      offset = delta.nextOffset;
      carryover = delta.carryover;
      if (offset > previousOffset) {
        lastObservedGrowthAt = Date.now();
      }

      for (const line of delta.lines) {
        if (line.endOffset <= replayFloorOffset) {
          continue;
        }

        const summary = summarizeRolloutLine(line.text);
        if (!summary) {
          continue;
        }
        if (!rememberSummary(summary)) {
          continue;
        }
        if (summary.kind === "turn" && summary.usage) {
          await emitFallbackSummary(summary);
          continue;
        }
        if (summary.messagePhase === "final_answer") {
          await emitFallbackSummary(summary);
          shutdownTransport();
          finish({
            exitCode: 0,
            signal: null,
            threadId: latestThreadId,
            warnings,
            resumeReplacement: null,
          });
          return;
        }
        await emitFallbackSummary(summary);
      }

      if (
        recoveryChildExit &&
        Date.now() - lastObservedGrowthAt >= rolloutStallAfterChildExitMs
      ) {
        throw new Error(
          `Codex app-server exited before rollout fallback reached a final answer (code=${recoveryChildExit.code ?? "null"}, signal=${recoveryChildExit.signal ?? "null"})`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, rolloutPollIntervalMs));
    }
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

    finish({
      exitCode: code ?? 1,
      signal,
      threadId: latestThreadId,
      warnings,
      resumeReplacement: null,
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

      if (event.method === "turn/completed" && primaryEvent) {
        shutdownTransport();
        finish({
          exitCode: 0,
          signal: null,
          threadId: latestThreadId,
          warnings,
          resumeReplacement: null,
        });
      }
    };
    rpc = createJsonRpcClient(ws, {
      onNotification: (event) => {
        notificationChain = notificationChain
          .catch(() => {})
          .then(() => handleNotification(event));
      },
      onDisconnect: (error) => {
        if (shuttingDown || settled || recoveringFromDisconnect) {
          return;
        }

        recoveringFromDisconnect = true;
        rpc = null;
        activeTurnId = null;
        Promise.resolve()
          .then(() => followRolloutAfterDisconnect(error))
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
