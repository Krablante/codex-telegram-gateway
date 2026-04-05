import path from "node:path";

import {
  buildReplyMessageParams,
  extractBotCommand,
  isForeignBotCommand,
  isAuthorizedForumMessageFromHuman,
} from "../telegram/command-parsing.js";
import { buildNoSessionTopicMessage } from "../telegram/command-router.js";
import { getSessionUiLanguage } from "../i18n/ui-language.js";
import { startCodexExecRun } from "../codex-exec/exec-runner.js";
import { OmniMemoryStore } from "./memory.js";
import {
  buildAutoContinuationDispatchMessage,
  buildAutoDisabledMessage,
  buildAutoGoalCapturedMessage,
  buildAutoInitialPromptAcceptedMessage,
  buildAutoQueuedInputAcceptedMessage,
  buildAutoSetupInputExpectedMessage,
  buildAutoSetupStartedMessage,
  buildAutoStatusMessage,
} from "./prompting.js";
import {
  isAutoModeTerminalPhase,
  normalizeAutoModeState,
} from "../session-manager/auto-mode.js";
import {
  buildOmniQueryUnavailableMessage,
  buildRuntimeSettingsProxyMessage,
  hasOmniQueryContext,
  isExplicitCommandForCurrentBot,
  isManualFlushShortcut,
  looksLikeDirectOmniQuestion,
  parseAutoCommandArgs,
  SPIKE_RUNTIME_SETTING_COMMANDS,
} from "./coordinator-common.js";
import {
  buildOperatorInput,
  failBrokenSleepState,
  interruptDecision,
  sendPromptToSpike,
  sendReplyMessage,
  sendTopicMessage,
  shutdown,
} from "./coordinator-delivery.js";
import {
  answerOmniQuery,
  evaluateSession,
  resumeDueSleepingSessions,
  scanPendingSpikeFinals,
} from "./coordinator-decision-flow.js";
import {
  loadOmniMemory,
  maybeAutoCompactBeforeContinuation,
  resetOmniMemory,
  seedOmniMemoryFromGoal,
  shouldAutoCompact,
  updateOmniMemoryFromDecision,
} from "./coordinator-memory.js";

export class OmniCoordinator {
  constructor({
    api,
    config,
    omniMemoryStore = null,
    promptHandoffStore,
    serviceState,
    sessionService,
    sessionStore,
    sessionLifecycleManager = null,
    spikeFinalEventStore,
    omniBotId,
    spikeBotId,
    startExecRun = startCodexExecRun,
  }) {
    this.api = api;
    this.config = config;
    this.omniMemoryStore = omniMemoryStore || new OmniMemoryStore(sessionStore);
    this.promptHandoffStore = promptHandoffStore;
    this.serviceState = serviceState;
    this.sessionService = sessionService;
    this.sessionStore = sessionStore;
    this.sessionLifecycleManager = sessionLifecycleManager;
    this.spikeFinalEventStore = spikeFinalEventStore;
    this.omniBotId = String(omniBotId);
    this.spikeBotId = String(spikeBotId);
    this.startExecRun = startExecRun;
    this.activeEvaluations = new Set();
    this.activeDecisionChildren = new Map();
    this.activeOperatorQueries = new Set();
    this.omniRunsRoot = path.join(this.config.stateRoot, "omni", "runs");
  }

  interruptDecision(sessionKey) {
    return interruptDecision(this, sessionKey);
  }

  async sendTopicMessage(session, text, options = {}) {
    return sendTopicMessage(this, session, text, options);
  }

  async sendReplyMessage(message, text, options = {}) {
    return sendReplyMessage(this, message, text, options);
  }

  async loadOmniMemory(session) {
    return loadOmniMemory(this, session);
  }

  async resetOmniMemory(session) {
    return resetOmniMemory(this, session);
  }

  async seedOmniMemoryFromGoal(session) {
    return seedOmniMemoryFromGoal(this, session);
  }

  async updateOmniMemoryFromDecision(session, decision, options = {}) {
    return updateOmniMemoryFromDecision(this, session, decision, options);
  }

  shouldAutoCompact(autoMode) {
    return shouldAutoCompact(autoMode, this);
  }

  async maybeAutoCompactBeforeContinuation(session) {
    return maybeAutoCompactBeforeContinuation(this, session);
  }

  async buildOperatorInput(session, message) {
    return buildOperatorInput(this, session, message);
  }

  async handleAutoCommand(message, args) {
    const topicId = message?.message_thread_id;
    if (!topicId) {
      await this.api.sendMessage(
        buildReplyMessageParams(message, buildNoSessionTopicMessage()),
      );
      return { handled: true, reason: "general-topic" };
    }

    let session = await this.sessionService.ensureRunnableSessionForMessage(message);
    const language = getSessionUiLanguage(session);
    const action = parseAutoCommandArgs(args);

    if (action.action === "invalid") {
      const delivery = await this.sendReplyMessage(
        message,
        language === "eng"
          ? "Use /auto, /auto status, or /auto off."
          : "Используй /auto, /auto status или /auto off.",
        { session },
      );
      if (delivery?.parked) {
        return { handled: true, reason: "topic-unavailable" };
      }
      return { handled: true, reason: "invalid-auto-command" };
    }

    if (action.action === "off") {
      this.interruptDecision(session.session_key);
      session = await this.sessionService.clearAutoMode(session);
      await this.spikeFinalEventStore.clear(session);
      await this.promptHandoffStore.clear(session);
      await this.resetOmniMemory(session);
      const delivery = await this.sendReplyMessage(
        message,
        buildAutoDisabledMessage(language),
        { session },
      );
      if (delivery?.parked) {
        return { handled: true, reason: "topic-unavailable" };
      }
      return { handled: true, reason: "auto-disabled" };
    }

    if (action.action === "status") {
      const current =
        (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
      const delivery = await this.sendReplyMessage(
        message,
        buildAutoStatusMessage(current),
        { session: current },
      );
      if (delivery?.parked) {
        return { handled: true, reason: "topic-unavailable" };
      }
      return { handled: true, reason: "auto-status" };
    }

    const autoMode = normalizeAutoModeState(session.auto_mode);
    if (autoMode.enabled) {
      const delivery = await this.sendReplyMessage(
        message,
        buildAutoStatusMessage(session),
        { session },
      );
      if (delivery?.parked) {
        return { handled: true, reason: "topic-unavailable" };
      }
      return { handled: true, reason: "auto-already-enabled" };
    }

    session = await this.sessionService.activateAutoMode(session, {
      activatedByUserId: message.from?.id ?? null,
      omniBotId: this.omniBotId,
      spikeBotId: this.spikeBotId,
    });
    await this.resetOmniMemory(session);
    const delivery = await this.sendReplyMessage(
      message,
      buildAutoSetupStartedMessage(language),
      { session },
    );
    if (delivery?.parked) {
      return { handled: true, reason: "topic-unavailable" };
    }
    return { handled: true, reason: "auto-armed" };
  }

  async handleOmniQueryCommand(message, rawArgs) {
    const topicId = message?.message_thread_id;
    if (!topicId) {
      await this.api.sendMessage(
        buildReplyMessageParams(message, buildNoSessionTopicMessage()),
      );
      return { handled: true, reason: "general-topic" };
    }

    const session = await this.sessionService.ensureRunnableSessionForMessage(message);
    if (!hasOmniQueryContext(session)) {
      const delivery = await this.sendReplyMessage(
        message,
        buildOmniQueryUnavailableMessage(getSessionUiLanguage(session)),
        { session },
      );
      if (delivery?.parked) {
        return { handled: true, reason: "topic-unavailable" };
      }
      return { handled: true, reason: "omni-query-unavailable" };
    }

    const language = getSessionUiLanguage(session);
    const autoMode = normalizeAutoModeState(session.auto_mode);
    const operatorQuestion = String(rawArgs || "").trim()
      || (language === "eng"
        ? "Describe what the latest Spike turn achieved, what remains, and what Omni plans next."
        : "Опиши, чего достиг последний ход Spike, что осталось и какой следующий шаг планирует Omni.");

    return this.answerOmniQuery({
      autoMode,
      language,
      message,
      operatorQuestion,
      session,
    });
  }

  async answerOmniQuery(args) {
    return answerOmniQuery(this, args);
  }

  async handleBufferedHumanMessages(messages) {
    const bufferedMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
    const message = bufferedMessages.at(-1) ?? null;
    if (!message) {
      return { handled: false, reason: "missing-message" };
    }

    return this.handleHumanMessage(message, { inputMessages: bufferedMessages });
  }

  async handleHumanMessage(message, { inputMessages = null } = {}) {
    if (!isAuthorizedForumMessageFromHuman(message, this.config)) {
      return { handled: false, reason: "unauthorized" };
    }

    const command = extractBotCommand(message, this.serviceState.botUsername);
    const foreignBotCommand = !command
      && isForeignBotCommand(message, this.serviceState.botUsername);
    if (command?.name === "auto") {
      return this.handleAutoCommand(message, command.args);
    }
    if (command?.name === "omni") {
      return this.handleOmniQueryCommand(message, command.args);
    }
    if (
      command &&
      SPIKE_RUNTIME_SETTING_COMMANDS.has(command.name) &&
      isExplicitCommandForCurrentBot(message, this.serviceState.botUsername)
    ) {
      const topicSession =
        message?.message_thread_id &&
        typeof this.sessionService.ensureSessionForMessage === "function"
          ? await this.sessionService.ensureSessionForMessage(message)
          : null;
      const delivery = await this.sendReplyMessage(
        message,
        buildRuntimeSettingsProxyMessage(getSessionUiLanguage(topicSession)),
        { session: topicSession },
      );
      if (delivery?.parked) {
        return { handled: true, reason: "topic-unavailable" };
      }
      return {
        handled: true,
        reason: "runtime-setting-command-owned-by-spike",
      };
    }
    if (command) {
      return { handled: false, reason: "non-omni-command" };
    }
    if (foreignBotCommand) {
      return { handled: false, reason: "foreign-bot-command" };
    }

    const topicId = message?.message_thread_id;
    if (!topicId) {
      return { handled: false, reason: "general-topic" };
    }

    let session = await this.sessionService.ensureRunnableSessionForMessage(message);
    const autoMode = normalizeAutoModeState(session.auto_mode);
    if (!autoMode.enabled) {
      return { handled: false, reason: "auto-disabled" };
    }
    if (isAutoModeTerminalPhase(autoMode.phase)) {
      return { handled: false, reason: "auto-terminal-phase" };
    }

    const operatorInput = await this.buildOperatorInput(
      session,
      inputMessages || message,
    );
    if (!operatorInput) {
      return { handled: true, reason: "empty-operator-input" };
    }

    if (autoMode.phase === "await_goal") {
      if (isManualFlushShortcut(operatorInput)) {
        const delivery = await this.sendReplyMessage(
          message,
          buildAutoSetupInputExpectedMessage(
            "goal",
            getSessionUiLanguage(session),
          ),
          { session },
        );
        if (delivery?.parked) {
          return { handled: true, reason: "topic-unavailable" };
        }
        return { handled: true, reason: "auto-goal-flush-ignored" };
      }

      session = await this.sessionService.captureAutoGoal(session, operatorInput);
      await this.seedOmniMemoryFromGoal(session);
      const delivery = await this.sendReplyMessage(
        message,
        buildAutoGoalCapturedMessage(getSessionUiLanguage(session)),
        { session },
      );
      if (delivery?.parked) {
        return { handled: true, reason: "topic-unavailable" };
      }
      return { handled: true, reason: "auto-goal-captured" };
    }

    if (autoMode.phase === "await_initial_prompt") {
      if (isManualFlushShortcut(operatorInput)) {
        const delivery = await this.sendReplyMessage(
          message,
          buildAutoSetupInputExpectedMessage(
            "initial_prompt",
            getSessionUiLanguage(session),
          ),
          { session },
        );
        if (delivery?.parked) {
          return { handled: true, reason: "topic-unavailable" };
        }
        return { handled: true, reason: "auto-initial-prompt-flush-ignored" };
      }

      session = await this.sessionService.captureAutoInitialPrompt(
        session,
        operatorInput,
      );
      const sent = await this.sendPromptToSpike(session, operatorInput, {
        mode: "initial",
      });
      if (sent?.parked) {
        return { handled: true, reason: "auto-initial-prompt-parked" };
      }

      const delivery = await this.sendReplyMessage(
        message,
        buildAutoInitialPromptAcceptedMessage(getSessionUiLanguage(sent || session)),
        { session: sent || session },
      );
      if (delivery?.parked) {
        return { handled: true, reason: "topic-unavailable" };
      }
      return { handled: true, reason: "auto-initial-prompt-sent" };
    }

    if (
      ["running", "sleeping", "evaluating"].includes(autoMode.phase) &&
      looksLikeDirectOmniQuestion(operatorInput)
    ) {
      return this.answerOmniQuery({
        autoMode,
        language: getSessionUiLanguage(session),
        message,
        operatorQuestion: operatorInput,
        session,
      });
    }

    session = await this.sessionService.queueAutoUserInput(session, operatorInput);

    if (autoMode.phase === "blocked") {
      const delivery = await this.sendReplyMessage(
        message,
        buildAutoQueuedInputAcceptedMessage({
          phase: "blocked",
          language: getSessionUiLanguage(session),
        }),
        { session },
      );
      if (delivery?.parked) {
        return { handled: true, reason: "topic-unavailable" };
      }
      await this.evaluateSession(session, { force: true });
      return { handled: true, reason: "auto-blocked-resume" };
    }

    if (autoMode.phase === "sleeping") {
      const compactResult = await this.maybeAutoCompactBeforeContinuation(session);
      if (compactResult?.parked) {
        return { handled: true, reason: "auto-sleep-resume-parked" };
      }
      session = compactResult?.session || session;
      const sleepingAutoMode = normalizeAutoModeState(session.auto_mode);
      if (!sleepingAutoMode.sleep_next_prompt) {
        await this.failBrokenSleepState(
          session,
          "Omni sleep state is missing the queued wake-up prompt.",
        );
        return { handled: true, reason: "auto-sleeping-state-corrupt" };
      }

      const wakeMemory = await this.loadOmniMemory(session);
      await this.sendTopicMessage(
        session,
        buildAutoContinuationDispatchMessage({
          nextPrompt: sleepingAutoMode.sleep_next_prompt,
          pendingUserInput: sleepingAutoMode.pending_user_input,
          language: getSessionUiLanguage(session),
          omniMemory: wakeMemory,
          decisionMode: wakeMemory.last_decision_mode,
        }),
      );
      const resumedSession = await this.sendPromptToSpike(
        session,
        sleepingAutoMode.sleep_next_prompt,
        {
          mode: "continuation",
          pendingUserInput: sleepingAutoMode.pending_user_input,
          decisionMode: wakeMemory.last_decision_mode,
          omniMemory: wakeMemory,
          successPatch: {
            continuation_count: sleepingAutoMode.continuation_count + 1,
            last_evaluated_exchange_log_entries:
              sleepingAutoMode.last_evaluated_exchange_log_entries,
            last_result_summary: sleepingAutoMode.last_result_summary,
          },
        },
      );
      if (resumedSession?.parked) {
        return { handled: true, reason: "auto-sleep-resume-parked" };
      }

      return { handled: true, reason: "auto-sleep-resumed-by-operator" };
    }

    const delivery = await this.sendReplyMessage(
      message,
      buildAutoQueuedInputAcceptedMessage({
        phase: autoMode.phase,
        language: getSessionUiLanguage(session),
      }),
      { session },
    );
    if (delivery?.parked) {
      return { handled: true, reason: "topic-unavailable" };
    }

    return { handled: true, reason: "auto-input-queued" };
  }

  async sendPromptToSpike(session, workerPrompt, options = {}) {
    return sendPromptToSpike(this, session, workerPrompt, options);
  }

  async failBrokenSleepState(session, reason) {
    return failBrokenSleepState(this, session, reason);
  }

  async evaluateSession(session, options = {}) {
    return evaluateSession(this, session, options);
  }

  async scanPendingSpikeFinals() {
    return scanPendingSpikeFinals(this);
  }

  async resumeDueSleepingSessions() {
    return resumeDueSleepingSessions(this);
  }

  async shutdown() {
    return shutdown(this);
  }
}
