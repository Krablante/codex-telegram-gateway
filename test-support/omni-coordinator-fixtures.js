import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { OmniCoordinator } from "../src/omni/coordinator.js";
import { SessionService } from "../src/session-manager/session-service.js";
import { SessionStore } from "../src/session-manager/session-store.js";
import { SpikeFinalEventStore } from "../src/session-manager/spike-final-event-store.js";
import { OmniPromptHandoffStore } from "../src/omni/prompt-handoff.js";

export function buildBinding(workspaceRoot) {
  return {
    repo_root: workspaceRoot,
    cwd: workspaceRoot,
    branch: "main",
    worktree_path: workspaceRoot,
  };
}

function buildConfig(stateRoot, workspaceRoot) {
  return {
    repoRoot: workspaceRoot,
    stateRoot,
    codexBinPath: "codex",
    atlasWorkspaceRoot: workspaceRoot,
    defaultSessionBindingPath: workspaceRoot,
    telegramForumChatId: "-1001234567890",
    telegramAllowedUserId: "5825672398",
    telegramAllowedUserIds: ["5825672398"],
    telegramAllowedBotIds: ["8603043042"],
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
  };
}

export async function buildHarness({
  decisionReply = null,
  startExecRun = null,
  sendMessageImpl = null,
  sessionLifecycleManager = null,
  sessionCompactor = null,
} = {}) {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-omni-coordinator-"),
  );
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-omni-workspace-"),
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: workspaceRoot });
  const sessionsRoot = path.join(stateRoot, "sessions");
  const sessionStore = new SessionStore(sessionsRoot);
  sessionStore.__testWorkspaceRoot = workspaceRoot;
  const config = buildConfig(stateRoot, workspaceRoot);
  const sessionService = new SessionService({
    sessionStore,
    config,
    sessionCompactor,
  });
  const spikeFinalEventStore = new SpikeFinalEventStore(sessionStore);
  const promptHandoffStore = new OmniPromptHandoffStore(sessionStore);
  const sent = [];
  const execPrompts = [];
  const execCalls = [];
  let nextMessageId = 500;
  const api = {
    async sendMessage(payload) {
      if (typeof sendMessageImpl === "function") {
        return sendMessageImpl(payload, { nextMessageId });
      }

      sent.push(payload);
      return {
        message_id: nextMessageId++,
      };
    },
  };

  const coordinator = new OmniCoordinator({
    api,
    config,
    promptHandoffStore,
    serviceState: {
      botUsername: "omnibot",
      handledCommands: 0,
      ignoredUpdates: 0,
    },
    sessionService,
    sessionStore,
    sessionLifecycleManager,
    spikeFinalEventStore,
    omniBotId: "8603043042",
    spikeBotId: "8537834861",
    startExecRun: startExecRun || ((params) => {
      execCalls.push(params);
      execPrompts.push(params.prompt);
      return {
        child: null,
        done: Promise.resolve({
          ok: true,
          finalReply:
            decisionReply ??
            JSON.stringify({
              status: "continue",
              summary: "Goal not done yet.",
              next_prompt: "Continue the work and verify the result.",
              user_message: null,
              blocked_reason: null,
            }),
        }),
      };
    }),
  });

  return {
    coordinator,
    config,
    execCalls,
    execPrompts,
    sent,
    promptHandoffStore,
    sessionService,
    sessionStore,
    spikeFinalEventStore,
    workspaceRoot,
  };
}

export async function ensureSession(sessionStore) {
  const workspaceRoot = sessionStore.__testWorkspaceRoot;
  return sessionStore.ensure({
    chatId: -1001234567890,
    topicId: 77,
    topicName: "Omni coordinator test",
    createdVia: "test",
    workspaceBinding: buildBinding(workspaceRoot),
  });
}

export function buildHumanTopicMessage({
  text,
  messageId = 100,
  threadId = 77,
  entities = undefined,
} = {}) {
  return {
    text,
    entities,
    from: { id: 5825672398, is_bot: false },
    chat: { id: -1001234567890 },
    message_id: messageId,
    message_thread_id: threadId,
  };
}
