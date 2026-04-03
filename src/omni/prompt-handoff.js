import fs from "node:fs/promises";
import path from "node:path";

import { normalizeAutoModeState } from "../session-manager/auto-mode.js";
import { handleIncomingMessage } from "../telegram/command-router.js";

const OMNI_PENDING_PROMPT_FILE_NAME = "omni-pending-prompt.json";

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function buildQueueEntry({
  mode,
  prompt,
  createdAt = new Date().toISOString(),
}) {
  return {
    schema_version: 1,
    created_at: createdAt,
    mode: normalizeText(mode) || "continuation",
    prompt: normalizeText(prompt),
    synthetic_message_id: Date.now(),
  };
}

function parseQueueEntry(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const prompt = normalizeText(value.prompt);
  if (!prompt) {
    return null;
  }

  return {
    schema_version: 1,
    created_at: normalizeText(value.created_at) || new Date().toISOString(),
    mode: normalizeText(value.mode) || "continuation",
    prompt,
    synthetic_message_id:
      Number.isSafeInteger(value.synthetic_message_id) && value.synthetic_message_id > 0
        ? value.synthetic_message_id
        : Date.now(),
  };
}

export class OmniPromptHandoffStore {
  constructor(sessionStore) {
    this.sessionStore = sessionStore;
  }

  getPath(session) {
    return path.join(
      this.sessionStore.getSessionDir(session.chat_id, session.topic_id),
      OMNI_PENDING_PROMPT_FILE_NAME,
    );
  }

  async queue(session, payload) {
    const entry = buildQueueEntry(payload);
    await this.sessionStore.writeSessionJson(
      session,
      OMNI_PENDING_PROMPT_FILE_NAME,
      entry,
    );
    return entry;
  }

  async load(session) {
    const text = await this.sessionStore.readSessionText(
      session,
      OMNI_PENDING_PROMPT_FILE_NAME,
    );
    if (!text) {
      return null;
    }

    try {
      return parseQueueEntry(JSON.parse(text));
    } catch {
      return null;
    }
  }

  async clear(session) {
    await fs.rm(this.getPath(session), { force: true });
  }
}

export function buildSyntheticOmniPromptMessage(session, handoff, omniBotId) {
  return {
    message_id: handoff.synthetic_message_id,
    is_internal_omni_handoff: true,
    date: Math.floor(Date.now() / 1000),
    text: handoff.prompt,
    from: {
      id: Number(omniBotId),
      is_bot: true,
      first_name: "Omni",
      username: "omni",
    },
    chat: {
      id: Number(session.chat_id),
      type: "supergroup",
      title: session.topic_name || "forum-topic",
      is_forum: true,
    },
    message_thread_id: Number(session.topic_id),
  };
}

export async function drainPendingOmniPrompts({
  api,
  botUsername,
  config,
  lifecycleManager = null,
  promptFragmentAssembler = null,
  serviceState,
  sessionService,
  sessionStore,
  workerPool,
  promptHandoffStore,
  handleMessageImpl = handleIncomingMessage,
}) {
  const sessions = await sessionStore.listSessions();
  const results = [];

  for (const session of sessions) {
    const handoff = await promptHandoffStore.load(session);
    if (!handoff) {
      continue;
    }

    if (session.lifecycle_state === "purged") {
      await promptHandoffStore.clear(session);
      continue;
    }

    if (session.lifecycle_state !== "active") {
      continue;
    }

    const autoMode = normalizeAutoModeState(session.auto_mode);
    if (!autoMode.enabled || !autoMode.omni_bot_id) {
      await promptHandoffStore.clear(session);
      continue;
    }

    if (!workerPool.canStart(session.session_key).ok) {
      continue;
    }

    const message = buildSyntheticOmniPromptMessage(
      session,
      handoff,
      autoMode.omni_bot_id,
    );
    const directStartResult =
      handleMessageImpl === handleIncomingMessage
        ? await workerPool.startPromptRun({
            session,
            prompt: handoff.prompt,
            rawPrompt: handoff.prompt,
            message,
          })
        : null;
    const result = directStartResult
      ? (directStartResult.ok
          ? { handled: true, reason: "prompt-started" }
          : { handled: true, reason: directStartResult.reason })
      : await handleMessageImpl({
          api,
          botUsername,
          config,
          lifecycleManager,
          message,
          promptStartGuard: null,
          promptFragmentAssembler,
          serviceState,
          sessionService,
          workerPool,
        });

    if (result?.reason === "prompt-started") {
      await promptHandoffStore.clear(session);
    }

    results.push({
      sessionKey: session.session_key,
      topicId: session.topic_id,
      result,
    });
  }

  return results;
}
