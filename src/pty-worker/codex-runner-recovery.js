import fs from "node:fs/promises";

import { readLatestContextSnapshot } from "../session-manager/context-snapshot.js";
import { safeJsonParse } from "./codex-runner-common.js";

const ROLLOUT_REPLAY_OVERLAP_BYTES = 64 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSummaryReplayKey(summary, { primaryThreadId = null, latestThreadId = null } = {}) {
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
}

export function createSummaryTracker() {
  const seenSummaryKeys = new Set();

  return {
    rememberSummary(summary, { primaryThreadId = null, latestThreadId = null } = {}) {
      const replayKey = buildSummaryReplayKey(summary, {
        primaryThreadId,
        latestThreadId,
      });
      if (!replayKey) {
        return false;
      }

      if (seenSummaryKeys.has(replayKey)) {
        return false;
      }

      seenSummaryKeys.add(replayKey);
      return true;
    },
  };
}

export function summarizeRolloutLine(
  line,
  { primaryThreadId = null, activeTurnId = null } = {},
) {
  const event = safeJsonParse(line);
  if (event?.type !== "event_msg" || !event.payload) {
    return null;
  }

  if (event.payload.type === "agent_message") {
    return {
      kind: "agent_message",
      eventType: "rollout.agent_message",
      text: event.payload.message || "",
      messagePhase:
        typeof event.payload.phase === "string" && event.payload.phase.trim()
          ? event.payload.phase
          : null,
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

  if (event.payload.type === "task_complete") {
    return {
      kind: "agent_message",
      eventType: "rollout.task_complete",
      text: event.payload.last_agent_message || "",
      messagePhase: "final_answer",
      threadId: primaryThreadId,
      turnId: event.payload.turn_id || activeTurnId,
    };
  }

  if (event.payload.type === "turn_aborted") {
    return {
      kind: "turn",
      eventType: "turn.aborted",
      text: "Codex turn aborted",
      threadId: primaryThreadId,
      turnId: event.payload.turn_id || activeTurnId,
      abortReason: event.payload.reason || null,
    };
  }

  return null;
}

export function extractRolloutTaskStartedTurnId(line) {
  const event = safeJsonParse(line);
  if (event?.type !== "event_msg" || !event.payload) {
    return {
      seen: false,
      turnId: null,
    };
  }

  if (event.payload.type !== "task_started") {
    return {
      seen: false,
      turnId: null,
    };
  }

  const normalizedTurnId = String(event.payload.turn_id ?? "").trim();
  return {
    seen: true,
    turnId: normalizedTurnId || null,
  };
}

export async function readRolloutDelta({
  filePath,
  offset,
  carryover,
  flushTailAtEof = false,
}) {
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
      if (flushTailAtEof && nextCarryover.length > 0) {
        let lineBuffer = nextCarryover;
        if (
          lineBuffer.length > 0 &&
          lineBuffer[lineBuffer.length - 1] === 0x0D
        ) {
          lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
        }
        const text = lineBuffer.toString("utf8").trim();
        return {
          lines: text
            ? [{
                text,
                startOffset: nextOffset - nextCarryover.length,
                endOffset: nextOffset,
              }]
            : [],
          nextOffset,
          carryover: Buffer.alloc(0),
        };
      }

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
    if (flushTailAtEof && nextCarryover.length > 0) {
      let lineBuffer = nextCarryover;
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
          endOffset: chunkStartOffset + chunk.length,
        });
      }
      nextCarryover = Buffer.alloc(0);
    }
    return {
      lines,
      nextOffset: nextOffset + bytesRead,
      carryover: nextCarryover,
    };
  } finally {
    await handle.close();
  }
}

export async function watchRolloutForTaskComplete({
  codexSessionsRoot,
  rolloutPollIntervalMs,
  getSettled,
  getWatchingDisabled,
  getActiveTurnId,
  getHasPrimaryFinalAnswer,
  getPrimaryThreadId,
  getProviderSessionId,
  getLatestThreadId,
  getRolloutPath,
  setContextSnapshot,
  setProviderSessionId,
  setRolloutPath,
  getRolloutObservedOffset,
  rememberSummary,
  emitSummary,
  onTaskComplete,
}) {
  let resolvedRolloutPath = getRolloutPath();
  let offset = Number.isInteger(getRolloutObservedOffset?.())
    ? Math.max(0, getRolloutObservedOffset())
    : 0;
  let carryover = Buffer.alloc(0);

  while (!getSettled()) {
    if (getWatchingDisabled?.()) {
      return {
        completed: false,
        rolloutPath: resolvedRolloutPath,
        offset,
      };
    }

    if (!resolvedRolloutPath) {
      const resolved = await readLatestContextSnapshot({
        threadId: getPrimaryThreadId() || getLatestThreadId(),
        providerSessionId: getProviderSessionId?.() ?? null,
        sessionsRoot: codexSessionsRoot,
        knownRolloutPath: resolvedRolloutPath,
      });
      resolvedRolloutPath = resolved.rolloutPath || resolvedRolloutPath;
      if (resolved.snapshot) {
        setContextSnapshot?.(resolved.snapshot);
        if (resolved.snapshot.session_id) {
          setProviderSessionId?.(resolved.snapshot.session_id);
        }
      }
      if (resolvedRolloutPath) {
        setRolloutPath?.(resolvedRolloutPath);
      } else {
        await sleep(rolloutPollIntervalMs);
        continue;
      }
    }

    let delta;
    try {
      delta = await readRolloutDelta({
        filePath: resolvedRolloutPath,
        offset,
        carryover,
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        await sleep(rolloutPollIntervalMs);
        continue;
      }
      throw error;
    }
    offset = delta.nextOffset;
    carryover = delta.carryover;

    let currentActiveTurnId = getActiveTurnId?.() ?? null;
    let terminalSummary = null;
    for (const line of delta.lines) {
      const taskStarted = extractRolloutTaskStartedTurnId(line.text);
      if (taskStarted.seen) {
        terminalSummary = null;
        currentActiveTurnId = taskStarted.turnId || currentActiveTurnId;
        continue;
      }

      const primaryThreadId = getPrimaryThreadId() || getLatestThreadId();
      const latestThreadId = getLatestThreadId();
      const summary = summarizeRolloutLine(line.text, {
        primaryThreadId,
        activeTurnId: currentActiveTurnId,
      });
      if (
        summary?.eventType === "rollout.task_complete"
        && currentActiveTurnId
        && summary.turnId
        && summary.turnId !== currentActiveTurnId
      ) {
        continue;
      }
      const isTerminalSummary =
        summary?.eventType === "rollout.task_complete"
        || summary?.messagePhase === "final_answer";
      if (!isTerminalSummary) {
        continue;
      }

      const shouldEmit = !getHasPrimaryFinalAnswer?.();
      const isNewSummary = rememberSummary(summary, { primaryThreadId, latestThreadId });
      if (!isNewSummary) {
        continue;
      }
      terminalSummary = summary;
      if (shouldEmit && summary.text) {
        await emitSummary(summary);
      }
    }

    if (terminalSummary) {
      await onTaskComplete(terminalSummary);
      return {
        completed: true,
        rolloutPath: resolvedRolloutPath,
        offset,
      };
    }

    await sleep(rolloutPollIntervalMs);
  }

  return {
    completed: false,
    rolloutPath: resolvedRolloutPath,
    offset,
  };
}

export async function followRolloutAfterDisconnect({
  disconnectError,
  codexSessionsRoot,
  rolloutDiscoveryTimeoutMs,
  rolloutPollIntervalMs,
  rolloutStallAfterChildExitMs,
  rolloutStallWithoutChildExitMs,
  getSettled,
  getRecoveryChildExit,
  getActiveTurnId,
  getPrimaryThreadId,
  getProviderSessionId,
  getLatestThreadId,
  getRolloutPath,
  setContextSnapshot,
  setProviderSessionId,
  setRolloutPath,
  getRolloutObservedOffset,
  isInterruptRequested,
  rememberSummary,
  emitSummary,
  onFinalAnswer,
  onTurnAborted,
}) {
  let resolvedRolloutPath = getRolloutPath();
  const rolloutPathWasKnownAtDisconnect = Boolean(resolvedRolloutPath);
  const observedOffset = getRolloutObservedOffset();
  const replayFloorOffset = rolloutPathWasKnownAtDisconnect &&
    Number.isInteger(observedOffset)
    ? observedOffset
    : 0;
  const startedAt = Date.now();

  while (!resolvedRolloutPath) {
    const resolved = await readLatestContextSnapshot({
      threadId: getPrimaryThreadId() || getLatestThreadId(),
      providerSessionId: getProviderSessionId?.() ?? null,
      sessionsRoot: codexSessionsRoot,
      knownRolloutPath: resolvedRolloutPath,
    });
    resolvedRolloutPath = resolved.rolloutPath || resolvedRolloutPath;
    if (resolved.snapshot) {
      setContextSnapshot?.(resolved.snapshot);
      if (resolved.snapshot.session_id) {
        setProviderSessionId?.(resolved.snapshot.session_id);
      }
    }
    if (resolvedRolloutPath) {
      setRolloutPath?.(resolvedRolloutPath);
      break;
    }
    if (Date.now() - startedAt >= rolloutDiscoveryTimeoutMs) {
      throw disconnectError;
    }
    await sleep(250);
  }

  let offset = rolloutPathWasKnownAtDisconnect && Number.isInteger(observedOffset)
    ? Math.max(0, observedOffset - ROLLOUT_REPLAY_OVERLAP_BYTES)
    : 0;
  let carryover = Buffer.alloc(0);
  let lastObservedGrowthAt = Date.now();

  while (!getSettled()) {
    const previousOffset = offset;
    const recoveryChildExit = getRecoveryChildExit?.();
    let delta;
    try {
      delta = await readRolloutDelta({
        filePath: resolvedRolloutPath,
        offset,
        carryover,
        flushTailAtEof: Boolean(recoveryChildExit),
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        await sleep(rolloutPollIntervalMs);
        continue;
      }
      throw error;
    }
    offset = delta.nextOffset;
    carryover = delta.carryover;
    if (offset > previousOffset) {
      lastObservedGrowthAt = Date.now();
    }

    let currentActiveTurnId = getActiveTurnId?.() ?? null;
    let terminalSummary = null;
    for (const line of delta.lines) {
      if (line.endOffset <= replayFloorOffset) {
        continue;
      }

      const taskStarted = extractRolloutTaskStartedTurnId(line.text);
      if (taskStarted.seen) {
        terminalSummary = null;
        currentActiveTurnId = taskStarted.turnId || currentActiveTurnId;
        continue;
      }

      const primaryThreadId = getPrimaryThreadId() || getLatestThreadId();
      const latestThreadId = getLatestThreadId();
      const summary = summarizeRolloutLine(line.text, {
        primaryThreadId,
        activeTurnId: currentActiveTurnId,
      });
      if (!summary) {
        continue;
      }
      if (
        (summary.eventType === "rollout.task_complete" || summary.eventType === "turn.aborted")
        && currentActiveTurnId
        && summary.turnId
        && summary.turnId !== currentActiveTurnId
      ) {
        continue;
      }
      if (!rememberSummary(summary, { primaryThreadId, latestThreadId })) {
        continue;
      }

      if (summary.eventType === "turn.aborted") {
        await onTurnAborted?.(summary);
        return {
          completed: true,
          rolloutPath: resolvedRolloutPath,
          offset,
        };
      }

      await emitSummary(summary);
      if (summary.messagePhase === "final_answer") {
        terminalSummary = summary;
      }
    }

    if (terminalSummary) {
      await onFinalAnswer();
      return {
        completed: true,
        rolloutPath: resolvedRolloutPath,
        offset,
      };
    }

    const recoveryStalledForMs = Date.now() - lastObservedGrowthAt;
    if (
      recoveryChildExit &&
      recoveryStalledForMs >= rolloutStallAfterChildExitMs
    ) {
      if (isInterruptRequested?.()) {
        await onTurnAborted?.({
          kind: "turn",
          eventType: "turn.aborted",
          text: "Codex turn aborted",
          threadId: getPrimaryThreadId() || getLatestThreadId(),
          turnId: getActiveTurnId?.() ?? null,
          abortReason: "interrupted",
        });
        return {
          completed: true,
          rolloutPath: resolvedRolloutPath,
          offset,
        };
      }

      throw new Error(
        `Codex app-server exited before rollout fallback reached a final answer (code=${recoveryChildExit.code ?? "null"}, signal=${recoveryChildExit.signal ?? "null"})`,
      );
    }

    if (
      !recoveryChildExit &&
      Number.isFinite(rolloutStallWithoutChildExitMs) &&
      rolloutStallWithoutChildExitMs > 0 &&
      recoveryStalledForMs >= rolloutStallWithoutChildExitMs
    ) {
      if (isInterruptRequested?.()) {
        await onTurnAborted?.({
          kind: "turn",
          eventType: "turn.aborted",
          text: "Codex turn aborted",
          threadId: getPrimaryThreadId() || getLatestThreadId(),
          turnId: getActiveTurnId?.() ?? null,
          abortReason: "interrupted",
        });
        return {
          completed: true,
          rolloutPath: resolvedRolloutPath,
          offset,
        };
      }

      throw new Error(
        "Codex rollout recovery stalled after websocket disconnect and no new rollout output arrived",
      );
    }

    await sleep(rolloutPollIntervalMs);
  }

  return {
    completed: false,
    rolloutPath: resolvedRolloutPath,
    offset,
  };
}
