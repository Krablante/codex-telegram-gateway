import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionStore } from "../src/session-manager/session-store.js";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

export async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }

    await sleep(20);
  }

  throw new Error("Timed out waiting for worker-pool state");
}

export async function waitForRunToFinish(workerPool, sessionKey, timeoutMs = 2000) {
  await waitFor(() => workerPool.getActiveRun(sessionKey) === null, timeoutMs);
}

export function createServiceState(overrides = {}) {
  return {
    acceptedPrompts: 0,
    lastPromptAt: null,
    activeRunCount: 0,
    ...overrides,
  };
}

export function createWorkspaceBinding(overrides = {}) {
  return {
    repo_root: "/workspace",
    cwd: "/workspace",
    branch: "main",
    worktree_path: "/workspace",
    ...overrides,
  };
}

export const DEFAULT_WORKSPACE_BINDING = createWorkspaceBinding();
export const createWorkerPoolServiceState = createServiceState;

export async function createTempSessionStore(
  prefix = "codex-telegram-gateway-sessions-",
) {
  const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    sessionsRoot,
    sessionStore: new SessionStore(sessionsRoot),
    async cleanup() {
      await fs.rm(sessionsRoot, { recursive: true, force: true });
    },
  };
}

export async function createSession(
  sessionStore,
  {
    chatId = -1001234567890,
    topicId = 144,
    topicName = "Worker pool test",
    createdVia = "command/new",
    workspaceBinding = createWorkspaceBinding(),
    ...overrides
  } = {},
) {
  return sessionStore.ensure({
    chatId,
    topicId,
    topicName,
    createdVia,
    workspaceBinding,
    ...overrides,
  });
}

export function createTelegramApiRecorder(overrides = {}) {
  const sentMessages = [];
  const editedMessages = [];
  const deletedMessages = [];
  const sentDocuments = [];
  const chatActions = [];

  return {
    sentMessages,
    editedMessages,
    deletedMessages,
    sentDocuments,
    chatActions,
    api: {
      async sendMessage(payload) {
        sentMessages.push(payload);
        return { message_id: sentMessages.length || 1 };
      },
      async editMessageText(payload) {
        editedMessages.push(payload);
        return { ok: true };
      },
      async deleteMessage(payload) {
        deletedMessages.push(payload);
        return true;
      },
      async sendDocument(payload) {
        sentDocuments.push(payload);
        return { message_id: sentDocuments.length || 1 };
      },
      async sendChatAction(payload) {
        chatActions.push(payload);
        return true;
      },
      ...overrides,
    },
  };
}
