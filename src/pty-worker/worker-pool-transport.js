import { getSessionUiLanguage } from "../i18n/ui-language.js";
import {
  appendPromptPart,
  buildProgressText,
  buildPromptWithAttachments,
  buildSteerInput,
  resolveReplyToMessageId,
} from "./worker-pool-common.js";

const TYPING_ACTION_INTERVAL_MS = 4000;

export async function flushPendingLiveSteer(pool, sessionKey, run) {
  const pending = pool.pendingLiveSteers.get(sessionKey);
  if (!pending || typeof run?.controller?.steer !== "function") {
    return false;
  }

  const result = await run.controller.steer({
    input: pending.input,
  });
  if (result?.ok === false) {
    return false;
  }

  pool.pendingLiveSteers.delete(sessionKey);
  run.exchangePrompt = appendPromptPart(run.exchangePrompt, pending.exchangePrompt);
  if (Number.isInteger(pending.replyToMessageId)) {
    run.state.replyToMessageId = pending.replyToMessageId;
  }

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
    return run.controller.steer({ input })
      .then((result) => {
        if (result?.ok) {
          run.exchangePrompt = appendPromptPart(run.exchangePrompt, exchangePrompt);
          const replyTargetMessageId = resolveReplyToMessageId(message);
          if (Number.isInteger(replyTargetMessageId)) {
            run.state.replyToMessageId = replyTargetMessageId;
          }
        }

        return result;
      })
      .catch((error) => ({
        ok: false,
        reason: "steer-failed",
        error,
      }));
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
  if (typeof pool.api.sendChatAction !== "function") {
    return;
  }

  if (!["starting", "running", "rebuilding"].includes(run.state.status)) {
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
