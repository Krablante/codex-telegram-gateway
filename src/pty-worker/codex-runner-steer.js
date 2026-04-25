import {
  findInProgressTurn,
  findLatestTurn,
  isNoActiveTurnSteerError,
  isSteerRequestTimeoutError,
  normalizeOptionalText,
  sleep,
} from "./codex-runner-thread-history.js";
import { publishRuntimeState } from "./codex-runner-lifecycle.js";

async function refreshActiveTurnFromThreadResume(context) {
  if (!context.state.rpc || !context.state.latestThreadId) {
    return null;
  }

  try {
    const resumed = await context.state.rpc.request("thread/resume", {
      ...context.threadParams,
      threadId: context.state.latestThreadId,
    });
    context.state.latestThreadId = normalizeOptionalText(resumed?.thread?.id) || context.state.latestThreadId;
    context.state.primaryThreadId = context.state.primaryThreadId || context.state.latestThreadId;
    const resumedOpenTurn = findInProgressTurn(resumed?.thread);
    const resumedLatestTurn = findLatestTurn(resumed?.thread);
    context.state.activeTurnId =
      normalizeOptionalText(resumedOpenTurn?.id)
      || (
        normalizeOptionalText(resumedLatestTurn?.status) === "inProgress"
          ? normalizeOptionalText(resumedLatestTurn?.id)
          : null
      )
      || null;
    await publishRuntimeState(context, {
      threadId: context.state.latestThreadId,
      activeTurnId: context.state.activeTurnId,
      providerSessionId: context.state.latestProviderSessionId,
      rolloutPath: context.state.rolloutPath,
      contextSnapshot: context.state.latestContextSnapshot,
    });
    return context.state.activeTurnId;
  } catch {
    return null;
  }
}

async function flushPendingSteers(context) {
  if (
    !context.state.rpc
    || !context.state.latestThreadId
    || !context.state.activeTurnId
    || context.state.pendingSteerInputs.length === 0
  ) {
    return {
      ok: true,
      reason: "steer-buffered",
      inputCount: context.state.pendingSteerInputs.length,
    };
  }

  const input = context.state.pendingSteerInputs.splice(0, context.state.pendingSteerInputs.length);
  let lastNoActiveTurnError = null;

  for (let attempt = 0; attempt <= context.steerActiveTurnRefreshRetryDelaysMs.length; attempt += 1) {
    const expectedTurnId = context.state.activeTurnId;
    if (!context.state.rpc || !context.state.latestThreadId || !expectedTurnId) {
      if (attempt >= context.steerActiveTurnRefreshRetryDelaysMs.length) {
        break;
      }
      await sleep(context.steerActiveTurnRefreshRetryDelaysMs[attempt]);
      await refreshActiveTurnFromThreadResume(context);
      continue;
    }

    try {
      const steerResponse = await context.state.rpc.request("turn/steer", {
        threadId: context.state.latestThreadId,
        expectedTurnId,
        input,
      }, {
        timeoutMs: context.steerRequestTimeoutMs,
      });
      context.state.activeTurnId =
        steerResponse?.turn?.id
        || steerResponse?.turnId
        || expectedTurnId;

      return {
        ok: true,
        reason: "steered",
        inputCount: input.length,
        turnId: context.state.activeTurnId,
        threadId: context.state.latestThreadId,
      };
    } catch (error) {
      if (!isNoActiveTurnSteerError(error)) {
        context.state.pendingSteerInputs.unshift(...input);
        throw error;
      }

      lastNoActiveTurnError = error;
      context.state.activeTurnId = null;
      if (attempt >= context.steerActiveTurnRefreshRetryDelaysMs.length) {
        break;
      }
      await sleep(context.steerActiveTurnRefreshRetryDelaysMs[attempt]);
      await refreshActiveTurnFromThreadResume(context);
    }
  }

  context.state.pendingSteerInputs.unshift(...input);
  throw lastNoActiveTurnError || new Error("no active turn to steer");
}

function runPendingSteerFlush(context) {
  context.state.flushChain = context.state.flushChain
    .catch(() => {})
    .then(() => flushPendingSteers(context));
  return context.state.flushChain;
}

export function schedulePendingSteerFlush(context) {
  void runPendingSteerFlush(context).catch((error) => {
    const message = `pending steer flush failed: ${error?.message || error}`;
    context.state.warnings.push(message);
    context.onWarning?.(message);
  });
}

export function queueSteer(context, input = []) {
  const normalizedInput = Array.isArray(input) ? input.filter(Boolean) : [];
  if (normalizedInput.length === 0) {
    return Promise.resolve({ ok: false, reason: "empty" });
  }

  context.state.pendingSteerInputs.push(...normalizedInput);

  if (context.state.recoveringFromDisconnect) {
    return Promise.resolve({
      ok: true,
      reason: "steer-buffered",
      inputCount: normalizedInput.length,
    });
  }

  if (!context.state.rpc || !context.state.latestThreadId || !context.state.activeTurnId) {
    return Promise.resolve({
      ok: true,
      reason: "steer-buffered",
      inputCount: normalizedInput.length,
    });
  }

  return runPendingSteerFlush(context).catch((error) => ({
    ok: false,
    reason: isSteerRequestTimeoutError(error) ? "steer-timeout" : "steer-failed",
    error,
  }));
}
