import fs from "node:fs/promises";

import { loadRuntimeConfig } from "../config/runtime-config.js";
import { createHostAwareRunTask } from "../pty-worker/host-aware-run-task.js";
import { CodexWorkerPool } from "../pty-worker/worker-pool.js";
import { createServiceState } from "../runtime/service-state.js";
import { buildSleepCommandPrompt } from "../runtime/live-command-prompts.js";
import { GlobalCodexSettingsStore } from "../session-manager/global-codex-settings-store.js";
import { GlobalPromptSuffixStore } from "../session-manager/global-prompt-suffix-store.js";
import { SessionCompactor } from "../session-manager/session-compactor.js";
import { SessionLifecycleManager } from "../session-manager/session-lifecycle-manager.js";
import { SessionService } from "../session-manager/session-service.js";
import { SessionStore } from "../session-manager/session-store.js";
import { ensureStateLayout } from "../state/layout.js";
import { handleIncomingMessage } from "../telegram/command-router.js";
import { TelegramBotApiClient } from "../telegram/bot-api-client.js";
import { runTelegramProbe } from "../telegram/probe.js";

const DEFAULT_SOAK_TOPIC_COUNT = 3;
const DEFAULT_SOAK_SLEEP_SECS = 3;
const DEFAULT_SOAK_TIMEOUT_SECS = 180;
const DEFAULT_SOAK_SAMPLE_INTERVAL_MS = 150;

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

function buildSyntheticTopicMessage({
  allowedUserId,
  chatId,
  topicId,
  messageId,
  text,
}) {
  return {
    ...(Number.isInteger(messageId) ? { message_id: messageId } : {}),
    date: Math.floor(Date.now() / 1000),
    text,
    from: {
      id: Number(allowedUserId),
      is_bot: false,
      first_name: "operator",
      username: "operator",
    },
    chat: {
      id: Number(chatId),
      type: "supergroup",
      title: "Codex Gateway Test Forum",
      is_forum: true,
    },
    message_thread_id: Number(topicId),
  };
}

function buildSoakPrompt({ token, sleepSecs, topicIndex }) {
  return [
    buildSleepCommandPrompt(sleepSecs),
    `After the command finishes, reply ONLY with ${token}.`,
    `Do not add any extra text.`,
    `This is soak topic ${topicIndex + 1}.`,
  ].join(" ");
}

async function waitFor(check, timeoutMs, label) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) {
      return value;
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const config = await loadRuntimeConfig();
  const layout = await ensureStateLayout(config.stateRoot);
  const api = new TelegramBotApiClient({
    token: config.telegramBotToken,
    baseUrl: config.telegramApiBaseUrl,
  });
  const probe = await runTelegramProbe(config, api);
  const serviceState = createServiceState(config, probe);
  const globalPromptSuffixStore = new GlobalPromptSuffixStore(layout.settings);
  const globalCodexSettingsStore = new GlobalCodexSettingsStore(layout.settings);
  const sessionStore = new SessionStore(layout.sessions);
  const runTask = createHostAwareRunTask({ config });
  const sessionCompactor = new SessionCompactor({
    sessionStore,
    config,
    globalCodexSettingsStore,
    runTask,
  });
  const lifecycleManager = new SessionLifecycleManager({
    config,
    sessionStore,
    sessionCompactor,
  });
  const sessionService = new SessionService({
    sessionStore,
    config,
    sessionCompactor,
    globalPromptSuffixStore,
    globalCodexSettingsStore,
  });
  const workerPool = new CodexWorkerPool({
    api,
    config,
    sessionStore,
    serviceState,
    sessionCompactor,
    sessionLifecycleManager: lifecycleManager,
    globalPromptSuffixStore,
    globalCodexSettingsStore,
    runTask,
  });
  lifecycleManager.workerPool = workerPool;

  const chatId = Number(config.telegramForumChatId);
  const topicCount = Math.min(
    parsePositiveIntegerEnv("SOAK_TOPIC_COUNT", DEFAULT_SOAK_TOPIC_COUNT),
    config.maxParallelSessions,
  );
  const sleepSecs = parsePositiveIntegerEnv(
    "SOAK_SLEEP_SECS",
    DEFAULT_SOAK_SLEEP_SECS,
  );
  const timeoutMs =
    parsePositiveIntegerEnv("SOAK_TIMEOUT_SECS", DEFAULT_SOAK_TIMEOUT_SECS) * 1000;

  if (topicCount < 2) {
    throw new Error("SOAK_TOPIC_COUNT must resolve to at least 2 topics");
  }

  const soakId = Date.now();
  const topics = [];
  let samplerRunning = true;
  let peakActiveRunCount = 0;

  const sampler = (async () => {
    while (samplerRunning) {
      peakActiveRunCount = Math.max(
        peakActiveRunCount,
        workerPool.activeRuns.size,
        serviceState.activeRunCount ?? 0,
      );
      await sleep(DEFAULT_SOAK_SAMPLE_INTERVAL_MS);
    }
  })();

  const cleanup = async () => {
    samplerRunning = false;
    await sampler.catch(() => {});
    await workerPool.shutdown().catch(() => {});

    await Promise.all(
      topics.map(async (topic) => {
        await api.deleteForumTopic({
          chat_id: chatId,
          message_thread_id: topic.topicId,
        }).catch(() => {});
        await fs.rm(sessionStore.getSessionDir(chatId, topic.topicId), {
          recursive: true,
          force: true,
        }).catch(() => {});
      }),
    );
  };

  try {
    for (let index = 0; index < topicCount; index += 1) {
      const forumTopic = await api.createForumTopic({
        chat_id: chatId,
        name: `Soak ${soakId} ${index + 1}`,
      });
      const token = `SOAK_${index + 1}_${soakId}`;
      topics.push({
        index,
        token,
        topicId: forumTopic.message_thread_id,
        topicName: forumTopic.name,
      });
    }

    const startResults = await Promise.all(
      topics.map((topic) =>
        handleIncomingMessage({
          api,
          botUsername: probe.me.username,
          config,
          lifecycleManager,
          message: buildSyntheticTopicMessage({
            allowedUserId: config.telegramAllowedUserId,
            chatId,
            topicId: topic.topicId,
            text: buildSoakPrompt({
              token: topic.token,
              sleepSecs,
              topicIndex: topic.index,
            }),
          }),
          serviceState,
          sessionService,
          workerPool,
        }),
      ),
    );

    for (const result of startResults) {
      if (result.reason !== "prompt-started") {
        throw new Error(`Unexpected soak start result: ${result.reason}`);
      }
    }

    await waitFor(
      () => peakActiveRunCount >= topicCount,
      Math.min(timeoutMs, sleepSecs * 2000 + 10000),
      "parallel active run count",
    );

    const sessionResults = await Promise.all(
      topics.map((topic) =>
        waitFor(async () => {
          const meta = await sessionStore.load(chatId, topic.topicId);
          if (!meta || meta.last_run_status !== "completed") {
            return null;
          }
          if (!meta.last_agent_reply || !meta.last_agent_reply.includes(topic.token)) {
            return null;
          }
          const compactState = await sessionStore.loadCompactState(meta).catch(() => null);

          return {
            topicId: topic.topicId,
            topicName: topic.topicName,
            sessionKey: meta.session_key,
            threadId: meta.codex_thread_id,
            lastReply: meta.last_agent_reply,
            activeBriefMentionsToken: Boolean(
              compactState?.activeBrief?.includes(topic.token),
            ),
            taskLedgerMentionsToken: Boolean(
              compactState?.taskLedger?.runs?.some((run) =>
                run.final_reply_excerpt?.includes(topic.token)),
            ),
          };
        }, timeoutMs, `soak completion for topic ${topic.topicId}`),
      ),
    );

    if (peakActiveRunCount < 2) {
      throw new Error(
        `Soak did not observe real overlap; peak_active_run_count=${peakActiveRunCount}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          soakId,
          topicCount,
          sleepSecs,
          peakActiveRunCount,
          sessionResults,
        },
        null,
        2,
      ),
    );
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(`soak failed: ${error.message}`);
  process.exitCode = 1;
});
