import fs from "node:fs/promises";
import path from "node:path";

import { isAutoModeHumanInputLocked } from "./auto-mode.js";

const SPIKE_PROMPT_QUEUE_FILE_NAME = "spike-prompt-queue.json";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeReplyToMessageId(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .filter((attachment) => attachment && typeof attachment === "object")
    .map((attachment) => cloneJson(attachment));
}

function buildQueueEntry({
  rawPrompt,
  prompt,
  attachments = [],
  createdAt = new Date().toISOString(),
  replyToMessageId = null,
} = {}) {
  const normalizedPrompt = normalizeText(prompt);
  if (!normalizedPrompt) {
    return null;
  }

  return {
    schema_version: 1,
    created_at: normalizeText(createdAt) || new Date().toISOString(),
    raw_prompt: normalizeText(rawPrompt) || normalizedPrompt,
    prompt: normalizedPrompt,
    attachments: normalizeAttachments(attachments),
    reply_to_message_id: normalizeReplyToMessageId(replyToMessageId),
  };
}

function parseQueueEntry(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return buildQueueEntry({
    rawPrompt: value.raw_prompt,
    prompt: value.prompt,
    attachments: value.attachments,
    createdAt: value.created_at,
    replyToMessageId: value.reply_to_message_id,
  });
}

function buildEmptyQueueState() {
  return {
    schema_version: 1,
    updated_at: null,
    items: [],
  };
}

function parseQueueState(value) {
  if (!value || typeof value !== "object") {
    return buildEmptyQueueState();
  }

  const items = Array.isArray(value.items)
    ? value.items.map(parseQueueEntry).filter(Boolean)
    : [];

  return {
    schema_version: 1,
    updated_at: normalizeText(value.updated_at),
    items,
  };
}

function buildStoredQueueState(items) {
  return {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    items: normalizeAttachments(items),
  };
}

function buildQueuedPromptMessage(session, entry) {
  const message = {
    chat: {
      id: Number(session.chat_id),
    },
    message_thread_id: Number(session.topic_id),
  };

  if (Number.isInteger(entry?.reply_to_message_id)) {
    message.message_id = entry.reply_to_message_id;
  }

  return message;
}

export function summarizeQueuedPrompt(rawPrompt, maxWords = 5) {
  const words = String(rawPrompt || "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length === 0) {
    return "";
  }

  const preview = words.slice(0, maxWords).join(" ");
  return words.length > maxWords ? `${preview}...` : preview;
}

export class SpikePromptQueueStore {
  constructor(sessionStore) {
    this.sessionStore = sessionStore;
  }

  getPath(session) {
    return path.join(
      this.sessionStore.getSessionDir(session.chat_id, session.topic_id),
      SPIKE_PROMPT_QUEUE_FILE_NAME,
    );
  }

  async readUnlocked(session) {
    const text = await this.sessionStore.readSessionText(
      session,
      SPIKE_PROMPT_QUEUE_FILE_NAME,
    );
    if (!text) {
      return buildEmptyQueueState();
    }

    try {
      return parseQueueState(JSON.parse(text));
    } catch {
      return buildEmptyQueueState();
    }
  }

  async writeUnlocked(session, items) {
    if (!Array.isArray(items) || items.length === 0) {
      await fs.rm(this.getPath(session), { force: true });
      return buildEmptyQueueState();
    }

    const state = buildStoredQueueState(items);
    await this.sessionStore.writeSessionJson(
      session,
      SPIKE_PROMPT_QUEUE_FILE_NAME,
      state,
    );
    return state;
  }

  async load(session) {
    return this.sessionStore.withMetaLock(
      session.chat_id,
      session.topic_id,
      async () => (await this.readUnlocked(session)).items,
    );
  }

  async enqueue(session, payload) {
    return this.sessionStore.withMetaLock(
      session.chat_id,
      session.topic_id,
      async () => {
        const state = await this.readUnlocked(session);
        const entry = buildQueueEntry(payload);
        if (!entry) {
          throw new Error("Queued prompt is empty");
        }

        state.items.push(entry);
        await this.writeUnlocked(session, state.items);
        return {
          entry,
          position: state.items.length,
          size: state.items.length,
        };
      },
    );
  }

  async deleteAt(session, position) {
    return this.sessionStore.withMetaLock(
      session.chat_id,
      session.topic_id,
      async () => {
        const state = await this.readUnlocked(session);
        if (!Number.isInteger(position) || position < 1 || position > state.items.length) {
          return {
            entry: null,
            position: null,
            size: state.items.length,
          };
        }

        const [entry] = state.items.splice(position - 1, 1);
        await this.writeUnlocked(session, state.items);
        return {
          entry,
          position,
          size: state.items.length,
        };
      },
    );
  }

  async shift(session) {
    return this.deleteAt(session, 1);
  }

  async clear(session) {
    return this.sessionStore.withMetaLock(
      session.chat_id,
      session.topic_id,
      async () => {
        await fs.rm(this.getPath(session), { force: true });
      },
    );
  }
}

export async function drainPendingSpikePromptQueue({
  session = null,
  sessionStore,
  workerPool,
  promptQueueStore,
}) {
  const sessions = session
    ? [((await sessionStore.load(session.chat_id, session.topic_id)) || session)]
    : await sessionStore.listSessions();
  const results = [];

  for (const currentSession of sessions) {
    const queuedItems = await promptQueueStore.load(currentSession);
    if (queuedItems.length === 0) {
      continue;
    }

    if (currentSession.lifecycle_state === "purged") {
      await promptQueueStore.clear(currentSession);
      continue;
    }

    if (
      currentSession.lifecycle_state !== "active"
      || isAutoModeHumanInputLocked(currentSession)
    ) {
      continue;
    }

    const head = queuedItems[0];
    const result = await workerPool.startPromptRun({
      session: currentSession,
      prompt: head.prompt,
      rawPrompt: head.raw_prompt,
      message: buildQueuedPromptMessage(currentSession, head),
      attachments: normalizeAttachments(head.attachments),
    });

    if (result?.ok) {
      await promptQueueStore.shift(currentSession);
    }

    results.push({
      sessionKey: currentSession.session_key,
      topicId: currentSession.topic_id,
      queueLength: queuedItems.length,
      entry: head,
      result: result?.ok
        ? { handled: true, reason: "prompt-started" }
        : { handled: true, reason: result?.reason || "queue-start-failed" },
    });
  }

  return results;
}
