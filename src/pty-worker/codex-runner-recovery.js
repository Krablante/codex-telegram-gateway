import fs from "node:fs/promises";

import { readLatestContextSnapshot } from "../session-manager/context-snapshot.js";
import { safeJsonParse } from "./codex-runner-common.js";

const ROLLOUT_REPLAY_OVERLAP_BYTES = 64 * 1024;

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

  return null;
}

export async function readRolloutDelta({
  filePath,
  offset,
  carryover,
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
}

export async function followRolloutAfterDisconnect({
  disconnectError,
  codexSessionsRoot,
  rolloutDiscoveryTimeoutMs,
  rolloutPollIntervalMs,
  rolloutStallAfterChildExitMs,
  getSettled,
  getRecoveryChildExit,
  getActiveTurnId,
  getPrimaryThreadId,
  getLatestThreadId,
  getRolloutPath,
  setRolloutPath,
  getRolloutObservedOffset,
  rememberSummary,
  emitSummary,
  onFinalAnswer,
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
      sessionsRoot: codexSessionsRoot,
      knownRolloutPath: resolvedRolloutPath,
    });
    resolvedRolloutPath = resolved.rolloutPath || resolvedRolloutPath;
    if (resolvedRolloutPath) {
      setRolloutPath?.(resolvedRolloutPath);
      break;
    }
    if (Date.now() - startedAt >= rolloutDiscoveryTimeoutMs) {
      throw disconnectError;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  let offset = rolloutPathWasKnownAtDisconnect && Number.isInteger(observedOffset)
    ? Math.max(0, observedOffset - ROLLOUT_REPLAY_OVERLAP_BYTES)
    : 0;
  let carryover = Buffer.alloc(0);
  let lastObservedGrowthAt = Date.now();

  while (!getSettled()) {
    const previousOffset = offset;
    const delta = await readRolloutDelta({
      filePath: resolvedRolloutPath,
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

      const primaryThreadId = getPrimaryThreadId() || getLatestThreadId();
      const latestThreadId = getLatestThreadId();
      const summary = summarizeRolloutLine(line.text, {
        primaryThreadId,
        activeTurnId: getActiveTurnId?.() ?? null,
      });
      if (!summary) {
        continue;
      }
      if (!rememberSummary(summary, { primaryThreadId, latestThreadId })) {
        continue;
      }

      await emitSummary(summary);
      if (summary.messagePhase === "final_answer") {
        await onFinalAnswer();
        return {
          completed: true,
          rolloutPath: resolvedRolloutPath,
          offset,
        };
      }
    }

    const recoveryChildExit = getRecoveryChildExit?.();
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

  return {
    completed: false,
    rolloutPath: resolvedRolloutPath,
    offset,
  };
}
