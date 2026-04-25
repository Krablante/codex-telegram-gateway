import { getSessionUiLanguage } from "../i18n/ui-language.js";
import {
  appendPromptPart,
  buildProgressText,
  buildPromptWithAttachments,
  buildSteerInput,
  resolveReplyToMessageId,
} from "./worker-pool-common.js";

const TYPING_ACTION_INTERVAL_MS = 4000;
const LIVE_STEER_RETRY_DELAYS_MS = [150, 350, 750];
const LIVE_STEER_RETRY_REASONS = new Set([
  "steer-failed",
  "transport-recovering",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRunStillSteerable(pool, sessionKey, run) {
  return pool.activeRuns.get(sessionKey) === run && !run?.state?.finalizing;
}

function applyAcceptedSteer({
  exchangePrompt,
  input,
  message,
  run,
}) {
  run.exchangePrompt = appendPromptPart(run.exchangePrompt, exchangePrompt);
  run.state.acceptedLiveSteerCount =
    (Number(run.state.acceptedLiveSteerCount) || 0) + 1;
  if (Array.isArray(input) && input.length > 0) {
    const nextImagePaths = new Set(run.state.liveSteerImagePaths || []);
    for (const item of input) {
      if (item?.type === "localImage" && item.path) {
        nextImagePaths.add(item.path);
      }
    }
    run.state.liveSteerImagePaths = Array.from(nextImagePaths);
  }
  const replyTargetMessageId = resolveReplyToMessageId(message);
  if (Number.isInteger(replyTargetMessageId)) {
    run.state.replyToMessageId = replyTargetMessageId;
  }
}

async function steerRunWithRetry(
  pool,
  {
    exchangePrompt,
    input,
    message,
    run,
    sessionKey,
  },
) {
  let result = null;
  let error = null;

  for (let attempt = 0; attempt <= LIVE_STEER_RETRY_DELAYS_MS.length; attempt += 1) {
    if (!isRunStillSteerable(pool, sessionKey, run)) {
      return { ok: false, reason: "finalizing" };
    }

    try {
      result = await run.controller.steer({ input });
      error = null;
    } catch (nextError) {
      result = null;
      error = nextError;
    }

    if (result?.ok) {
      applyAcceptedSteer({
        exchangePrompt,
        input,
        message,
        run,
      });
      return result;
    }

    const failureReason = result?.reason || "steer-failed";
    if (
      attempt >= LIVE_STEER_RETRY_DELAYS_MS.length
      || !LIVE_STEER_RETRY_REASONS.has(failureReason)
    ) {
      return result || {
        ok: false,
        reason: "steer-failed",
        error,
      };
    }

    await sleep(LIVE_STEER_RETRY_DELAYS_MS[attempt]);
  }

  return result || {
    ok: false,
    reason: "steer-failed",
    error,
  };
}

export async function flushPendingLiveSteer(pool, sessionKey, run) {
  const pending = pool.pendingLiveSteers.get(sessionKey);
  if (!pending || typeof run?.controller?.steer !== "function") {
    return false;
  }

  const result = await steerRunWithRetry(pool, {
    exchangePrompt: pending.exchangePrompt,
    input: pending.input,
    message: Number.isInteger(pending.replyToMessageId)
      ? { message_id: pending.replyToMessageId }
      : null,
    run,
    sessionKey,
  });
  if (!result?.ok) {
    return false;
  }

  pool.pendingLiveSteers.delete(sessionKey);
  return true;
}

export function steerActiveRun(
  pool,
  {
    session,
    rawPrompt = "",
    message = null,
    attachments = [],
  },
) {
  const sessionKey = session?.session_key;
  if (!sessionKey) {
    return { ok: false, reason: "missing-session-key" };
  }

  const run = pool.activeRuns.get(sessionKey);
  if (!run && !pool.startingRuns.has(sessionKey)) {
    return { ok: false, reason: "idle" };
  }

  const normalizedPrompt = String(rawPrompt || "").trim();
  const normalizedAttachments = Array.isArray(attachments)
    ? attachments.filter(Boolean)
    : [];
  if (!normalizedPrompt && normalizedAttachments.length === 0) {
    return { ok: false, reason: "empty" };
  }

  const exchangePrompt = buildPromptWithAttachments(
    normalizedPrompt,
    normalizedAttachments,
    getSessionUiLanguage(session),
  );
  const input = buildSteerInput(
    normalizedPrompt,
    normalizedAttachments,
    getSessionUiLanguage(session),
  );
  if (input.length === 0) {
    return { ok: false, reason: "empty" };
  }

  if (run?.state?.finalizing) {
    return { ok: false, reason: "finalizing" };
  }

  if (run?.controller && typeof run.controller.steer === "function") {
    return steerRunWithRetry(pool, {
      exchangePrompt,
      input,
      message,
      run,
      sessionKey,
    });
  }

  const pending = pool.pendingLiveSteers.get(sessionKey) || {
    input: [],
    exchangePrompt: "",
    replyToMessageId: null,
  };
  if (!pool.startingRuns.has(sessionKey)) {
    return { ok: false, reason: "finalizing" };
  }
  pending.input.push(...input);
  pending.exchangePrompt = appendPromptPart(pending.exchangePrompt, exchangePrompt);
  const replyTargetMessageId = resolveReplyToMessageId(message);
  if (Number.isInteger(replyTargetMessageId)) {
    pending.replyToMessageId = replyTargetMessageId;
  }
  pool.pendingLiveSteers.set(sessionKey, pending);

  return {
    ok: true,
    reason: "steer-buffered",
    inputCount: pending.input.length,
  };
}

export function startProgressLoop(pool, run) {
  const timer = setInterval(() => {
    void pool.sendTypingAction(run);
  }, TYPING_ACTION_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

export function stopProgressLoop(run) {
  if (!run?.progressTimer) {
    return;
  }

  clearInterval(run.progressTimer);
  run.progressTimer = null;
}

export async function finalizeProgress(run) {
  try {
    await run.state.progress.finalize(
      buildProgressText(run.state, getSessionUiLanguage(run.session)),
    );
  } catch {
    // Final reply delivery should not depend on one last progress edit.
  }
}

export async function sendTypingAction(pool, run) {
  if (!["starting", "running", "rebuilding"].includes(run.state.status)) {
    return;
  }

  run.state.progress?.queueUpdate(
    buildProgressText(run.state, getSessionUiLanguage(run.session)),
  );

  if (typeof pool.api.sendChatAction !== "function") {
    return;
  }

  if (run.state.typingActionInFlight) {
    return;
  }

  const now = Date.now();
  if (now - run.state.lastTypingActionAt < TYPING_ACTION_INTERVAL_MS) {
    return;
  }

  run.state.typingActionInFlight = true;
  try {
    await pool.api.sendChatAction({
      chat_id: Number(run.session.chat_id),
      message_thread_id: Number(run.session.topic_id),
      action: "typing",
    });
    run.state.lastTypingActionAt = Date.now();
  } catch (error) {
    if (pool.sessionLifecycleManager) {
      await pool.sessionLifecycleManager.handleTransportError(run.session, error);
    }
  } finally {
    run.state.typingActionInFlight = false;
  }
}
