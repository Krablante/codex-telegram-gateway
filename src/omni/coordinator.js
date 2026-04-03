import path from "node:path";
import process from "node:process";

import {
  buildReplyMessageParams,
  extractBotCommand,
  isForeignBotCommand,
  isAuthorizedForumMessageFromHuman,
} from "../telegram/command-parsing.js";
import {
  extractPromptText,
  hasIncomingAttachments,
} from "../telegram/incoming-attachments.js";
import { buildNoSessionTopicMessage } from "../telegram/command-router.js";
import { getSessionUiLanguage, normalizeUiLanguage } from "../i18n/ui-language.js";
import { markPromptAccepted } from "../runtime/service-state.js";
import { startCodexExecRun } from "../codex-exec/exec-runner.js";
import { parseOmniDecision } from "./decision.js";
import { OmniMemoryStore, buildDefaultOmniMemory } from "./memory.js";
import {
  buildAutoBlockedMessage,
  buildAutoCompactingMessage,
  buildAutoContinuityRefreshFailedMessage,
  buildAutoContinuationDispatchMessage,
  buildAutoDisabledMessage,
  buildAutoDoneMessage,
  buildOmniFallbackNextPrompt,
  buildOmniOperatorQueryPrompt,
  buildAutoFailedMessage,
  buildAutoGoalCapturedMessage,
  buildAutoInitialPromptAcceptedMessage,
  buildAutoQueuedInputAcceptedMessage,
  buildAutoSleepingMessage,
  buildAutoSetupInputExpectedMessage,
  buildAutoSetupStartedMessage,
  buildAutoStatusMessage,
  buildOmniEvaluationPrompt,
  buildOmniStructuredNextPrompt,
  buildOmniTopicPrompt,
} from "./prompting.js";
import {
  isAutoModeTerminalPhase,
  normalizeAutoModeState,
} from "../session-manager/auto-mode.js";

function buildTopicParams(session, text, { replyToMessageId = null } = {}) {
  const params = {
    chat_id: Number(session.chat_id),
    message_thread_id: Number(session.topic_id),
    text,
  };

  if (replyToMessageId) {
    params.reply_to_message_id = Number(replyToMessageId);
  }

  return params;
}

function isMissingReplyTargetError(error) {
  return String(error?.message || "")
    .toLowerCase()
    .includes("message to be replied not found");
}

function parseAutoCommandArgs(rawArgs) {
  const normalized = String(rawArgs || "").trim().toLowerCase();
  if (!normalized) {
    return { action: "start" };
  }
  if (["off", "stop", "disable"].includes(normalized)) {
    return { action: "off" };
  }
  if (["status", "show"].includes(normalized)) {
    return { action: "status" };
  }

  return { action: "invalid", raw: normalized };
}

function summarizeAttachments(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return null;
  }

  return [
    "Operator attachments:",
    ...attachments.map((attachment) => {
      const kind = attachment?.is_image ? "image" : "file";
      return `- ${kind}: ${attachment.file_path}`;
    }),
  ].join("\n");
}

function combinePromptParts(parts) {
  return parts
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function isManualFlushShortcut(text) {
  const normalized = String(text || "").trim().toLowerCase();
  return normalized === "all" || normalized === "все";
}

const SPIKE_RUNTIME_SETTING_COMMANDS = new Set([
  "model",
  "reasoning",
  "omni_model",
  "omni_reasoning",
]);

const AUTO_COMPACT_MIN_AGE_MS = 4 * 60 * 60 * 1000;
const AUTO_COMPACT_MIN_PROMPTS = 30;

function isExplicitCommandForCurrentBot(message, botUsername) {
  const text = String(message?.text ?? message?.caption ?? "");
  if (!text || !botUsername) {
    return false;
  }

  const entities = Array.isArray(message.entities)
    ? message.entities
    : Array.isArray(message.caption_entities)
      ? message.caption_entities
      : [];
  const commandEntity = entities.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  if (!commandEntity) {
    return false;
  }

  const rawCommand = text.slice(0, commandEntity.length).toLowerCase();
  return rawCommand.includes(`@${botUsername.toLowerCase()}`);
}

function buildRuntimeSettingsProxyMessage(language = "rus") {
  if (normalizeUiLanguage(language) === "eng") {
    return [
      "These runtime-setting commands are applied by Spike.",
      "",
      "Send them in this topic without `@omnibot`.",
      "Example: `/omni_model gpt-5.4-mini`",
    ].join("\n");
  }

  return [
    "Эти runtime-команды применяет Spike.",
    "",
    "Отправляй их в этот топик без `@omnibot`.",
    "Пример: `/omni_model gpt-5.4-mini`",
  ].join("\n");
}

function buildOmniQueryUnavailableMessage(language = "rus") {
  if (normalizeUiLanguage(language) === "eng") {
    return "Direct Omni questions work after /auto has been started in this topic.";
  }

  return "Прямые вопросы к Omni работают, если в этом топике уже был запущен /auto.";
}

function buildOmniQueryBusyMessage(language = "rus") {
  if (normalizeUiLanguage(language) === "eng") {
    return "Omni is already answering another direct question in this topic.";
  }

  return "Omni уже отвечает на другой прямой вопрос в этом топике.";
}

function buildOmniQueryFailureMessage(reason, language = "rus") {
  if (normalizeUiLanguage(language) === "eng") {
    return [
      "Omni query failed.",
      "",
      String(reason || "Unknown error"),
    ].join("\n");
  }

  return [
    "Запрос к Omni не удался.",
    "",
    String(reason || "Неизвестная ошибка"),
  ].join("\n");
}

function buildOmniQueryAcceptedMessage(language = "rus") {
  if (normalizeUiLanguage(language) === "eng") {
    return "Question accepted. Preparing the Omni answer now.";
  }

  return "Вопрос принят. Готовлю ответ Omni.";
}

function resolveSessionRepoRoot(session, fallbackRepoRoot) {
  const cwd = String(session?.workspace_binding?.cwd || "").trim();
  if (cwd) {
    return cwd;
  }

  const repoRoot = String(session?.workspace_binding?.repo_root || "").trim();
  if (repoRoot) {
    return repoRoot;
  }

  return fallbackRepoRoot;
}

function hasOmniQueryContext(session) {
  const autoMode = normalizeAutoModeState(session?.auto_mode);
  return Boolean(
    autoMode.literal_goal_text
      || autoMode.normalized_goal_interpretation
      || autoMode.initial_worker_prompt
      || autoMode.last_result_summary,
  );
}

const DIRECT_OMNI_QUESTION_PREFIXES = new Set([
  "what",
  "why",
  "how",
  "when",
  "where",
  "who",
  "which",
  "can",
  "could",
  "should",
  "would",
  "will",
  "is",
  "are",
  "do",
  "does",
  "did",
  "что",
  "чего",
  "почему",
  "зачем",
  "как",
  "какой",
  "какая",
  "какие",
  "когда",
  "где",
  "кто",
  "сколько",
  "правильно",
  "верно",
  "верно-ли",
]);

function looksLikeDirectOmniQuestion(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return false;
  }

  if (normalized.includes("?")) {
    return true;
  }

  const firstWord = normalized
    .toLowerCase()
    .match(/^[\p{L}\p{N}-]+/u)?.[0] || "";
  return DIRECT_OMNI_QUESTION_PREFIXES.has(firstWord);
}

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
    const child = this.activeDecisionChildren.get(sessionKey);
    if (!child?.pid) {
      try {
        child?.kill?.("SIGINT");
      } catch {}
      return;
    }

    try {
      process.kill(-child.pid, "SIGINT");
    } catch {
      try {
        child.kill("SIGINT");
      } catch {}
    }
  }

  async sendTopicMessage(session, text, { replyToMessageId = null } = {}) {
    const params = buildTopicParams(session, text, { replyToMessageId });
    let allowReplyTargetFallback = Boolean(params.reply_to_message_id);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.api.sendMessage(params);
      } catch (error) {
        if (allowReplyTargetFallback && isMissingReplyTargetError(error)) {
          delete params.reply_to_message_id;
          allowReplyTargetFallback = false;
          continue;
        }

        const lifecycleResult = await this.sessionLifecycleManager?.handleTransportError(
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

  async sendReplyMessage(message, text, { session = null } = {}) {
    const params = buildReplyMessageParams(message, text);

    try {
      return await this.api.sendMessage(params);
    } catch (error) {
      if (!session) {
        throw error;
      }

      const lifecycleResult = await this.sessionLifecycleManager?.handleTransportError(
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

  async loadOmniMemory(session) {
    return this.omniMemoryStore?.load(session) || buildDefaultOmniMemory();
  }

  async resetOmniMemory(session) {
    await this.omniMemoryStore?.clear(session);
  }

  async seedOmniMemoryFromGoal(session) {
    const autoMode = normalizeAutoModeState(session.auto_mode);
    const lockedGoal =
      autoMode.normalized_goal_interpretation
      || autoMode.literal_goal_text
      || null;

    if (!lockedGoal || !this.omniMemoryStore) {
      return this.loadOmniMemory(session);
    }

    return this.omniMemoryStore.write(session, {
      goal_constraints: [lockedGoal],
      current_proof_line: null,
      proof_line_status: null,
      last_spike_summary: null,
      last_decision_mode: null,
      known_bottlenecks: [],
      candidate_pivots: [],
      side_work_queue: [],
      supervisor_notes: [],
      why_this_matters_to_goal: lockedGoal,
      goal_unsatisfied: lockedGoal,
      remaining_goal_gap: lockedGoal,
      what_changed_since_last_cycle: null,
      last_what_changed: null,
      primary_next_action: null,
      bounded_side_work: [],
      do_not_regress: [],
    });
  }

  async updateOmniMemoryFromDecision(session, decision, {
    lockedGoal = null,
    spikeSummary = null,
  } = {}) {
    const currentMemory = await this.loadOmniMemory(session);
    if (!this.omniMemoryStore) {
      return currentMemory;
    }

    return this.omniMemoryStore.patch(session, {
      goal_constraints:
        decision.goalConstraints
        ?? (currentMemory.goal_constraints.length > 0
          ? currentMemory.goal_constraints
          : lockedGoal
            ? [lockedGoal]
            : []),
      current_proof_line:
        decision.currentProofLine === undefined
          ? currentMemory.current_proof_line
          : decision.currentProofLine,
      proof_line_status:
        decision.proofLineStatus ?? currentMemory.proof_line_status,
      last_spike_summary:
        String(spikeSummary || "").trim() || currentMemory.last_spike_summary,
      last_decision_mode: decision.mode,
      known_bottlenecks:
        decision.knownBottlenecks ?? currentMemory.known_bottlenecks,
      candidate_pivots:
        decision.candidatePivots ?? currentMemory.candidate_pivots,
      side_work_queue: decision.sideWork ?? currentMemory.side_work_queue,
      supervisor_notes:
        decision.supervisorNotes ?? currentMemory.supervisor_notes,
      why_this_matters_to_goal:
        decision.whyThisMattersToGoal === undefined
          ? currentMemory.why_this_matters_to_goal || lockedGoal
          : decision.whyThisMattersToGoal,
      goal_unsatisfied:
        decision.goalUnsatisfied === undefined
          ? currentMemory.goal_unsatisfied
          : decision.goalUnsatisfied,
      remaining_goal_gap:
        decision.remainingGoalGap === undefined
          ? currentMemory.remaining_goal_gap
          : decision.remainingGoalGap,
      what_changed_since_last_cycle:
        decision.whatChanged === undefined
          ? currentMemory.what_changed_since_last_cycle
          : decision.whatChanged,
      last_what_changed:
        decision.whatChanged === undefined
          ? currentMemory.last_what_changed
          : decision.whatChanged,
      primary_next_action:
        decision.primaryNextAction
        ?? decision.nextAction
        ?? currentMemory.primary_next_action,
      bounded_side_work:
        decision.boundedSideWork
        ?? decision.sideWork
        ?? currentMemory.bounded_side_work,
      do_not_regress:
        decision.doNotRegress ?? currentMemory.do_not_regress,
    });
  }

  shouldAutoCompact(autoMode) {
    if (
      !this.sessionService?.sessionCompactor
      || !autoMode.enabled
      || !autoMode.first_omni_prompt_at
      || autoMode.continuation_count_since_compact < AUTO_COMPACT_MIN_PROMPTS
    ) {
      return false;
    }

    const firstPromptAtMs = Date.parse(autoMode.first_omni_prompt_at);
    return Number.isFinite(firstPromptAtMs)
      && (Date.now() - firstPromptAtMs) >= AUTO_COMPACT_MIN_AGE_MS;
  }

  async maybeAutoCompactBeforeContinuation(session) {
    const current =
      (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
    const autoMode = normalizeAutoModeState(current.auto_mode);
    if (!this.shouldAutoCompact(autoMode)) {
      return { session: current, compacted: false };
    }

    const delivery = await this.sendTopicMessage(
      current,
      buildAutoCompactingMessage(getSessionUiLanguage(current)),
    );
    if (delivery?.parked) {
      return { parked: true, session: delivery.session || current };
    }

    try {
      const compacted = await this.sessionService.compactSession(
        current,
        "auto-compact:omni-cycle-boundary",
      );
      const compactedSession = await this.sessionService.updateAutoMode(
        compacted.session || current,
        {
          ...normalizeAutoModeState((compacted.session || current).auto_mode),
          last_auto_compact_at: new Date().toISOString(),
          first_omni_prompt_at: null,
          continuation_count_since_compact: 0,
        },
      );
      await this.omniMemoryStore?.patch(compactedSession, {
        last_auto_compact_at: new Date().toISOString(),
        continuation_count_since_compact: 0,
        first_omni_prompt_at: null,
        last_auto_compact_reason: "auto-compact:omni-cycle-boundary",
        last_auto_compact_exchange_log_entries: compacted.exchangeLogEntries ?? 0,
      });
      return {
        session: compactedSession,
        compacted: true,
      };
    } catch (error) {
      const failureDelivery = await this.sendTopicMessage(
        current,
        buildAutoContinuityRefreshFailedMessage(
          error.message,
          getSessionUiLanguage(current),
        ),
      );
      if (failureDelivery?.parked) {
        return {
          parked: true,
          session: failureDelivery.session || current,
          compacted: false,
        };
      }
      return {
        session: current,
        compacted: false,
      };
    }
  }

  async buildOperatorInput(session, message) {
    const sourceMessages = Array.isArray(message) ? message.filter(Boolean) : [message];
    const parts = [];

    for (const entry of sourceMessages) {
      const promptText = extractPromptText(entry);
      const attachments = hasIncomingAttachments(entry)
        ? await this.sessionService.ingestIncomingAttachments(
          this.api,
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
      || (normalizeUiLanguage(language) === "eng"
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

  async answerOmniQuery({
    autoMode,
    language,
    message,
    operatorQuestion,
    session,
  }) {
    const normalizedQuestion = String(operatorQuestion || "").trim()
      || (normalizeUiLanguage(language) === "eng"
        ? "Describe what the latest Spike turn achieved, what remains, and what Omni plans next."
        : "Опиши, чего достиг последний ход Spike, что осталось и какой следующий шаг планирует Omni.");

    const sessionKey = session.session_key;
    if (this.activeOperatorQueries.has(sessionKey)) {
      const delivery = await this.sendReplyMessage(
        message,
        buildOmniQueryBusyMessage(language),
        { session },
      );
      if (delivery?.parked) {
        return { handled: true, reason: "topic-unavailable" };
      }
      return { handled: true, reason: "omni-query-busy" };
    }

    this.activeOperatorQueries.add(sessionKey);
    try {
      const acceptedDelivery = await this.sendReplyMessage(
        message,
        buildOmniQueryAcceptedMessage(language),
        { session },
      );
      if (acceptedDelivery?.parked) {
        return { handled: true, reason: "topic-unavailable" };
      }
      const runtimeProfile = await this.sessionService.resolveCodexRuntimeProfile(
        session,
        { target: "omni" },
      );
      const omniMemory = await this.loadOmniMemory(session);
      const queryPrompt = buildOmniOperatorQueryPrompt({
        autoMode,
        exchangeEntry: {
          user_prompt: session.last_user_prompt,
          assistant_reply: session.last_agent_reply,
        },
        omniMemory,
        operatorQuestion: normalizedQuestion,
        session,
      });
      const run = this.startExecRun({
        codexBinPath: this.config.codexBinPath,
        repoRoot: resolveSessionRepoRoot(session, this.config.repoRoot),
        outputDir: this.omniRunsRoot,
        outputPrefix: "query",
        prompt: queryPrompt,
        model: runtimeProfile.model,
        reasoningEffort: runtimeProfile.reasoningEffort,
      });
      const result = await run.done;
      if (!result.ok) {
        await this.sendReplyMessage(
          message,
          buildOmniQueryFailureMessage(
            result.stderr || result.stdout || "Omni query failed",
            language,
          ),
          { session },
        );
        return { handled: true, reason: "omni-query-failed" };
      }

      await this.sendReplyMessage(
        message,
        String(result.finalReply || "").trim()
          || buildOmniQueryFailureMessage("Empty Omni query reply", language),
        { session },
      );
      return { handled: true, reason: "omni-query-answered" };
    } finally {
      this.activeOperatorQueries.delete(sessionKey);
    }
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

  async sendPromptToSpike(session, workerPrompt, {
    mode = "continuation",
    pendingUserInput = null,
    decisionMode = null,
    omniMemory = null,
    successPatch = {},
  } = {}) {
    const autoMode = normalizeAutoModeState(session.auto_mode);
    const now = new Date().toISOString();
    const currentMemory = omniMemory || (await this.loadOmniMemory(session));
    const composedPrompt = buildOmniTopicPrompt({
      autoMode,
      initialWorkerPrompt: workerPrompt,
      pendingUserInput,
      session,
      mode,
      omniMemory: currentMemory,
      decisionMode,
    });

    markPromptAccepted(this.serviceState);
    await this.promptHandoffStore.queue(session, {
      mode,
      prompt: composedPrompt,
    });

    const updatedSession = await this.sessionService.updateAutoMode(session, {
      ...normalizeAutoModeState(session.auto_mode),
      ...successPatch,
      enabled: true,
      phase: "running",
      blocked_reason: null,
      pending_user_input: null,
      first_omni_prompt_at: autoMode.first_omni_prompt_at ?? now,
      continuation_count_since_compact:
        autoMode.continuation_count_since_compact + 1,
      sleep_until: null,
      sleep_next_prompt: null,
      last_omni_prompt_message_id: null,
    });
    await this.omniMemoryStore?.patch(updatedSession, {
      first_omni_prompt_at: currentMemory.first_omni_prompt_at || now,
      last_prompt_dispatched_at: now,
      continuation_count_since_compact:
        currentMemory.continuation_count_since_compact + 1,
      last_decision_mode: decisionMode || currentMemory.last_decision_mode,
      primary_next_action: workerPrompt,
    });

    return updatedSession;
  }

  async failBrokenSleepState(session, reason) {
    const failedSession = await this.sessionService.markAutoDecision(session, {
      phase: "failed",
      resultSummary: reason,
      clearPendingUserInput: false,
    });
    await this.sendTopicMessage(
      failedSession,
      buildAutoFailedMessage(reason, getSessionUiLanguage(failedSession)),
    );
    return failedSession;
  }

  async evaluateSession(session, { force = false } = {}) {
    const sessionKey = session.session_key;
    if (this.activeEvaluations.has(sessionKey)) {
      return { handled: false, reason: "evaluation-already-running" };
    }

    this.activeEvaluations.add(sessionKey);
    try {
      const current =
        (await this.sessionStore.load(session.chat_id, session.topic_id)) || session;
      const autoMode = normalizeAutoModeState(current.auto_mode);
      const spikeFinalEvent = await this.spikeFinalEventStore.load(current);

      if (!autoMode.enabled) {
        return { handled: false, reason: "auto-disabled" };
      }

      if (
        !force &&
        spikeFinalEvent.exchange_log_entries <= autoMode.last_evaluated_exchange_log_entries
      ) {
        return { handled: false, reason: "nothing-new-to-evaluate" };
      }

      const evaluatingSession = await this.sessionService.markAutoSpikeFinal(
        current,
        {
          messageId:
            spikeFinalEvent.telegram_message_ids.at(-1) ??
            autoMode.last_spike_final_message_id,
          exchangeLogEntries: spikeFinalEvent.exchange_log_entries,
          summary: spikeFinalEvent.final_reply_text,
        },
      );
      const latestAutoMode = normalizeAutoModeState(evaluatingSession.auto_mode);
      if (
        spikeFinalEvent.status === "interrupted" &&
        !latestAutoMode.pending_user_input
      ) {
        const pausedSession = await this.sessionService.markAutoDecision(
          evaluatingSession,
          {
            phase: "blocked",
            blockedReason: "Interrupted by operator",
            resultSummary: "Interrupted by operator",
            clearPendingUserInput: false,
          },
        );
        return {
          handled: true,
          reason: "auto-paused-after-interrupt",
          session: pausedSession,
        };
      }

      const preDecisionMemory = await this.loadOmniMemory(evaluatingSession);
      const evaluationPrompt = buildOmniEvaluationPrompt({
        autoMode: latestAutoMode,
        exchangeEntry: {
          user_prompt: evaluatingSession.last_user_prompt,
          assistant_reply:
            spikeFinalEvent.final_reply_text || evaluatingSession.last_agent_reply,
        },
        omniMemory: preDecisionMemory,
        pendingUserInput: latestAutoMode.pending_user_input,
        session: evaluatingSession,
      });
      const runtimeProfile = await this.sessionService.resolveCodexRuntimeProfile(
        evaluatingSession,
        { target: "omni" },
      );
      const run = this.startExecRun({
        codexBinPath: this.config.codexBinPath,
        repoRoot: resolveSessionRepoRoot(
          evaluatingSession,
          this.config.repoRoot,
        ),
        outputDir: this.omniRunsRoot,
        outputPrefix: "decision",
        prompt: evaluationPrompt,
        model: runtimeProfile.model,
        reasoningEffort: runtimeProfile.reasoningEffort,
      });
      this.activeDecisionChildren.set(sessionKey, run.child);
      const result = await run.done;
      const postDecisionSession =
        (await this.sessionStore.load(session.chat_id, session.topic_id)) ||
        evaluatingSession;
      const postDecisionAutoMode = normalizeAutoModeState(
        postDecisionSession.auto_mode,
      );
      if (!postDecisionAutoMode.enabled) {
        return { handled: true, reason: "auto-disabled-during-evaluation" };
      }

      if (!result.ok) {
        const failedSession = await this.sessionService.markAutoDecision(
          postDecisionSession,
          {
            phase: "failed",
            resultSummary: result.stderr || result.stdout || "Omni decision failed",
          },
        );
        await this.sendTopicMessage(
          failedSession,
          buildAutoFailedMessage(
            result.stderr || result.stdout || "Omni decision failed",
            getSessionUiLanguage(failedSession),
          ),
        );
        return { handled: true, reason: "omni-decision-failed" };
      }

      let decision;
      const evaluationExchangeEntry = {
        user_prompt: evaluatingSession.last_user_prompt,
        assistant_reply:
          spikeFinalEvent.final_reply_text || evaluatingSession.last_agent_reply,
      };
      const lockedGoal =
        latestAutoMode.normalized_goal_interpretation
        || latestAutoMode.literal_goal_text
        || null;
      try {
        decision = parseOmniDecision(result.finalReply);
      } catch (error) {
        const failedSession = await this.sessionService.markAutoDecision(
          postDecisionSession,
          {
            phase: "failed",
            resultSummary: error.message,
          },
        );
        await this.sendTopicMessage(
          failedSession,
          buildAutoFailedMessage(
            error.message,
            getSessionUiLanguage(failedSession),
          ),
        );
        return { handled: true, reason: "omni-decision-invalid" };
      }

      const updatedOmniMemory = await this.updateOmniMemoryFromDecision(
        postDecisionSession,
        decision,
        {
          lockedGoal,
          spikeSummary: evaluationExchangeEntry.assistant_reply,
        },
      );

      if (decision.status === "continue") {
        const nextPrompt = buildOmniStructuredNextPrompt({
          decision,
          omniMemory: updatedOmniMemory,
          fallbackAction: buildOmniFallbackNextPrompt({
            exchangeEntry: evaluationExchangeEntry,
          }),
        });
        const compactResult = await this.maybeAutoCompactBeforeContinuation(
          postDecisionSession,
        );
        if (compactResult?.parked) {
          return { handled: true, reason: "auto-continuation-parked" };
        }
        const continuationSession = compactResult?.session || postDecisionSession;
        const continuationAutoMode = normalizeAutoModeState(
          continuationSession.auto_mode,
        );
        const continuationMemory = compactResult?.compacted
          ? await this.loadOmniMemory(continuationSession)
          : updatedOmniMemory;

        if (decision.mode === "continue_after_sleep") {
          const sleepingSession = await this.sessionService.scheduleAutoSleep(
            continuationSession,
            {
              sleepMinutes: decision.sleepMinutes,
              nextPrompt,
              resultSummary: decision.summary,
              clearPendingUserInput: true,
            },
          );
          await this.sendTopicMessage(
            sleepingSession,
            buildAutoSleepingMessage({
              sleepMinutes: decision.sleepMinutes,
              nextPrompt,
              pendingUserInput: continuationAutoMode.pending_user_input,
              language: getSessionUiLanguage(sleepingSession),
              omniMemory: continuationMemory,
            }),
          );
          return {
            handled: true,
            reason: "auto-sleeping",
            session: sleepingSession,
          };
        }

        await this.sendTopicMessage(
          continuationSession,
          buildAutoContinuationDispatchMessage({
            nextPrompt,
            pendingUserInput: continuationAutoMode.pending_user_input,
            language: getSessionUiLanguage(continuationSession),
            omniMemory: continuationMemory,
            decisionMode: decision.mode,
          }),
        );
        const nextSession = await this.sendPromptToSpike(
          continuationSession,
          nextPrompt,
          {
            mode: decision.mode,
            pendingUserInput: continuationAutoMode.pending_user_input,
            decisionMode: decision.mode,
            omniMemory: continuationMemory,
            successPatch: {
              continuation_count: continuationAutoMode.continuation_count + 1,
              last_evaluated_exchange_log_entries:
                continuationAutoMode.last_spike_exchange_log_entries,
              last_result_summary: decision.summary,
            },
          },
        );
        if (nextSession?.parked) {
          return { handled: true, reason: "auto-continuation-parked" };
      }

      return { handled: true, reason: "auto-continued", session: nextSession };
      }

      if (decision.mode === "done") {
        const doneSession = await this.sessionService.markAutoDecision(
          postDecisionSession,
          {
            phase: "done",
            resultSummary: decision.summary,
            clearPendingUserInput: true,
          },
        );
        await this.sendTopicMessage(
          doneSession,
          decision.userMessage
            || buildAutoDoneMessage(
              decision.summary,
              getSessionUiLanguage(doneSession),
            ),
        );
        return { handled: true, reason: "auto-done", session: doneSession };
      }

      if (decision.mode === "blocked_external") {
        const blockedSession = await this.sessionService.markAutoDecision(
          postDecisionSession,
          {
            phase: "blocked",
            blockedReason: decision.blockedReason,
            resultSummary: decision.summary || decision.blockedReason,
          },
        );
        await this.sendTopicMessage(
          blockedSession,
          decision.userMessage
            || buildAutoBlockedMessage(
              decision.blockedReason,
              getSessionUiLanguage(blockedSession),
            ),
        );
        return { handled: true, reason: "auto-blocked", session: blockedSession };
      }

      const failedSession = await this.sessionService.markAutoDecision(
        postDecisionSession,
        {
          phase: "failed",
          resultSummary: decision.summary,
        },
      );
      await this.sendTopicMessage(
        failedSession,
        decision.userMessage
          || buildAutoFailedMessage(
            decision.summary,
            getSessionUiLanguage(failedSession),
          ),
      );
      return { handled: true, reason: "auto-failed", session: failedSession };
    } finally {
      this.activeDecisionChildren.delete(sessionKey);
      this.activeEvaluations.delete(sessionKey);
    }
  }

  async scanPendingSpikeFinals() {
    const sessions = await this.sessionStore.listSessions();

    for (const session of sessions) {
      if (session.lifecycle_state !== "active") {
        continue;
      }

      const autoMode = normalizeAutoModeState(session.auto_mode);
      if (!autoMode.enabled) {
        continue;
      }

      // A stale blocked phase must not hide a newer Spike final event.
      // If Spike produced another final reply, Omni should still evaluate it.
      if (!["running", "evaluating", "blocked", "failed"].includes(autoMode.phase)) {
        continue;
      }

      const spikeFinalEvent = await this.spikeFinalEventStore.load(session);
      if (
        spikeFinalEvent.exchange_log_entries <=
        autoMode.last_evaluated_exchange_log_entries
      ) {
        continue;
      }

      await this.evaluateSession(session);
    }
  }

  async resumeDueSleepingSessions() {
    const sessions = await this.sessionStore.listSessions();

    for (const session of sessions) {
      if (session.lifecycle_state !== "active") {
        continue;
      }

      const autoMode = normalizeAutoModeState(session.auto_mode);
      if (!autoMode.enabled || autoMode.phase !== "sleeping") {
        continue;
      }

      if (!autoMode.sleep_until || !autoMode.sleep_next_prompt) {
        await this.failBrokenSleepState(
          session,
          "Omni sleep state is incomplete and cannot resume.",
        );
        continue;
      }

      const wakeAtMs = Date.parse(autoMode.sleep_until);
      if (!Number.isFinite(wakeAtMs)) {
        await this.failBrokenSleepState(
          session,
          "Omni sleep state has an invalid wake timestamp.",
        );
        continue;
      }
      if (wakeAtMs > Date.now()) {
        continue;
      }

      if (await this.promptHandoffStore.load(session)) {
        continue;
      }

      const compactResult = await this.maybeAutoCompactBeforeContinuation(session);
      if (compactResult?.parked) {
        continue;
      }
      const continuationSession = compactResult?.session || session;
      const continuationAutoMode = normalizeAutoModeState(continuationSession.auto_mode);
      if (!continuationAutoMode.sleep_next_prompt) {
        await this.failBrokenSleepState(
          continuationSession,
          "Omni sleep state is missing the queued wake-up prompt.",
        );
        continue;
      }

      const wakeMemory = await this.loadOmniMemory(continuationSession);
      await this.sendTopicMessage(
        continuationSession,
        buildAutoContinuationDispatchMessage({
          nextPrompt: continuationAutoMode.sleep_next_prompt,
          pendingUserInput: continuationAutoMode.pending_user_input,
          language: getSessionUiLanguage(continuationSession),
          omniMemory: wakeMemory,
          decisionMode: wakeMemory.last_decision_mode,
        }),
      );
      await this.sendPromptToSpike(continuationSession, continuationAutoMode.sleep_next_prompt, {
        mode: "continuation",
        pendingUserInput: continuationAutoMode.pending_user_input,
        decisionMode: wakeMemory.last_decision_mode,
        omniMemory: wakeMemory,
        successPatch: {
          continuation_count: continuationAutoMode.continuation_count + 1,
          last_evaluated_exchange_log_entries:
            continuationAutoMode.last_evaluated_exchange_log_entries,
          last_result_summary: continuationAutoMode.last_result_summary,
        },
      });
    }
  }

  async shutdown() {
    for (const child of this.activeDecisionChildren.values()) {
      if (!child?.pid) {
        continue;
      }

      try {
        process.kill(-child.pid, "SIGINT");
      } catch {
        try {
          child.kill("SIGINT");
        } catch {}
      }
    }
  }
}
