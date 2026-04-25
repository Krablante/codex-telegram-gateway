import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import {
  loadTelegramUserBootstrap,
  readTelegramUserSession,
} from "../live-user/client.js";
import { retryFilesystemOperation } from "../runtime/fs-retry.js";
import { buildSleepCommandPrompt } from "../runtime/live-command-prompts.js";
import { ensureStateLayout } from "../state/layout.js";
import { SessionStore } from "../session-manager/session-store.js";
import { SessionService } from "../session-manager/session-service.js";
import { TelegramBotApiClient } from "../telegram/bot-api-client.js";

const execFileAsync = promisify(execFile);

const WAIT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_LONG_SLEEP_SECS = 20;
const DEFAULT_RESUME_INTERRUPT_DELAY_MS = 2000;
const DEFAULT_RUN_STABILIZE_WAIT_MS = 4000;
const ROLLOUT_SETTLING_ERROR_RE =
  /previous rollout request is still settling/u;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }

  if (!/^\d+$/u.test(raw)) {
    throw new Error(`Expected ${name} to be a positive integer, got: ${raw}`);
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected ${name} to be > 0, got: ${raw}`);
  }

  return parsed;
}

function registerCreatedTopic(createdTopics, topic) {
  if (!Array.isArray(createdTopics) || !Number.isInteger(Number(topic?.topicId))) {
    return topic;
  }

  createdTopics.push({
    topicId: Number(topic.topicId),
    topicName: topic.topicName || null,
  });
  return topic;
}

async function cleanupCreatedTopics({
  api,
  createdTopics,
  sessionStore,
  chatId,
}) {
  const uniqueTopics = [...new Map(
    (Array.isArray(createdTopics) ? createdTopics : [])
      .filter((topic) => Number.isInteger(Number(topic?.topicId)))
      .map((topic) => [String(topic.topicId), {
        topicId: Number(topic.topicId),
        topicName: topic.topicName || null,
      }]),
  ).values()];

  const results = [];
  for (const topic of uniqueTopics.reverse()) {
    let deleteResult = "deleted";
    try {
      await api.deleteForumTopic({
        chat_id: Number(chatId),
        message_thread_id: Number(topic.topicId),
      });
    } catch (error) {
      deleteResult = error.message;
    }

    await retryFilesystemOperation(
      () => fs.rm(
        sessionStore.getSessionDir(chatId, topic.topicId),
        { recursive: true, force: true },
      ),
    ).catch(() => {});

    results.push({
      topicId: topic.topicId,
      topicName: topic.topicName,
      deleteResult,
    });
  }

  return results;
}

async function waitFor(check, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) {
      return value;
    }
    await sleep(WAIT_POLL_MS);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

function buildCommandEntities(commandName) {
  return [
    new Api.MessageEntityBotCommand({
      offset: 0,
      length: commandName.length + 1,
    }),
  ];
}

async function sendTopicMessage(userClient, chatId, topicId, text, {
  commandName = null,
} = {}) {
  return userClient.sendMessage(Number(chatId), {
    message: text,
    replyTo: Number(topicId),
    topMsgId: Number(topicId),
    formattingEntities: commandName
      ? buildCommandEntities(commandName)
      : undefined,
  });
}

async function sendTopicFile(userClient, chatId, topicId, filePath, caption) {
  return userClient.sendFile(Number(chatId), {
    file: filePath,
    caption,
    replyTo: Number(topicId),
    topMsgId: Number(topicId),
  });
}

async function listTopicReplies(userClient, chatId, topicId) {
  const peer = await userClient.getInputEntity(Number(chatId));
  const response = await userClient.invoke(
    new Api.messages.GetReplies({
      peer,
      msgId: Number(topicId),
      offsetId: 0,
      offsetDate: 0,
      addOffset: 0,
      limit: 100,
      maxId: 0,
      minId: 0,
      hash: BigInt(0),
    }),
  );

  return Array.isArray(response?.messages)
    ? response.messages.map((message) => ({
      id: Number(message.id),
      text: String(message.message || "").trim(),
    }))
    : [];
}

async function waitForThreadReplyContaining(
  userClient,
  chatId,
  topicId,
  needle,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  return waitFor(async () => {
    const replies = await listTopicReplies(userClient, chatId, topicId);
    return replies.find((reply) => reply.text.includes(needle)) || null;
  }, timeoutMs, `thread reply containing ${needle} in ${chatId}:${topicId}`);
}

async function waitForRunStart(sessionStore, session, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return waitFor(async () => {
    const current = await sessionStore.load(session.chat_id, session.topic_id);
    if (
      current?.last_run_started_at
      && !["completed", "failed", "interrupted"].includes(current.last_run_status)
    ) {
      return current;
    }
    return null;
  }, timeoutMs, `run start for ${session.session_key}`);
}

async function waitForRunStatus(
  sessionStore,
  session,
  statuses,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    expectedToken = null,
  } = {},
) {
  const allowedStatuses = new Set(
    Array.isArray(statuses)
      ? statuses.map((entry) => String(entry))
      : [String(statuses)],
  );

  return waitFor(async () => {
    const current = await sessionStore.load(session.chat_id, session.topic_id);
    if (!current || !allowedStatuses.has(current.last_run_status)) {
      return null;
    }
    if (
      expectedToken
      && current.last_run_status === "completed"
      && !current.last_agent_reply?.includes(expectedToken)
    ) {
      return null;
    }
    return current;
  }, timeoutMs, `run status ${[...allowedStatuses].join(",")} for ${session.session_key}`);
}

async function waitForSessionOwnerOrCompleted(
  sessionStore,
  session,
  {
    expectedToken = null,
    generationId,
    mode,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  },
) {
  return waitFor(async () => {
    const current = await sessionStore.load(session.chat_id, session.topic_id);
    if (!current) {
      return null;
    }
    if (
      (!generationId || current.session_owner_generation_id === generationId)
      && (!mode || current.session_owner_mode === mode)
    ) {
      return {
        completedBeforeOwnerObservation: false,
        session: current,
      };
    }
    if (
      current.last_run_status === "completed"
      && (!expectedToken || current.last_agent_reply?.includes(expectedToken))
    ) {
      return {
        completedBeforeOwnerObservation: true,
        session: current,
      };
    }
    return null;
  }, timeoutMs, `session owner ${generationId || "any"} or completion for ${session.session_key}`);
}

async function waitForCompactionReset(
  sessionStore,
  session,
  previousCompactedAt,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  return waitFor(async () => {
    const current = await sessionStore.load(session.chat_id, session.topic_id);
    if (!current?.last_compacted_at || current.last_compacted_at === previousCompactedAt) {
      return null;
    }
    if (
      current.codex_thread_id !== null
      || current.provider_session_id !== null
      || current.codex_rollout_path !== null
    ) {
      return null;
    }
    return current;
  }, timeoutMs, `compaction reset for ${session.session_key}`);
}

async function createDirectTopic(sessionService, api, chatId, title) {
  const { forumTopic, session } = await sessionService.createTopicSession({
    api,
    message: { chat: { id: Number(chatId) } },
    title,
  });
  return {
    topicId: Number(forumTopic.message_thread_id),
    topicName: forumTopic.name,
    session,
  };
}

function buildLongSpikePrompt({ token, sleepSecs, label, platform = process.platform }) {
  return [
    buildSleepCommandPrompt(sleepSecs, { platform }),
    `After the command finishes, reply ONLY with ${token}.`,
    "Do not add extra text.",
    label ? `Scenario label: ${label}.` : null,
  ].filter(Boolean).join(" ");
}

function buildSkippedScenario(scenario, reason) {
  return {
    scenario,
    ok: true,
    skipped: true,
    reason,
  };
}

function parseKeyValueOutput(text) {
  const result = {};
  for (const rawLine of String(text || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

async function runServiceRollout(config, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const startedAt = Date.now();
  let lastSettlingError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ["src/cli/service-rollout.js"],
        {
          cwd: config.repoRoot,
          env: {
            ...process.env,
            ENV_FILE: config.envFilePath,
          },
        },
      );
      const parsed = parseKeyValueOutput(stdout);
      if (stderr?.trim()) {
        parsed.stderr = stderr.trim();
      }
      return parsed;
    } catch (error) {
      const text = [
        error?.message,
        error?.stdout,
        error?.stderr,
      ].filter(Boolean).join("\n");
      if (!ROLLOUT_SETTLING_ERROR_RE.test(text)) {
        throw error;
      }

      lastSettlingError = error;
      await sleep(WAIT_POLL_MS);
    }
  }

  throw lastSettlingError || new Error("Timed out waiting for service rollout settling");
}

async function runSpikeInterruptResumeScenario({
  api,
  chatId,
  createdTopics,
  sessionService,
  sessionStore,
  sleepSecs,
  stamp,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  userClient,
}) {
  const topic = registerCreatedTopic(
    createdTopics,
    await createDirectTopic(
      sessionService,
      api,
      chatId,
      `Spike Interrupt Resume ${stamp}`,
    ),
  );
  const token = `SPIKE_RESUME_${stamp}`;

  await sendTopicMessage(
    userClient,
    chatId,
    topic.topicId,
    buildLongSpikePrompt({
      token,
      sleepSecs,
      label: "interrupt-resume",
      platform: process.platform,
    }),
  );
  await waitForRunStart(sessionStore, topic.session, timeoutMs);
  await sleep(DEFAULT_RESUME_INTERRUPT_DELAY_MS);
  await sendTopicMessage(userClient, chatId, topic.topicId, "/interrupt", {
    commandName: "interrupt",
  });
  const interrupted = await waitForRunStatus(
    sessionStore,
    topic.session,
    "interrupted",
    { timeoutMs },
  );

  await sendTopicMessage(
    userClient,
    chatId,
    topic.topicId,
    `Resume now. Skip the sleep and reply ONLY with ${token}.`,
  );
  const resumed = await waitForRunStatus(
    sessionStore,
    topic.session,
    "completed",
    { expectedToken: token, timeoutMs },
  );
  const threadReply = await waitForThreadReplyContaining(
    userClient,
    chatId,
    topic.topicId,
    token,
    timeoutMs,
  );

  return {
    scenario: "spike-interrupt-resume",
    ok: resumed.last_run_status === "completed",
    topicId: topic.topicId,
    interruptedThreadId: interrupted.codex_thread_id,
    resumedThreadId: resumed.codex_thread_id,
    threadReplyId: threadReply.id,
  };
}

async function runRetainedRolloutChainScenario({
  api,
  chatId,
  config,
  createdTopics,
  sessionService,
  sessionStore,
  sleepSecs,
  stamp,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  userClient,
}) {
  if (process.platform !== "linux") {
    return buildSkippedScenario(
      "spike-retained-rollout-chain",
      "Linux-only: retained rollout chaining depends on the systemd-backed service-rollout path.",
    );
  }

  const longTopicA = registerCreatedTopic(
    createdTopics,
    await createDirectTopic(
      sessionService,
      api,
      chatId,
      `Spike Retained A ${stamp}`,
    ),
  );
  const tokenA = `SPIKE_RETAIN_A_${stamp}`;
  await sendTopicMessage(
    userClient,
    chatId,
    longTopicA.topicId,
    buildLongSpikePrompt({
      token: tokenA,
      sleepSecs,
      label: "retained-a",
      platform: process.platform,
    }),
  );
  await waitForRunStart(sessionStore, longTopicA.session, timeoutMs);

  const firstRollout = await runServiceRollout(config, { timeoutMs });
  if (firstRollout.mode !== "soft-rollout") {
    throw new Error(
      `Unexpected first rollout mode: ${firstRollout.mode || "unknown"}`,
    );
  }
  const retainedAResult = await waitForSessionOwnerOrCompleted(
    sessionStore,
    longTopicA.session,
    {
      expectedToken: tokenA,
      generationId: firstRollout.previous_generation,
      mode: "retiring",
      timeoutMs,
    },
  );
  const retainedA = retainedAResult.session;

  const longTopicB = registerCreatedTopic(
    createdTopics,
    await createDirectTopic(
      sessionService,
      api,
      chatId,
      `Spike Retained B ${stamp}`,
    ),
  );
  const tokenB = `SPIKE_RETAIN_B_${stamp}`;
  await sendTopicMessage(
    userClient,
    chatId,
    longTopicB.topicId,
    buildLongSpikePrompt({
      token: tokenB,
      sleepSecs,
      label: "retained-b",
      platform: process.platform,
    }),
  );
  await waitForRunStart(sessionStore, longTopicB.session, timeoutMs);

  const secondRollout = await runServiceRollout(config, { timeoutMs });
  if (secondRollout.mode !== "soft-rollout") {
    throw new Error(
      `Unexpected second rollout mode: ${secondRollout.mode || "unknown"}`,
    );
  }
  const retainedBResult = await waitForSessionOwnerOrCompleted(
    sessionStore,
    longTopicB.session,
    {
      expectedToken: tokenB,
      generationId: secondRollout.previous_generation,
      mode: "retiring",
      timeoutMs,
    },
  );
  const retainedB = retainedBResult.session;
  const retainedAAfterSecond = await sessionStore.load(
    longTopicA.session.chat_id,
    longTopicA.session.topic_id,
  );

  const quickTopic = registerCreatedTopic(
    createdTopics,
    await createDirectTopic(
      sessionService,
      api,
      chatId,
      `Spike Fresh Leader ${stamp}`,
    ),
  );
  const quickToken = `SPIKE_FRESH_${stamp}`;
  await sendTopicMessage(
    userClient,
    chatId,
    quickTopic.topicId,
    `Reply ONLY with ${quickToken}. Do not add extra text.`,
  );
  const quickCompleted = await waitForRunStatus(
    sessionStore,
    quickTopic.session,
    "completed",
    { expectedToken: quickToken, timeoutMs },
  );
  const quickThreadReply = await waitForThreadReplyContaining(
    userClient,
    chatId,
    quickTopic.topicId,
    quickToken,
    timeoutMs,
  );

  const completedA = await waitForRunStatus(
    sessionStore,
    longTopicA.session,
    "completed",
    { expectedToken: tokenA, timeoutMs },
  );
  const completedB = await waitForRunStatus(
    sessionStore,
    longTopicB.session,
    "completed",
    { expectedToken: tokenB, timeoutMs },
  );

  return {
    scenario: "spike-retained-rollout-chain",
    ok:
      quickCompleted.last_run_status === "completed"
      && completedA.last_run_status === "completed"
      && completedB.last_run_status === "completed",
    firstRollout,
    secondRollout,
    retainedAOwner: retainedA.session_owner_generation_id,
    retainedACompletedBeforeOwnerObservation:
      retainedAResult.completedBeforeOwnerObservation,
    retainedAOwnerAfterSecond:
      retainedAAfterSecond?.session_owner_generation_id ?? null,
    retainedBOwner: retainedB.session_owner_generation_id,
    retainedBCompletedBeforeOwnerObservation:
      retainedBResult.completedBeforeOwnerObservation,
    freshLeaderTopicId: quickTopic.topicId,
    freshLeaderReplyId: quickThreadReply.id,
  };
}

async function runCompactScenarios({
  api,
  chatId,
  createdTopics,
  sessionService,
  sessionStore,
  sleepSecs,
  stamp,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  userClient,
}) {
  const activeTopic = registerCreatedTopic(
    createdTopics,
    await createDirectTopic(
      sessionService,
      api,
      chatId,
      `Spike Compact Active ${stamp}`,
    ),
  );
  const activeToken = `SPIKE_COMPACT_ACTIVE_${stamp}`;
  await sendTopicMessage(
    userClient,
    chatId,
    activeTopic.topicId,
    buildLongSpikePrompt({
      token: activeToken,
      sleepSecs,
      label: "compact-active",
      platform: process.platform,
    }),
  );
  await waitForRunStart(sessionStore, activeTopic.session, timeoutMs);
  await sendTopicMessage(userClient, chatId, activeTopic.topicId, "/compact", {
    commandName: "compact",
  });
  await sleep(DEFAULT_RUN_STABILIZE_WAIT_MS);
  const compactBlockedState = await sessionStore.load(
    activeTopic.session.chat_id,
    activeTopic.session.topic_id,
  );
  if (compactBlockedState?.last_compacted_at) {
    throw new Error(
      `Compact unexpectedly ran during active Spike session ${activeTopic.session.session_key}`,
    );
  }
  const activeCompleted = await waitForRunStatus(
    sessionStore,
    activeTopic.session,
    "completed",
    { expectedToken: activeToken, timeoutMs },
  );

  const freshTopic = registerCreatedTopic(
    createdTopics,
    await createDirectTopic(
      sessionService,
      api,
      chatId,
      `Spike Compact Fresh ${stamp}`,
    ),
  );
  const beforeToken = `SPIKE_COMPACT_BEFORE_${stamp}`;
  await sendTopicMessage(
    userClient,
    chatId,
    freshTopic.topicId,
    `Reply ONLY with ${beforeToken}. Do not add extra text.`,
  );
  const beforeCompact = await waitForRunStatus(
    sessionStore,
    freshTopic.session,
    "completed",
    { expectedToken: beforeToken, timeoutMs },
  );
  const oldThreadId = beforeCompact.codex_thread_id;
  const previousCompactedAt = beforeCompact.last_compacted_at;

  await sendTopicMessage(userClient, chatId, freshTopic.topicId, "/compact", {
    commandName: "compact",
  });
  await waitForCompactionReset(
    sessionStore,
    freshTopic.session,
    previousCompactedAt,
    timeoutMs,
  );

  const afterToken = `SPIKE_COMPACT_AFTER_${stamp}`;
  await sendTopicMessage(
    userClient,
    chatId,
    freshTopic.topicId,
    `Reply ONLY with ${afterToken}. Do not add extra text.`,
  );
  const afterCompact = await waitForRunStatus(
    sessionStore,
    freshTopic.session,
    "completed",
    { expectedToken: afterToken, timeoutMs },
  );
  const afterThreadReply = await waitForThreadReplyContaining(
    userClient,
    chatId,
    freshTopic.topicId,
    afterToken,
    timeoutMs,
  );

  if (!afterCompact.codex_thread_id || afterCompact.codex_thread_id === oldThreadId) {
    throw new Error(
      `Compact did not force a fresh thread for ${freshTopic.session.session_key}`,
    );
  }

  return {
    scenario: "spike-compact-contract",
    ok:
      activeCompleted.last_run_status === "completed"
      && afterCompact.last_run_status === "completed",
    activeTopicId: activeTopic.topicId,
    freshTopicId: freshTopic.topicId,
    oldThreadId,
    newThreadId: afterCompact.codex_thread_id,
    afterThreadReplyId: afterThreadReply.id,
  };
}

async function runAttachmentIngressScenario({
  api,
  chatId,
  createdTopics,
  sessionService,
  sessionStore,
  stamp,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  userClient,
}) {
  const topic = registerCreatedTopic(
    createdTopics,
    await createDirectTopic(
      sessionService,
      api,
      chatId,
      `Spike Attachment ${stamp}`,
    ),
  );
  const token = `SPIKE_ATTACHMENT_${stamp}`;
  const attachmentPath = path.join(
    os.tmpdir(),
    `codex-telegram-gateway-attachment-${stamp}.txt`,
  );
  await fs.writeFile(
    attachmentPath,
    [
      "Read this file and follow its instruction exactly.",
      `Reply ONLY with ${token}.`,
    ].join("\n"),
    "utf8",
  );

  try {
    await sendTopicFile(
      userClient,
      chatId,
      topic.topicId,
      attachmentPath,
      `Open the attached file and follow it exactly.`,
    );
    const completed = await waitForRunStatus(
      sessionStore,
      topic.session,
      "completed",
      { expectedToken: token, timeoutMs },
    );
    const threadReply = await waitForThreadReplyContaining(
      userClient,
      chatId,
      topic.topicId,
      token,
      timeoutMs,
    );
    return {
      scenario: "spike-attachment-ingress",
      ok: completed.last_run_status === "completed",
      topicId: topic.topicId,
      threadReplyId: threadReply.id,
    };
  } finally {
    await retryFilesystemOperation(
      () => fs.rm(attachmentPath, { force: true }),
    ).catch(() => {});
  }
}

async function main() {
  const config = await loadRuntimeConfig();
  const layout = await ensureStateLayout(config.stateRoot);
  const sessionStore = new SessionStore(layout.sessions);
  const sessionService = new SessionService({
    sessionStore,
    config,
  });
  const api = new TelegramBotApiClient({
    token: config.telegramBotToken,
    baseUrl: config.telegramApiBaseUrl,
  });
  const userBootstrap = await loadTelegramUserBootstrap();
  if (!userBootstrap.userConfig) {
    throw userBootstrap.userConfigError || new Error("Missing Telegram user config");
  }

  const sessionString = await readTelegramUserSession(userBootstrap.paths);
  if (!sessionString) {
    throw new Error(
      `Missing Telegram user session: ${userBootstrap.paths.sessionFilePath}`,
    );
  }

  const userClient = new TelegramClient(
    new StringSession(sessionString),
    userBootstrap.userConfig.apiId,
    userBootstrap.userConfig.apiHash,
    { connectionRetries: 5 },
  );

  const stamp = Date.now();
  const chatId = Number(config.telegramForumChatId);
  const createdTopics = [];
  const sleepSecs = parsePositiveIntegerEnv(
    "SPIKE_AUDIT_LONG_SLEEP_SECS",
    DEFAULT_LONG_SLEEP_SECS,
  );
  const timeoutMs = parsePositiveIntegerEnv(
    "SPIKE_AUDIT_TIMEOUT_SECS",
    Math.floor(DEFAULT_TIMEOUT_MS / 1000),
  ) * 1000;
  let mainError = null;
  let cleanupPromise = null;

  const performCleanup = async () => {
    cleanupPromise ??= (async () => {
      await userClient.disconnect().catch(() => {});
      const cleanupResults = await cleanupCreatedTopics({
        api,
        createdTopics,
        sessionStore,
        chatId,
      });
      if (cleanupResults.length > 0) {
        console.log(JSON.stringify({
          scenario: "cleanup",
          removed: cleanupResults.length,
          topics: cleanupResults.map((entry) => ({
            topicId: entry.topicId,
            deleteResult: entry.deleteResult,
          })),
        }, null, 2));
      }
      return cleanupResults;
    })();

    return cleanupPromise;
  };

  const handleSignal = (signal) => {
    mainError ??= new Error(`Interrupted by ${signal}`);
    void performCleanup().finally(() => {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      process.exit();
    });
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    await userClient.connect();

    const scenarios = [
      await runSpikeInterruptResumeScenario({
        api,
        chatId,
        createdTopics,
        sessionService,
        sessionStore,
        sleepSecs,
        stamp,
        timeoutMs,
        userClient,
      }),
      await runRetainedRolloutChainScenario({
        api,
        chatId,
        config,
        createdTopics,
        sessionService,
        sessionStore,
        sleepSecs,
        stamp,
        timeoutMs,
        userClient,
      }),
      await runCompactScenarios({
        api,
        chatId,
        createdTopics,
        sessionService,
        sessionStore,
        sleepSecs,
        stamp,
        timeoutMs,
        userClient,
      }),
      await runAttachmentIngressScenario({
        api,
        chatId,
        createdTopics,
        sessionService,
        sessionStore,
        stamp,
        timeoutMs,
        userClient,
      }),
    ];

    for (const scenario of scenarios) {
      console.log(JSON.stringify(scenario, null, 2));
      if (!scenario.ok) {
        throw new Error(`Scenario failed: ${scenario.scenario}`);
      }
    }

    console.log(JSON.stringify({
      ok: true,
      stamp,
      sleepSecs,
      timeoutMs,
      scenarios: scenarios.map((scenario) => scenario.scenario),
    }, null, 2));
  } catch (error) {
    mainError = error;
  } finally {
    try {
      await performCleanup();
    } catch (cleanupError) {
      if (!mainError) {
        mainError = cleanupError;
      } else {
        console.error(
          `cleanup failed after main error: ${cleanupError.stack || cleanupError.message}`,
        );
      }
    }
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  }

  if (mainError) {
    throw mainError;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
