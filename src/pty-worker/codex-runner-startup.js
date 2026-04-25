import fs from "node:fs/promises";

import { readLatestContextSnapshot } from "../session-manager/context-snapshot.js";
import { waitForListenUrl } from "./codex-runner-transport.js";
import {
  finishInterruptedTurn,
  publishRuntimeState,
  shutdownTransport,
  startRolloutTaskCompleteWatcher,
} from "./codex-runner-lifecycle.js";
import { schedulePendingSteerFlush } from "./codex-runner-steer.js";
import { connectRpcTransport } from "./codex-runner-transport-lifecycle.js";
import {
  findInProgressTurn,
  findLatestHistoricalThread,
  isIrrecoverableResumeError,
  normalizeOptionalText,
} from "./codex-runner-thread-history.js";

export async function startCodexTaskStartup(context) {
  context.state.listenUrl = await waitForListenUrl(
    context.stdoutReader,
    context.stderrReader,
    context.child,
    { timeoutMs: context.appServerBootTimeoutMs },
  );
  await connectRpcTransport(context);
  let resumeThreadId = normalizeOptionalText(context.sessionThreadId);
  const normalizedSessionKey = normalizeOptionalText(context.sessionKey);
  const continuityHintsPresent = Boolean(
    resumeThreadId
    || context.state.latestProviderSessionId
    || context.state.rolloutPath
    || normalizedSessionKey,
  );
  if (!context.skipThreadHistoryLookup) {
    try {
      const historicalThread = await findLatestHistoricalThread({
        rpc: context.state.rpc,
        cwd: context.cwd,
        sessionKey: context.sessionKey,
        providerSessionId: context.state.latestProviderSessionId,
        knownRolloutPath: context.state.rolloutPath,
      });
      if (historicalThread?.threadId) {
        resumeThreadId = historicalThread.threadId;
      }
      if (historicalThread?.rolloutPath) {
        context.state.rolloutPath = historicalThread.rolloutPath;
      }
      if (historicalThread?.providerSessionId) {
        context.state.latestProviderSessionId = historicalThread.providerSessionId;
      }
    } catch (error) {
      if (continuityHintsPresent) {
        throw new Error(
          `Codex thread history lookup failed before resume: ${error.message}`,
          { cause: error },
        );
      }
    }
  }

  let threadResponse;
  try {
    threadResponse = resumeThreadId
      ? await context.state.rpc.request("thread/resume", {
          ...context.threadParams,
          threadId: resumeThreadId,
        })
      : await context.state.rpc.request("thread/start", context.threadParams);
  } catch (error) {
    if (resumeThreadId && isIrrecoverableResumeError(error)) {
      context.state.resumeReplacement = {
        requestedThreadId: resumeThreadId,
        replacementThreadId: null,
        reason: "missing-thread",
      };
      shutdownTransport(context);
      context.finish({
        exitCode: 0,
        signal: null,
        providerSessionId: context.state.latestProviderSessionId,
        rolloutPath: context.state.rolloutPath,
        contextSnapshot: context.state.latestContextSnapshot,
        threadId: context.state.latestThreadId,
        warnings: context.state.warnings,
        resumeReplacement: context.state.resumeReplacement,
      });
      return;
    }

    throw error;
  }

  context.state.latestThreadId = threadResponse?.thread?.id || context.state.latestThreadId;
  context.state.primaryThreadId = context.state.latestThreadId;
  const latestContext = await readLatestContextSnapshot({
    threadId: context.state.primaryThreadId,
    providerSessionId: context.state.latestProviderSessionId,
    sessionsRoot: context.codexSessionsRoot,
    knownRolloutPath: context.state.rolloutPath,
  });
  context.state.rolloutPath = latestContext.rolloutPath || context.state.rolloutPath;
  context.state.latestContextSnapshot = latestContext.snapshot || context.state.latestContextSnapshot;
  context.state.latestProviderSessionId =
    latestContext.snapshot?.session_id || context.state.latestProviderSessionId;
  if (context.state.rolloutPath) {
    try {
      context.state.rolloutObservedOffset = await fs.stat(context.state.rolloutPath)
        .then((stats) => stats.size);
    } catch {}
  }
  await publishRuntimeState(context, {
    threadId: context.state.latestThreadId,
    providerSessionId: context.state.latestProviderSessionId,
    rolloutPath: context.state.rolloutPath,
    contextSnapshot: context.state.latestContextSnapshot,
  });

  const openTurn = resumeThreadId
    ? findInProgressTurn(threadResponse?.thread)
    : null;
  if (openTurn) {
    context.state.activeTurnId = normalizeOptionalText(openTurn.id) || context.state.activeTurnId;
    await publishRuntimeState(context, {
      threadId: context.state.latestThreadId,
      activeTurnId: context.state.activeTurnId,
      providerSessionId: context.state.latestProviderSessionId,
      rolloutPath: context.state.rolloutPath,
      contextSnapshot: context.state.latestContextSnapshot,
    });
    startRolloutTaskCompleteWatcher(context);
    schedulePendingSteerFlush(context);
    return;
  }

  const turnResponse = await context.state.rpc.request("turn/start", {
    threadId: context.state.latestThreadId,
    input: context.initialInput,
  });
  context.state.activeTurnId = turnResponse?.turn?.id || context.state.activeTurnId;
  await publishRuntimeState(context, {
    threadId: context.state.latestThreadId,
    activeTurnId: context.state.activeTurnId,
    providerSessionId: context.state.latestProviderSessionId,
    rolloutPath: context.state.rolloutPath,
    contextSnapshot: context.state.latestContextSnapshot,
  });
  startRolloutTaskCompleteWatcher(context);
  schedulePendingSteerFlush(context);
}

export function handleStartupFailure(context, error) {
  shutdownTransport(context);
  if (context.state.interruptRequested) {
    finishInterruptedTurn(context, {
      threadId: context.state.latestThreadId || context.state.primaryThreadId || context.sessionThreadId || null,
      interruptReason: "user",
      abortReason: "interrupted",
      resumeReplacement: null,
    });
    return;
  }
  context.fail(error);
}
