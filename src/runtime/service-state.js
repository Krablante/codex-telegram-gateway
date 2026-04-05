export function createServiceState(config, probe) {
  return {
    startedAt: new Date().toISOString(),
    allowedUserId: config.telegramAllowedUserId,
    allowedUserIds: config.telegramAllowedUserIds,
    allowedBotIds: config.telegramAllowedBotIds,
    forumChatId: config.telegramForumChatId,
    botId: String(probe.me.id),
    botUsername: probe.me.username || null,
    omniEnabled: config.omniEnabled !== false,
    codexModel: config.codexModel,
    codexReasoningEffort: config.codexReasoningEffort,
    codexContextWindow: config.codexContextWindow,
    codexAutoCompactTokenLimit: config.codexAutoCompactTokenLimit,
    handledUpdates: 0,
    ignoredUpdates: 0,
    handledCommands: 0,
    acceptedPrompts: 0,
    pollErrors: 0,
    knownSessions: 0,
    seenSessionKeys: new Set(),
    activeRunCount: 0,
    generationId: null,
    isLeader: false,
    retiring: false,
    rolloutStatus: "idle",
    lastUpdateId: null,
    lastCommandName: null,
    lastCommandAt: null,
    lastPromptAt: null,
    bootstrapDroppedUpdateId: null,
  };
}

export function markBootstrapDrop(serviceState, updateId) {
  serviceState.bootstrapDroppedUpdateId = updateId;
}

export function markUpdateSeen(serviceState, updateId) {
  serviceState.handledUpdates += 1;
  serviceState.lastUpdateId = updateId;
}

export function markPollError(serviceState) {
  serviceState.pollErrors += 1;
}

export function markSessionSeen(serviceState, sessionKey) {
  if (serviceState.seenSessionKeys.has(sessionKey)) {
    return;
  }

  serviceState.seenSessionKeys.add(sessionKey);
  serviceState.knownSessions += 1;
}

export function markPromptAccepted(serviceState) {
  serviceState.acceptedPrompts += 1;
  serviceState.lastPromptAt = new Date().toISOString();
}

export function setActiveRunCount(serviceState, activeRunCount) {
  serviceState.activeRunCount = activeRunCount;
}
