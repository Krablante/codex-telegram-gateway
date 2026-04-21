import path from "node:path";
import process from "node:process";

import { extractPromptText, hasIncomingAttachments } from "../telegram/incoming-attachments.js";
import { buildReplyMessageParams } from "../telegram/command-parsing.js";
import { getSessionUiLanguage } from "../i18n/ui-language.js";
import { signalChildProcessTree } from "../runtime/process-tree.js";
import { markPromptAccepted } from "../runtime/service-state.js";
import { normalizeAutoModeState } from "../session-manager/auto-mode.js";
import { buildAutoFailedMessage, buildOmniTopicPrompt } from "./prompting.js";
import {
  buildTopicParams,
  combinePromptParts,
  isMissingReplyTargetError,
  summarizeAttachments,
} from "./coordinator-common.js";

export function interruptDecision(coordinator, sessionKey) {
  const child = coordinator.activeDecisionChildren.get(sessionKey);
  signalChildProcessTree(child, "SIGINT");
  const queryChild = coordinator.activeOperatorQueryChildren?.get(sessionKey);
  signalChildProcessTree(queryChild, "SIGINT");
}

export async function sendTopicMessage(
  coordinator,
  session,
  text,
  { replyToMessageId = null } = {},
) {
  const params = buildTopicParams(session, text, { replyToMessageId });
  let allowReplyTargetFallback = Boolean(params.reply_to_message_id);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await coordinator.api.sendMessage(params);
    } catch (error) {
      if (allowReplyTargetFallback && isMissingReplyTargetError(error)) {
        delete params.reply_to_message_id;
        allowReplyTargetFallback = false;
        continue;
      }

      const lifecycleResult = await coordinator.sessionLifecycleManager?.handleTransportError(
        session,
        error,
      );
      if (lifecycleResult?.handled) {
        return {
          parked: true,
          session: lifecycleResult.session || session,
          message_id: null,
        };
      }

      throw error;
    }
  }
}

export async function sendReplyMessage(
  coordinator,
  message,
  text,
  { session = null } = {},
) {
  const params = buildReplyMessageParams(message, text);
  let allowReplyTargetFallback = Boolean(params.reply_to_message_id);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await coordinator.api.sendMessage(params);
    } catch (error) {
      if (allowReplyTargetFallback && isMissingReplyTargetError(error)) {
        delete params.reply_to_message_id;
        allowReplyTargetFallback = false;
        continue;
      }

      if (!session) {
        throw error;
      }

      const lifecycleResult = await coordinator.sessionLifecycleManager?.handleTransportError(
        session,
        error,
      );
      if (lifecycleResult?.handled) {
        return {
          parked: true,
          session: lifecycleResult.session || session,
          message_id: null,
        };
      }

      throw error;
    }
  }
}

export async function buildOperatorInput(coordinator, session, message) {
  const sourceMessages = Array.isArray(message) ? message.filter(Boolean) : [message];
  const parts = [];

  for (const entry of sourceMessages) {
    const promptText = extractPromptText(entry);
    const attachments = hasIncomingAttachments(entry)
      ? await coordinator.sessionService.ingestIncomingAttachments(
        coordinator.api,
        session,
        entry,
      )
      : [];
    const part = combinePromptParts([
      summarizeAttachments(attachments),
      promptText,
    ]);
    if (part) {
      parts.push(part);
    }
  }

  return combinePromptParts(parts);
}

export async function sendPromptToSpike(
  coordinator,
  session,
  workerPrompt,
  {
    mode = "continuation",
    pendingUserInput = null,
    decisionMode = null,
    omniMemory = null,
    successPatch = {},
  } = {},
) {
  const autoMode = normalizeAutoModeState(session.auto_mode);
  const now = new Date().toISOString();
  const currentMemory = omniMemory || (await coordinator.loadOmniMemory(session));
  const useFullGoalContext = mode === "initial" || !session.codex_thread_id;
  const composedPrompt = buildOmniTopicPrompt({
    autoMode,
    initialWorkerPrompt: workerPrompt,
    pendingUserInput,
    session,
    mode,
    omniMemory: currentMemory,
    decisionMode,
    useFullGoalContext,
  });

  markPromptAccepted(coordinator.serviceState);
  await coordinator.promptHandoffStore.queue(session, {
    mode,
    prompt: composedPrompt,
  });

  const updatedSession = await coordinator.sessionService.updateAutoMode(
    session,
    ({ autoMode: currentAutoMode }) => ({
      ...successPatch,
      enabled: true,
      phase: "running",
      blocked_reason: null,
      pending_user_input: null,
      first_omni_prompt_at: currentAutoMode.first_omni_prompt_at ?? now,
      continuation_count_since_compact:
        currentAutoMode.continuation_count_since_compact + 1,
      sleep_until: null,
      sleep_next_prompt: null,
      last_omni_prompt_message_id: null,
    }),
  );
  await coordinator.omniMemoryStore?.patch(updatedSession, (latestMemory) => ({
    first_omni_prompt_at: latestMemory.first_omni_prompt_at || now,
    last_prompt_dispatched_at: now,
    continuation_count_since_compact:
      latestMemory.continuation_count_since_compact + 1,
    last_decision_mode: decisionMode || latestMemory.last_decision_mode,
    primary_next_action: workerPrompt,
  }));

  return updatedSession;
}

export async function failBrokenSleepState(coordinator, session, reason) {
  const failedSession = await coordinator.sessionService.markAutoDecision(session, {
    phase: "failed",
    resultSummary: reason,
    clearPendingUserInput: false,
  });
  await coordinator.sendTopicMessage(
    failedSession,
    buildAutoFailedMessage(reason, getSessionUiLanguage(failedSession)),
  );
  return failedSession;
}

export async function shutdown(coordinator) {
  for (const child of coordinator.activeDecisionChildren.values()) {
    signalChildProcessTree(child, "SIGINT");
  }
  for (const child of coordinator.activeOperatorQueryChildren?.values() || []) {
    signalChildProcessTree(child, "SIGINT");
  }
}
