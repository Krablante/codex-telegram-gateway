import fs from "node:fs/promises";
import process from "node:process";

import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import {
  loadTelegramUserBootstrap,
  readTelegramUserSession,
} from "../live-user/client.js";
import { ensureStateLayout } from "../state/layout.js";
import { SessionStore } from "../session-manager/session-store.js";
import { SessionService } from "../session-manager/session-service.js";
import { TelegramBotApiClient } from "../telegram/bot-api-client.js";

const WAIT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 180000;
const STRESS_TOPIC_COUNT = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

    await fs.rm(
      sessionStore.getSessionDir(chatId, topic.topicId),
      { recursive: true, force: true },
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

async function sendGeneralMessage(userClient, chatId, text, {
  commandName = null,
} = {}) {
  return userClient.sendMessage(Number(chatId), {
    message: text,
    formattingEntities: commandName
      ? buildCommandEntities(commandName)
      : undefined,
  });
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

async function listForumTopics(userClient, chatId) {
  const response = await userClient.invoke(
    new Api.channels.GetForumTopics({
      channel: Number(chatId),
      offsetDate: 0,
      offsetId: 0,
      offsetTopic: 0,
      limit: 100,
    }),
  );

  return response.topics
    .filter((topic) => topic.className === "ForumTopic")
    .map((topic) => ({
      id: Number(topic.id),
      title: topic.title,
      topMessage: Number(topic.topMessage),
      closed: Boolean(topic.closed),
      hidden: Boolean(topic.hidden),
    }));
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
      fromId:
        Number(message?.fromId?.userId ?? message?.fromId?.channelId ?? 0) || null,
      replyToTopId:
        Number(message?.replyTo?.replyToTopId ?? message?.replyTo?.replyToMsgId ?? 0)
        || null,
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

async function waitForSession(sessionStore, chatId, topicId, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return waitFor(
    () => sessionStore.load(String(chatId), String(topicId)),
    timeoutMs,
    `session ${chatId}:${topicId}`,
  );
}

async function waitForRunCompletion(sessionStore, session, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  expectedToken = null,
} = {}) {
  return waitFor(async () => {
    const current = await sessionStore.load(session.chat_id, session.topic_id);
    if (!current || !["completed", "failed"].includes(current.last_run_status)) {
      return null;
    }
    if (
      expectedToken &&
      current.last_run_status === "completed" &&
      !current.last_agent_reply?.includes(expectedToken)
    ) {
      return null;
    }
    return current;
  }, timeoutMs, `run completion for ${session.session_key}`);
}

async function waitForAutoPhase(sessionStore, session, phase, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return waitFor(async () => {
    const current = await sessionStore.load(session.chat_id, session.topic_id);
    if (current?.auto_mode?.phase === phase) {
      return current;
    }
    return null;
  }, timeoutMs, `auto phase ${phase} for ${session.session_key}`);
}

async function waitForRunStart(sessionStore, session, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return waitFor(async () => {
    const current = await sessionStore.load(session.chat_id, session.topic_id);
    if (
      current?.last_run_started_at &&
      !["completed", "failed", "interrupted"].includes(current.last_run_status)
    ) {
      return current;
    }
    return null;
  }, timeoutMs, `run start for ${session.session_key}`);
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

async function runNewTopicScenario({
  createdTopics = [],
  userClient,
  sessionStore,
  chatId,
  stamp,
}) {
  const title = `Live User New ${stamp}`;
  const beforeTopics = await listForumTopics(userClient, chatId);
  const beforeIds = new Set(beforeTopics.map((topic) => topic.id));

  await sendGeneralMessage(userClient, chatId, `/new ${title}`, {
    commandName: "new",
  });

  const createdTopic = await waitFor(async () => {
    const topics = await listForumTopics(userClient, chatId);
    return topics.find((topic) =>
      topic.title === title && !beforeIds.has(topic.id));
  }, DEFAULT_TIMEOUT_MS, `/new topic ${title}`);
  const session = await waitForSession(sessionStore, chatId, createdTopic.id);
  registerCreatedTopic(createdTopics, {
    topicId: createdTopic.id,
    topicName: createdTopic.title,
  });

  return {
    scenario: "new-topic",
    ok: true,
    topicId: createdTopic.id,
    topicName: createdTopic.title,
    sessionKey: session.session_key,
  };
}

async function runPlainPromptScenario({
  userClient,
  sessionStore,
  chatId,
  topic,
  stamp,
}) {
  const token = `LIVE_USER_TEXT_${stamp}`;
  await sendTopicMessage(
    userClient,
    chatId,
    topic.topicId,
    `Reply ONLY with ${token}. Do not add extra text.`,
  );
  const completed = await waitForRunCompletion(sessionStore, topic.session, {
    expectedToken: token,
  });
  const threadReply = await waitForThreadReplyContaining(
    userClient,
    chatId,
    topic.topicId,
    token,
  );

  return {
    scenario: "plain-prompt",
    ok: completed.last_run_status === "completed",
    topicId: topic.topicId,
    lastAgentReply: completed.last_agent_reply,
    threadReplyId: threadReply.id,
  };
}

async function runAutoHappyPathScenario({
  userClient,
  sessionStore,
  chatId,
  topic,
  stamp,
}) {
  const token = `LIVE_AUTO_DONE_${stamp}`;

  await sendTopicMessage(userClient, chatId, topic.topicId, "/auto", {
    commandName: "auto",
  });
  await waitForAutoPhase(sessionStore, topic.session, "await_goal");

  await sendTopicMessage(
    userClient,
    chatId,
    topic.topicId,
    `Goal: finish only when the worker reply contains exactly ${token}.`,
  );
  await waitForAutoPhase(sessionStore, topic.session, "await_initial_prompt");

  await sendTopicMessage(
    userClient,
    chatId,
    topic.topicId,
    `Reply with exactly ${token}. Do not add extra text.`,
  );
  const spikeThreadReply = await waitForThreadReplyContaining(
    userClient,
    chatId,
    topic.topicId,
    token,
  );
  const done = await waitForAutoPhase(
    sessionStore,
    topic.session,
    "done",
    DEFAULT_TIMEOUT_MS,
  );

  return {
    scenario: "auto-happy-path",
    ok: done.auto_mode.phase === "done",
    topicId: topic.topicId,
    lastResultSummary: done.auto_mode.last_result_summary,
    lastAgentReply: done.last_agent_reply,
    spikeThreadReplyId: spikeThreadReply.id,
  };
}

async function runAutoInterruptResumeScenario({
  userClient,
  sessionStore,
  chatId,
  topic,
  stamp,
}) {
  const token = `LIVE_AUTO_RESUME_${stamp}`;

  await sendTopicMessage(userClient, chatId, topic.topicId, "/auto", {
    commandName: "auto",
  });
  await waitForAutoPhase(sessionStore, topic.session, "await_goal");

  await sendTopicMessage(
    userClient,
    chatId,
    topic.topicId,
    `Goal: finish only when the worker reply contains exactly ${token}.`,
  );
  await waitForAutoPhase(sessionStore, topic.session, "await_initial_prompt");

  await sendTopicMessage(
    userClient,
    chatId,
    topic.topicId,
    [
      "Run `sleep 20` first, then reply with exactly the target token.",
      `Target token: ${token}.`,
      "Do not finish before the sleep completes.",
    ].join("\n"),
  );
  await waitForRunStart(sessionStore, topic.session);

  await sleep(2000);
  await sendTopicMessage(userClient, chatId, topic.topicId, "/interrupt", {
    commandName: "interrupt",
  });

  const blocked = await waitForAutoPhase(
    sessionStore,
    topic.session,
    "blocked",
    DEFAULT_TIMEOUT_MS,
  );
  if (blocked.auto_mode.blocked_reason !== "Interrupted by operator") {
    throw new Error(
      `Unexpected blocked reason for ${topic.session.session_key}: ${blocked.auto_mode.blocked_reason ?? "none"}`,
    );
  }

  await sendTopicMessage(
    userClient,
    chatId,
    topic.topicId,
    `Resume now. Skip the sleep and reply with exactly ${token}.`,
  );

  const done = await waitForAutoPhase(
    sessionStore,
    topic.session,
    "done",
    DEFAULT_TIMEOUT_MS,
  );
  const spikeThreadReply = await waitForThreadReplyContaining(
    userClient,
    chatId,
    topic.topicId,
    token,
  );

  return {
    scenario: "auto-interrupt-resume",
    ok:
      done.auto_mode.phase === "done" &&
      done.last_agent_reply?.includes(token),
    topicId: topic.topicId,
    blockedReason: blocked.auto_mode.blocked_reason,
    lastResultSummary: done.auto_mode.last_result_summary,
    lastAgentReply: done.last_agent_reply,
    spikeThreadReplyId: spikeThreadReply.id,
  };
}

async function runParallelStressScenario({
  api,
  createdTopics = [],
  sessionService,
  sessionStore,
  userClient,
  chatId,
  stamp,
}) {
  const topics = [];
  for (let index = 0; index < STRESS_TOPIC_COUNT; index += 1) {
    const topic = await createDirectTopic(
      sessionService,
      api,
      chatId,
      `Live User Stress ${stamp} ${index + 1}`,
    );
    registerCreatedTopic(createdTopics, topic);
    topics.push(topic);
  }

  await Promise.all(
    topics.map((topic, index) =>
      sendTopicMessage(
        userClient,
        chatId,
        topic.topicId,
        `Reply ONLY with LIVE_USER_STRESS_${stamp}_${index + 1}. Do not add extra text.`,
      )),
  );

  const results = await Promise.all(
    topics.map((topic, index) =>
      waitForRunCompletion(sessionStore, topic.session, {
        expectedToken: `LIVE_USER_STRESS_${stamp}_${index + 1}`,
      })),
  );
  const threadReplies = await Promise.all(
    topics.map((topic, index) =>
      waitForThreadReplyContaining(
        userClient,
        chatId,
        topic.topicId,
        `LIVE_USER_STRESS_${stamp}_${index + 1}`,
      )),
  );

  return {
    scenario: "parallel-stress",
    ok: results.every((entry) => entry.last_run_status === "completed"),
    topicIds: topics.map((topic) => topic.topicId),
    replies: results.map((entry) => entry.last_agent_reply),
    threadReplyIds: threadReplies.map((entry) => entry.id),
  };
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
    const newTopic = await runNewTopicScenario({
      createdTopics,
      userClient,
      sessionStore,
      chatId,
      stamp,
    });
    console.log(JSON.stringify(newTopic, null, 2));

    const plainPromptTopic = {
      topicId: newTopic.topicId,
      topicName: newTopic.topicName,
      session: await waitForSession(sessionStore, chatId, newTopic.topicId),
    };
    console.log(JSON.stringify(
      await runPlainPromptScenario({
        userClient,
        sessionStore,
        chatId,
        topic: plainPromptTopic,
        stamp,
      }),
      null,
      2,
    ));

    const autoTopic = await createDirectTopic(
      sessionService,
      api,
      chatId,
      `Live Auto Happy ${stamp}`,
    );
    registerCreatedTopic(createdTopics, autoTopic);
    console.log(JSON.stringify(
      await runAutoHappyPathScenario({
        userClient,
        sessionStore,
        chatId,
        topic: autoTopic,
        stamp,
      }),
      null,
      2,
    ));

    const autoResumeTopic = await createDirectTopic(
      sessionService,
      api,
      chatId,
      `Live Auto Resume ${stamp}`,
    );
    registerCreatedTopic(createdTopics, autoResumeTopic);
    console.log(JSON.stringify(
      await runAutoInterruptResumeScenario({
        userClient,
        sessionStore,
        chatId,
        topic: autoResumeTopic,
        stamp,
      }),
      null,
      2,
    ));

    console.log(JSON.stringify(
      await runParallelStressScenario({
        api,
        createdTopics,
        sessionService,
        sessionStore,
        userClient,
        chatId,
        stamp,
      }),
      null,
      2,
    ));
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
