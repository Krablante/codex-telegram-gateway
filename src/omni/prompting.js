import { getSessionUiLanguage, normalizeUiLanguage } from "../i18n/ui-language.js";

function isEnglish(language) {
  return normalizeUiLanguage(language) === "eng";
}

function truncateForTelegram(text, maxChars = 3400) {
  const normalized = String(text || "").trim();
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 15)).trimEnd()}\n\n[truncated]`;
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  }

  const single = String(value || "").trim();
  return single ? [single] : [];
}

function pushOptionalSection(lines, heading, value, { maxChars = 1800 } = {}) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return;
  }

  lines.push("", heading, truncateForTelegram(normalized, maxChars));
}

function pushOptionalListSection(lines, heading, values, { maxChars = 1600 } = {}) {
  const items = normalizeList(values);
  if (items.length === 0) {
    return;
  }

  lines.push("", heading);
  for (const item of items) {
    lines.push(`- ${truncateForTelegram(item, maxChars)}`);
  }
}

function describeDecisionMode(mode, language = "rus") {
  if (mode === "pivot_to_next_line") {
    return isEnglish(language)
      ? "pivot_to_next_line"
      : "pivot_to_next_line";
  }
  if (mode === "continue_after_sleep") {
    return isEnglish(language)
      ? "continue_after_sleep"
      : "continue_after_sleep";
  }
  if (mode === "continue_same_line") {
    return isEnglish(language)
      ? "continue_same_line"
      : "continue_same_line";
  }

  return mode || "none";
}

export function buildAutoSetupStartedMessage(language = "rus") {
  return isEnglish(language)
    ? "Auto mode armed. Send the goal in the next message. No reply is needed."
    : "Auto режим включен. Следующим сообщением пришли цель. Реплай не нужен.";
}

export function buildAutoGoalCapturedMessage(language = "rus") {
  return isEnglish(language)
    ? "Goal captured. Send the initial worker prompt in the next message. No reply is needed. Do not use `All` here."
    : "Цель зафиксирована. Следующим сообщением пришли initial worker prompt. Реплай не нужен. Не отправляй здесь `Все`.";
}

export function buildAutoInitialPromptAcceptedMessage(language = "rus") {
  return isEnglish(language)
    ? "Initial worker prompt accepted. Handing off to Spike now."
    : "Initial worker prompt принят. Передаю задачу в Spike.";
}

export function buildAutoSetupInputExpectedMessage(stage = "goal", language = "rus") {
  if (stage === "initial_prompt") {
    return isEnglish(language)
      ? "This looks like a /wait flush. /auto is waiting for the initial worker prompt as a normal message. No reply is needed."
      : "Это похоже на flush от /wait. Сейчас /auto ждет initial worker prompt обычным сообщением. Реплай не нужен.";
  }

  return isEnglish(language)
    ? "This looks like a /wait flush. /auto is waiting for the goal text as a normal message. No reply is needed."
    : "Это похоже на flush от /wait. Сейчас /auto ждет текст цели обычным сообщением. Реплай не нужен.";
}

export function buildAutoDisabledMessage(language = "rus") {
  return isEnglish(language)
    ? "Auto mode disabled for this topic."
    : "Auto режим для этого топика выключен.";
}

export function buildAutoQueuedInputMessage(language = "rus") {
  return isEnglish(language)
    ? "Input queued for the next Omni cycle."
    : "Ввод принят и будет учтен в следующем цикле Omni.";
}

export function buildAutoQueuedInputAcceptedMessage({
  phase = "running",
  language = "rus",
} = {}) {
  if (phase === "blocked") {
    return isEnglish(language)
      ? "Input accepted. Re-evaluating the blocker and rebuilding the next Omni step now."
      : "Ввод принят. Пересобираю blocker и следующий ход Omni прямо сейчас.";
  }

  if (phase === "sleeping") {
    return isEnglish(language)
      ? "Input accepted. I will fold it into the next wake-up context."
      : "Ввод принят. Учту его в контексте следующего пробуждения.";
  }

  return isEnglish(language)
    ? "Input accepted. I will fold it into the next Omni cycle without interrupting the current Spike turn."
    : "Ввод принят. Учту его в следующем цикле Omni, не прерывая текущий ход Spike.";
}

export function buildAutoContinuityRefreshMessage(language = "rus") {
  return isEnglish(language)
    ? "Omni: auto-compact continuity refresh before the next cycle."
    : "Omni: auto-compact refresh continuity Spike перед следующим циклом.";
}

export function buildAutoCompactingMessage(language = "rus") {
  return buildAutoContinuityRefreshMessage(language);
}

export function buildAutoContinuityRefreshFailedMessage(reason = null, language = "rus") {
  const header = isEnglish(language)
    ? "Omni: continuity refresh failed. Continuing without compact."
    : "Omni: continuity refresh не удался. Продолжаю без compact.";
  return reason ? `${header}\n\n${reason}` : header;
}

export function buildAutoSleepingMessage({
  sleepMinutes,
  nextPrompt,
  pendingUserInput = null,
  language = "rus",
  omniMemory = null,
}) {
  const header = isEnglish(language)
    ? `Omni: sleeping for ${sleepMinutes} min before the next Spike wake-up.`
    : `Omni: сплю ${sleepMinutes} мин перед следующим пробуждением Spike.`;
  const promptHeader = isEnglish(language)
    ? "Planned next step after sleep:"
    : "Планируемый следующий шаг после сна:";
  const operatorHeader = isEnglish(language)
    ? "Fresh operator input already folded into the wake-up context:"
    : "Свежий ввод оператора уже будет учтен после пробуждения:";

  const lines = [header];
  if (omniMemory?.current_proof_line) {
    lines.push(
      "",
      isEnglish(language) ? "Current proof line:" : "Текущая proof line:",
      truncateForTelegram(omniMemory.current_proof_line, 900),
    );
  }
  if (omniMemory?.goal_unsatisfied) {
    lines.push(
      "",
      isEnglish(language)
        ? "Goal gap still open:"
        : "Что еще не закрыто по цели:",
      truncateForTelegram(omniMemory.goal_unsatisfied, 1000),
    );
  }
  if (pendingUserInput) {
    lines.push(
      "",
      operatorHeader,
      truncateForTelegram(pendingUserInput, 1200),
    );
  }
  lines.push("", promptHeader, truncateForTelegram(nextPrompt, 2200));
  pushOptionalListSection(
    lines,
    isEnglish(language)
      ? "Optional bounded side work:"
      : "Опциональная bounded side work:",
    omniMemory?.side_work_queue,
    { maxChars: 900 },
  );

  return lines.join("\n");
}

export function buildAutoContinuationDispatchMessage({
  nextPrompt,
  pendingUserInput = null,
  language = "rus",
  omniMemory = null,
  decisionMode = null,
}) {
  const lines = [
    isEnglish(language)
      ? "Omni -> Spike continuation handoff preview:"
      : "Omni -> Spike continuation handoff preview:",
    "",
    isEnglish(language)
      ? "Spike wrapper still includes the locked goal and autonomy policy automatically."
      : "Spike wrapper по-прежнему автоматически включает locked goal и autonomy policy.",
  ];

  if (decisionMode) {
    lines.push(
      "",
      isEnglish(language) ? "Supervisor decision:" : "Решение супервизора:",
      describeDecisionMode(decisionMode, language),
    );
  }
  if (omniMemory?.current_proof_line) {
    lines.push(
      "",
      isEnglish(language) ? "Current proof line:" : "Текущая proof line:",
      truncateForTelegram(omniMemory.current_proof_line, 900),
    );
  }
  if (omniMemory?.what_changed_since_last_cycle) {
    lines.push(
      "",
      isEnglish(language)
        ? "What changed since the last cycle:"
        : "Что изменилось с прошлого цикла:",
      truncateForTelegram(omniMemory.what_changed_since_last_cycle, 1000),
    );
  }
  if (omniMemory?.goal_unsatisfied) {
    lines.push(
      "",
      isEnglish(language)
        ? "Goal gap still open:"
        : "Что еще не закрыто по цели:",
      truncateForTelegram(omniMemory.goal_unsatisfied, 1000),
    );
  }
  if (omniMemory?.why_this_matters_to_goal) {
    lines.push(
      "",
      isEnglish(language)
        ? "Why this line matters to the goal:"
        : "Почему эта линия важна для цели:",
      truncateForTelegram(omniMemory.why_this_matters_to_goal, 1000),
    );
  }
  if (pendingUserInput) {
    lines.push(
      "",
      isEnglish(language) ? "Fresh operator input:" : "Свежий ввод оператора:",
      truncateForTelegram(pendingUserInput, 1200),
    );
  }
  pushOptionalListSection(
    lines,
    isEnglish(language)
      ? "Optional bounded side work:"
      : "Опциональная bounded side work:",
    omniMemory?.side_work_queue,
    { maxChars: 900 },
  );
  pushOptionalListSection(
    lines,
    isEnglish(language) ? "Do not regress:" : "Не регрессировать:",
    omniMemory?.do_not_regress,
    { maxChars: 900 },
  );
  lines.push(
    "",
    isEnglish(language)
      ? "Primary next action:"
      : "Основной следующий шаг:",
    truncateForTelegram(nextPrompt, 2600),
  );

  return lines.join("\n");
}

function extractLatestSpikeTask(promptText) {
  const source = String(promptText || "").trim();
  if (!source) {
    return null;
  }

  const taskMatch = source.match(
    /(?:Primary next action|Continuation task|Initial worker prompt):\n([\s\S]*)$/u,
  );
  if (taskMatch) {
    return taskMatch[1].trim() || null;
  }

  return source;
}

export function buildOmniFallbackNextPrompt({ exchangeEntry }) {
  const previousTask = extractLatestSpikeTask(exchangeEntry?.user_prompt);
  const latestReply = String(exchangeEntry?.assistant_reply || "").trim();

  return [
    "Continue from the latest confirmed live state without redoing already completed setup work.",
    "If the current proof-line run is still healthy and non-terminal, keep passive watch and intervene only on real regression, stall, or terminal transition.",
    "If it already finished or produced new actionable state, take the smallest honest next step toward the locked goal without waiting for permission.",
    ...(previousTask
      ? ["", "Previous continuation context:", previousTask]
      : []),
    ...(latestReply
      ? ["", "Latest confirmed Spike state:", latestReply]
      : []),
  ].join("\n");
}

export function buildOmniStructuredNextPrompt({
  decision,
  omniMemory = null,
  fallbackAction,
}) {
  const nextPrompt =
    String(
      decision?.nextPrompt
      || decision?.nextAction
      || decision?.primaryNextAction
      || "",
    ).trim();
  if (nextPrompt) {
    return nextPrompt;
  }

  const proofLine = String(omniMemory?.current_proof_line || "").trim();
  const goalGap = String(omniMemory?.goal_unsatisfied || "").trim();
  const whyThisMatters = String(omniMemory?.why_this_matters_to_goal || "").trim();
  const sideWork = normalizeList(omniMemory?.side_work_queue);
  const lines = [
    String(fallbackAction || "").trim(),
    ...(proofLine ? ["", "Current proof line:", proofLine] : []),
    ...(goalGap ? ["", "Goal gap still open:", goalGap] : []),
    ...(whyThisMatters ? ["", "Why this line matters:", whyThisMatters] : []),
    ...(sideWork.length > 0
      ? ["", "Optional bounded side work:", ...sideWork.map((item) => `- ${item}`)]
      : []),
  ]
    .map((entry) => String(entry || "").trimEnd())
    .filter(Boolean);

  return lines.join("\n");
}

export function buildAutoDoneMessage(summary = null, language = "rus") {
  const header = isEnglish(language)
    ? "Omni: goal reached."
    : "Omni: цель достигнута.";
  return summary ? `${header}\n\n${summary}` : header;
}

export function buildAutoBlockedMessage(reason = null, language = "rus") {
  const header = isEnglish(language)
    ? "Omni: blocked. Need input or external action."
    : "Omni: blocker. Нужен ввод или внешнее действие.";
  return reason ? `${header}\n\n${reason}` : header;
}

export function buildAutoFailedMessage(reason = null, language = "rus") {
  const header = isEnglish(language)
    ? "Omni: autonomy loop failed."
    : "Omni: цикл автономии упал.";
  return reason ? `${header}\n\n${reason}` : header;
}

export function buildAutoStatusMessage(session) {
  const language = getSessionUiLanguage(session);
  const autoMode = session.auto_mode || {};

  return [
    isEnglish(language) ? "Auto status" : "Auto статус",
    "",
    `enabled: ${autoMode.enabled ? "yes" : "no"}`,
    `phase: ${autoMode.phase ?? "off"}`,
    `omni_bot_id: ${autoMode.omni_bot_id ?? "none"}`,
    `literal_goal_text: ${autoMode.literal_goal_text ?? "none"}`,
    `normalized_goal_interpretation: ${autoMode.normalized_goal_interpretation ?? "none"}`,
    `continuation_count: ${autoMode.continuation_count ?? 0}`,
    `continuation_count_since_compact: ${autoMode.continuation_count_since_compact ?? 0}`,
    `first_omni_prompt_at: ${autoMode.first_omni_prompt_at ?? "none"}`,
    `last_auto_compact_at: ${autoMode.last_auto_compact_at ?? "none"}`,
    `sleep_until: ${autoMode.sleep_until ?? "none"}`,
    `blocked_reason: ${autoMode.blocked_reason ?? "none"}`,
  ].join("\n");
}

export function buildOmniOperatorQueryPrompt({
  autoMode,
  exchangeEntry,
  operatorQuestion,
  session,
  omniMemory = null,
}) {
  const lines = [
    "You are Omni, the autonomy supervisor for Spike.",
    "Answer the operator directly in plain text.",
    "This is an operator side query, not a new work turn.",
    "Do not wake Spike, do not restart the run, do not change auto state, and do not edit files.",
    "If quick narrow repo inspection would materially improve the answer, you may inspect the current workspace, but stay read-only.",
    "Be concise, concrete, and truthful.",
    "",
    `session_key: ${session.session_key}`,
    `topic_id: ${session.topic_id}`,
    `workspace_cwd: ${session.workspace_binding?.cwd ?? "unknown"}`,
    `current_auto_phase: ${autoMode.phase ?? "off"}`,
    `sleep_until: ${autoMode.sleep_until ?? "none"}`,
    "",
    "Locked goal:",
    autoMode.normalized_goal_interpretation || autoMode.literal_goal_text || "none",
    "",
    `Latest Omni summary: ${autoMode.last_result_summary ?? "none"}`,
  ];

  pushOptionalSection(lines, "Current proof line:", omniMemory?.current_proof_line);
  pushOptionalSection(
    lines,
    "Why this matters to the goal:",
    omniMemory?.why_this_matters_to_goal,
  );
  pushOptionalSection(
    lines,
    "Remaining goal gap:",
    omniMemory?.goal_unsatisfied,
  );
  pushOptionalSection(
    lines,
    "What changed in the last cycle:",
    omniMemory?.what_changed_since_last_cycle,
  );
  pushOptionalListSection(lines, "Candidate pivots:", omniMemory?.candidate_pivots);
  pushOptionalListSection(lines, "Known bottlenecks:", omniMemory?.known_bottlenecks);
  pushOptionalSection(
    lines,
    "Latest planned wake-up prompt:",
    autoMode.sleep_next_prompt || "none",
  );
  pushOptionalSection(lines, "Latest Spike prompt:", exchangeEntry?.user_prompt || "none");
  pushOptionalSection(
    lines,
    "Latest Spike final reply:",
    exchangeEntry?.assistant_reply || "none",
  );

  lines.push("", "Operator question:", operatorQuestion);
  return lines.join("\n");
}

export function buildOmniTopicPrompt({
  autoMode,
  initialWorkerPrompt,
  session,
  pendingUserInput = null,
  mode = "initial",
  omniMemory = null,
  decisionMode = null,
}) {
  const lines = [
    "Goal-locked handoff from Omni.",
    "Autonomous continuation context.",
    "",
    `session_key: ${session.session_key}`,
    `topic_id: ${session.topic_id}`,
    `mode: ${mode}`,
    "",
    "Locked goal:",
    autoMode.normalized_goal_interpretation || autoMode.literal_goal_text || "none",
    "",
    "Autonomy policy:",
    "- Continue until the locked goal is honestly done, not just until one local step looks complete.",
    "- Choose the next best step autonomously and keep moving inside the goal envelope without waiting for permission.",
    "- Fix normal code, test, runtime, and integration breakage autonomously.",
    "- Treat an exhausted proof line as a pivot opportunity, not as a blocker by default.",
    "- Escalate only on real hard blockers such as missing secrets after vault lookup, manual external actions, or unrecoverable resource exhaustion.",
  ];

  pushOptionalListSection(lines, "Goal constraints:", omniMemory?.goal_constraints, {
    maxChars: 1200,
  });

  if (decisionMode && mode !== "initial") {
    lines.push("", "Supervisor decision:", describeDecisionMode(decisionMode, "eng"));
  }

  pushOptionalSection(lines, "Current proof line:", omniMemory?.current_proof_line);
  pushOptionalSection(lines, "Proof line status:", omniMemory?.proof_line_status, {
    maxChars: 300,
  });
  pushOptionalSection(
    lines,
    "Why this proof line matters to the locked goal:",
    omniMemory?.why_this_matters_to_goal,
  );
  pushOptionalSection(
    lines,
    "What changed since the last cycle:",
    omniMemory?.what_changed_since_last_cycle,
  );
  pushOptionalSection(
    lines,
    "What remains unsatisfied in the locked goal:",
    omniMemory?.goal_unsatisfied,
  );
  pushOptionalListSection(
    lines,
    "Optional bounded side work while the main line is waiting:",
    omniMemory?.side_work_queue,
  );
  pushOptionalListSection(lines, "Do not regress:", omniMemory?.do_not_regress);

  if (pendingUserInput) {
    lines.push("", "Fresh operator input to incorporate:", pendingUserInput);
  }

  lines.push(
    "",
    mode === "initial" ? "Initial worker prompt:" : "Primary next action:",
    initialWorkerPrompt,
  );

  return lines.join("\n");
}

export function buildOmniEvaluationPrompt({
  autoMode,
  exchangeEntry,
  pendingUserInput = null,
  session,
  omniMemory = null,
}) {
  const lines = [
    "You are Omni, the autonomy supervisor for Spike.",
    "Return JSON only. No markdown. No prose outside JSON.",
    "",
    "Core contract:",
    "- Stay locked to the user goal.",
    "- Spike remains the only heavy worker.",
    "- Treat the current proof line as a means to the goal, not as the goal itself.",
    "- If the current proof line is exhausted but the bigger goal still has an honest next path, return pivot_to_next_line instead of blocked_external.",
    "- blocked_external is only for real external hard stops.",
    "- Bounded side work is allowed only when it directly serves the locked goal and does not disrupt a healthy main line.",
    "- The real Spike wrapper already includes the locked goal and autonomy policy, so the handoff text should be concrete and operational, not a full mission restatement.",
    "- Never return a useless generic continue. The next action must say what Spike should actually do next.",
    "- If the live proof line is healthy and waiting, prefer continue_after_sleep with sleep_minutes 1..60 instead of instant re-pinging.",
    "",
    "Required JSON shape:",
    '{"decision_mode":"continue_same_line|continue_after_sleep|pivot_to_next_line|blocked_external|done|failed","summary":"short text","current_proof_line":"string or null","proof_line_status":"string or null","why_this_matters_to_goal":"string or null","what_changed":"string or null","goal_unsatisfied":"string or null","next_prompt":"string or null","side_work":["optional bounded goal-linked side work"],"do_not_regress":["optional constraints"],"known_bottlenecks":["optional bottlenecks"],"candidate_pivots":["optional pivot options"],"supervisor_notes":["optional notes"],"sleep_minutes":"integer 1..60 or null","user_message":"string or null","blocked_reason":"string or null"}',
    "",
    `session_key: ${session.session_key}`,
    `topic_id: ${session.topic_id}`,
    `workspace_cwd: ${session.workspace_binding?.cwd ?? "unknown"}`,
    "",
    "Locked goal:",
    autoMode.normalized_goal_interpretation || autoMode.literal_goal_text || "none",
    "",
    pendingUserInput ? `Fresh operator input: ${pendingUserInput}` : "Fresh operator input: none",
  ];

  pushOptionalListSection(lines, "Existing goal constraints:", omniMemory?.goal_constraints);
  pushOptionalSection(lines, "Current proof line memory:", omniMemory?.current_proof_line);
  pushOptionalSection(
    lines,
    "Current proof line status memory:",
    omniMemory?.proof_line_status,
    { maxChars: 300 },
  );
  pushOptionalSection(
    lines,
    "Why this matters to the goal memory:",
    omniMemory?.why_this_matters_to_goal,
  );
  pushOptionalSection(
    lines,
    "Goal gap memory:",
    omniMemory?.goal_unsatisfied,
  );
  pushOptionalSection(
    lines,
    "What changed memory:",
    omniMemory?.what_changed_since_last_cycle,
  );
  pushOptionalListSection(lines, "Known bottlenecks memory:", omniMemory?.known_bottlenecks);
  pushOptionalListSection(lines, "Candidate pivots memory:", omniMemory?.candidate_pivots);
  pushOptionalListSection(lines, "Do-not-regress memory:", omniMemory?.do_not_regress);
  pushOptionalListSection(lines, "Supervisor notes memory:", omniMemory?.supervisor_notes);
  pushOptionalSection(lines, "Latest Spike prompt:", exchangeEntry?.user_prompt || "none");
  pushOptionalSection(
    lines,
    "Latest Spike final reply:",
    exchangeEntry?.assistant_reply || "none",
  );

  return lines.join("\n");
}
