function buildCommand(command, description) {
  return { command, description };
}

const SPIKE_GROUP_COMMANDS = {
  eng: [
    buildCommand("help", "Show the quick help card"),
    buildCommand("guide", "Send the beginner PDF guidebook"),
    buildCommand("clear", "Clear General and keep only the active menu"),
    buildCommand("new", "Create a new work topic"),
    buildCommand("zoo", "Open the dedicated Zoo topic"),
    buildCommand("status", "Show session and runtime status"),
    buildCommand("limits", "Show the current Codex rate limits"),
    buildCommand("global", "Open the General-topic global settings menu"),
    buildCommand("menu", "Open the topic-local settings menu"),
    buildCommand("language", "Show or change the UI language"),
    buildCommand("q", "Queue the next Spike prompt"),
    buildCommand("wait", "Manage the manual prompt buffer"),
    buildCommand("suffix", "Show or change prompt suffixes"),
    buildCommand("model", "Set or inspect the Spike model"),
    buildCommand("reasoning", "Set or inspect Spike reasoning"),
    buildCommand("interrupt", "Stop the active run"),
    buildCommand("diff", "Send the current workspace diff"),
    buildCommand("compact", "Rebuild the session brief"),
    buildCommand("purge", "Reset local session state"),
  ],
  rus: [
    buildCommand("help", "Показать краткую шпаргалку"),
    buildCommand("guide", "Отправить PDF-гайдбук для новичка"),
    buildCommand("clear", "Очистить General и оставить только active menu"),
    buildCommand("new", "Создать новую рабочую тему"),
    buildCommand("zoo", "Открыть отдельный Zoo topic"),
    buildCommand("status", "Показать статус сессии и рантайма"),
    buildCommand("limits", "Показать текущие лимиты Codex"),
    buildCommand("global", "Открыть Global settings menu в General"),
    buildCommand("menu", "Открыть menu локальных настроек топика"),
    buildCommand("language", "Показать или сменить язык"),
    buildCommand("q", "Поставить следующий Spike prompt в очередь"),
    buildCommand("wait", "Управлять manual prompt buffer"),
    buildCommand("suffix", "Показать или сменить prompt suffix"),
    buildCommand("model", "Spike model для топика или global"),
    buildCommand("reasoning", "Spike reasoning для топика или global"),
    buildCommand("interrupt", "Остановить active run"),
    buildCommand("diff", "Отправить diff текущего workspace"),
    buildCommand("compact", "Пересобрать brief этой сессии"),
    buildCommand("purge", "Сбросить local session state"),
  ],
};

const SPIKE_PRIVATE_COMMANDS = {
  eng: [
    buildCommand("help", "Show the private-lane help"),
    buildCommand("status", "Show emergency lane status"),
    buildCommand("interrupt", "Stop the emergency run"),
  ],
  rus: [
    buildCommand("help", "Показать помощь по private lane"),
    buildCommand("status", "Показать статус emergency lane"),
    buildCommand("interrupt", "Остановить emergency run"),
  ],
};

const OMNI_GROUP_COMMANDS = {
  eng: [
    buildCommand("auto", "Arm, inspect, or stop Omni auto mode"),
    buildCommand("omni", "Ask Omni about the current auto state"),
  ],
  rus: [
    buildCommand("auto", "Включить, проверить или выключить /auto"),
    buildCommand("omni", "Спросить Omni про текущий auto state"),
  ],
};

const SPIKE_OMNI_COMMANDS = {
  eng: [
    buildCommand("auto", "Omni auto mode for this topic"),
    buildCommand("omni", "Ask Omni about the current auto state"),
    buildCommand("omni_model", "Set or inspect the Omni model"),
    buildCommand("omni_reasoning", "Set or inspect Omni reasoning"),
  ],
  rus: [
    buildCommand("auto", "Режим Omni /auto для этого топика"),
    buildCommand("omni", "Спросить Omni про текущий auto state"),
    buildCommand("omni_model", "Omni model для топика или global"),
    buildCommand("omni_reasoning", "Omni reasoning для топика или global"),
  ],
};

function buildLocalizedEntries(scope, localizedCommands) {
  return [
    {
      scope,
      commands: localizedCommands.eng,
      languageCode: null,
    },
    {
      scope,
      commands: localizedCommands.rus,
      languageCode: "ru",
    },
  ];
}

function buildLocalizedScopeEntries(scopes) {
  return scopes.flatMap((scope) => [
    {
      scope,
      languageCode: null,
    },
    {
      scope,
      languageCode: "ru",
    },
  ]);
}

function buildTelegramCommandClearPlan(kind, forumChatId) {
  const normalizedForumChatId = String(forumChatId || "").trim();
  if (!normalizedForumChatId) {
    throw new Error("buildTelegramCommandClearPlan requires forumChatId");
  }

  if (kind === "omni") {
    return buildLocalizedScopeEntries([
      { type: "all_group_chats" },
      { type: "chat", chat_id: normalizedForumChatId },
    ]);
  }

  if (kind === "spike") {
    return buildLocalizedScopeEntries([
      { type: "default" },
      { type: "all_group_chats" },
      { type: "chat", chat_id: normalizedForumChatId },
      { type: "all_private_chats" },
    ]);
  }

  throw new Error(`Unsupported Telegram command catalog kind: ${kind}`);
}

export function buildTelegramCommandSyncPlan(
  kind,
  forumChatId,
  { omniEnabled = true } = {},
) {
  const normalizedForumChatId = String(forumChatId || "").trim();
  if (!normalizedForumChatId) {
    throw new Error("buildTelegramCommandSyncPlan requires forumChatId");
  }

  if (kind === "spike") {
    const spikeGroupCommands = {
      eng: [
        ...SPIKE_GROUP_COMMANDS.eng,
        ...(omniEnabled ? SPIKE_OMNI_COMMANDS.eng : []),
      ],
      rus: [
        ...SPIKE_GROUP_COMMANDS.rus,
        ...(omniEnabled ? SPIKE_OMNI_COMMANDS.rus : []),
      ],
    };
    return [
      ...buildLocalizedEntries({ type: "default" }, spikeGroupCommands),
      ...buildLocalizedEntries({ type: "all_group_chats" }, spikeGroupCommands),
      ...buildLocalizedEntries(
        { type: "chat", chat_id: normalizedForumChatId },
        spikeGroupCommands,
      ),
      ...buildLocalizedEntries(
        { type: "all_private_chats" },
        SPIKE_PRIVATE_COMMANDS,
      ),
    ];
  }

  if (kind === "omni") {
    if (!omniEnabled) {
      return [];
    }
    return [
      ...buildLocalizedEntries({ type: "all_group_chats" }, OMNI_GROUP_COMMANDS),
      ...buildLocalizedEntries(
        { type: "chat", chat_id: normalizedForumChatId },
        OMNI_GROUP_COMMANDS,
      ),
    ];
  }

  throw new Error(`Unsupported Telegram command catalog kind: ${kind}`);
}

export async function syncTelegramCommandCatalog(
  api,
  kind,
  forumChatId,
  options = {},
) {
  const plan = buildTelegramCommandSyncPlan(kind, forumChatId, options);
  if (plan.length === 0) {
    const clearPlan = buildTelegramCommandClearPlan(kind, forumChatId);
    for (const entry of clearPlan) {
      const params = {
        scope: entry.scope,
      };
      if (entry.languageCode) {
        params.language_code = entry.languageCode;
      }
      await api.deleteMyCommands(params);
    }
    return plan;
  }

  for (const entry of plan) {
    const params = {
      commands: entry.commands,
      scope: entry.scope,
    };
    if (entry.languageCode) {
      params.language_code = entry.languageCode;
    }
    await api.setMyCommands(params);
  }

  return plan;
}
