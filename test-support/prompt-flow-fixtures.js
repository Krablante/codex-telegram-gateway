export const config = {
  telegramAllowedUserId: "5825672398",
  telegramAllowedUserIds: ["5825672398"],
  telegramAllowedBotIds: ["8603043042"],
  telegramForumChatId: "-1003577434463",
  maxParallelSessions: 4,
  codexModel: "gpt-5.4",
  codexReasoningEffort: "medium",
  codexContextWindow: 320000,
  codexAutoCompactTokenLimit: 300000,
  codexConfigPath: "/tmp/codex-telegram-gateway-tests-missing-config.toml",
};
export const PROMPT_FLOW_CONFIG = config;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate,
  {
    timeoutMs = 300,
    intervalMs = 5,
  } = {},
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for test condition");
}

export function createServiceState(overrides = {}) {
  return {
    ignoredUpdates: 0,
    handledCommands: 0,
    lastCommandName: null,
    lastCommandAt: null,
    ...overrides,
  };
}
export const createPromptServiceState = createServiceState;

export function createWorkspaceBinding(overrides = {}) {
  return {
    repo_root: "/home/bloob/atlas",
    cwd: "/home/bloob/atlas",
    branch: "main",
    worktree_path: "/home/bloob/atlas",
    ...overrides,
  };
}

export function createTopicSession(overrides = {}) {
  return {
    session_key: "-1003577434463:77",
    chat_id: "-1003577434463",
    topic_id: "77",
    lifecycle_state: "active",
    ui_language: "rus",
    prompt_suffix_enabled: false,
    prompt_suffix_text: null,
    workspace_binding: createWorkspaceBinding(),
    ...overrides,
  };
}

export function captureApi() {
  const sent = [];
  return {
    sent,
    api: {
      async sendMessage(payload) {
        sent.push(payload);
        return { message_id: sent.length || 1 };
      },
    },
  };
}
export const createPromptSession = createTopicSession;
