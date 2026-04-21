import { parseUiLanguage } from "../i18n/ui-language.js";

const MAX_WAIT_WINDOW_SECS = 3600;

function isNumericMessageThreadId(value) {
  return typeof value === "number" && Number.isInteger(value);
}

export function getTopicLabel(message) {
  return isNumericMessageThreadId(message?.message_thread_id)
    ? String(message.message_thread_id)
    : "general";
}

function includesId(list, value) {
  const normalized = String(value ?? "").trim();
  return Array.isArray(list) && normalized
    ? list.map((entry) => String(entry ?? "").trim()).includes(normalized)
    : false;
}

export function isAuthorizedForumMessageFromHuman(message, config) {
  if (!message?.from || message.from.is_bot) {
    return false;
  }

  return (
    includesId(config.telegramAllowedUserIds, message.from.id)
    || String(message.from.id) === String(config.telegramAllowedUserId)
  ) && String(message.chat?.id) === config.telegramForumChatId;
}

export function isAuthorizedForumMessageFromBot(message, config) {
  if (!message?.from || !message.from.is_bot) {
    return false;
  }

  return (
    includesId(config.telegramAllowedBotIds, message.from.id)
    && String(message.chat?.id) === config.telegramForumChatId
  );
}

export function isAuthorizedMessage(message, config) {
  if (!message?.from) {
    return false;
  }

  return message.from.is_bot
    ? isAuthorizedForumMessageFromBot(message, config)
    : isAuthorizedForumMessageFromHuman(message, config);
}

function extractLeadingBotCommand(message) {
  const text = String(message?.text ?? message?.caption ?? "");
  if (!text.trim()) {
    return null;
  }

  const commandMatch = text.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?=\s|$)/u);

  const entities = Array.isArray(message.entities)
    ? message.entities
    : Array.isArray(message.caption_entities)
      ? message.caption_entities
      : null;

  if (!commandMatch) {
    const bareWaitMatch = text.trim().match(/^wait(?:\s+(.+))?$/iu);
    if (!bareWaitMatch) {
      return null;
    }

    const args = (bareWaitMatch[1] || "").trim();
    if (parseWaitCommandArgs(args).action === "invalid") {
      return null;
    }

    return {
      name: "wait",
      raw: "wait",
      args,
    };
  }

  if (!entities) {
    const rawCommand = commandMatch[0];
    return {
      name: commandMatch[1].toLowerCase(),
      raw: rawCommand,
      args: text.slice(rawCommand.length).trim(),
      target: commandMatch[2] ? commandMatch[2].toLowerCase() : null,
    };
  }

  const commandEntity = entities.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  if (!commandEntity && !commandMatch) {
    return null;
  }

  if (!commandMatch) {
    return null;
  }

  const rawCommand = commandMatch[0];
  return {
    name: commandMatch[1].toLowerCase(),
    raw: rawCommand,
    args: text.slice(rawCommand.length).trim(),
    target: commandMatch[2] ? commandMatch[2].toLowerCase() : null,
  };
}

export function isForeignBotCommand(message, botUsername) {
  const command = extractLeadingBotCommand(message);
  if (!command?.target || !botUsername) {
    return false;
  }

  return command.target !== botUsername.toLowerCase();
}

export function extractBotCommand(message, botUsername) {
  const directCommand = extractLeadingBotCommand(message);
  if (
    directCommand?.target &&
    botUsername &&
    directCommand.target !== botUsername.toLowerCase()
  ) {
    return null;
  }

  if (!directCommand) {
    return null;
  }

  return {
    name: directCommand.name,
    raw: directCommand.raw,
    args: directCommand.args,
  };
}

function parseLeadingQuotedValue(text) {
  if (!text || (text[0] !== "\"" && text[0] !== "'")) {
    return null;
  }

  const quote = text[0];
  let value = "";

  for (let index = 1; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\\" && (next === quote || next === "\\")) {
      value += next;
      index += 1;
      continue;
    }

    if (char === quote) {
      return {
        value,
        rest: text.slice(index + 1).trim(),
      };
    }

    value += char;
  }

  return {
    value,
    rest: "",
  };
}

export function parseNewTopicCommandArgs(rawArgs) {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return {
      bindingPath: null,
      title: "",
    };
  }

  const prefixes = ["cwd=", "path=", "--cwd=", "--path="];
  const matchedPrefix = prefixes.find((prefix) => trimmed.startsWith(prefix));
  if (!matchedPrefix) {
    return {
      bindingPath: null,
      title: trimmed,
    };
  }

  const remainder = trimmed.slice(matchedPrefix.length).trimStart();
  if (!remainder) {
    return {
      bindingPath: null,
      title: "",
    };
  }

  const quoted = parseLeadingQuotedValue(remainder);
  if (quoted) {
    return {
      bindingPath: quoted.value.trim() || null,
      title: quoted.rest,
    };
  }

  const tokens = remainder.split(/\s+/u);
  const bindingPath = tokens[0]?.trim() || null;
  return {
    bindingPath,
    title: tokens.slice(1).join(" ").trim(),
  };
}

export function parsePromptSuffixCommandArgs(rawArgs) {
  const trimmed = rawArgs.trim();
  if (!trimmed || trimmed === "") {
    return {
      scope: "topic",
      action: "show",
      text: null,
    };
  }

  if (trimmed.toLowerCase() == "help") {
    return {
      scope: "help",
      action: "show",
      text: null,
    };
  }

  let scope = "topic";
  let scopeArgs = trimmed;

  if (/^global(?:\s+|$)/iu.test(trimmed)) {
    scope = "global";
    scopeArgs = trimmed.slice("global".length).trim();
  } else if (/^topic(?:\s+|$)/iu.test(trimmed)) {
    scope = "topic-control";
    scopeArgs = trimmed.slice("topic".length).trim();
  }

  if (!scopeArgs) {
    return {
      scope,
      action: "show",
      text: null,
    };
  }

  const lowered = scopeArgs.toLowerCase();
  if (scope === "topic-control") {
    if (lowered === "on" || lowered === "off") {
      return {
        scope,
        action: lowered,
        text: null,
      };
    }

    return {
      scope,
      action: "invalid",
      text: scopeArgs,
    };
  }

  if (lowered === "on" || lowered === "off" || lowered === "clear") {
    return {
      scope,
      action: lowered,
      text: null,
    };
  }

  return {
    scope,
    action: "set",
    text: scopeArgs,
  };
}

export function parseQueueCommandArgs(rawArgs) {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return {
      action: "enqueue",
      text: null,
      position: null,
    };
  }

  if (/^status$/iu.test(trimmed)) {
    return {
      action: "status",
      text: null,
      position: null,
    };
  }

  const deleteMatch = trimmed.match(/^delete\s+(\d+)$/iu);
  if (deleteMatch) {
    return {
      action: "delete",
      text: null,
      position: Number.parseInt(deleteMatch[1], 10),
    };
  }

  return {
    action: "enqueue",
    text: trimmed,
    position: null,
  };
}

export function parseWaitCommandArgs(rawArgs) {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return {
      action: "show",
      scope: "effective",
      delayMs: null,
      seconds: null,
    };
  }

  let scope = "topic";
  let scopeArgs = trimmed;
  if (/^global(?:\s+|$)/iu.test(trimmed)) {
    scope = "global";
    scopeArgs = trimmed.slice("global".length).trim();
  } else if (/^(?:topic|local)(?:\s+|$)/iu.test(trimmed)) {
    scope = "topic";
    const prefix = trimmed.match(/^(topic|local)(?:\s+|$)/iu)?.[1] || "";
    scopeArgs = trimmed.slice(prefix.length).trim();
  }

  if (!scopeArgs) {
    return {
      action: "show",
      scope,
      delayMs: null,
      seconds: null,
    };
  }

  const lowered = scopeArgs.toLowerCase();
  if (
    lowered === "off" ||
    lowered === "cancel" ||
    lowered === "clear" ||
    lowered === "stop"
  ) {
    return {
      action: "off",
      scope,
      delayMs: null,
      seconds: null,
    };
  }

  const match = scopeArgs.match(/^(\d+)\s*([sm]?)$/iu);
  if (!match) {
    return {
      action: "invalid",
      scope,
      delayMs: null,
      seconds: null,
      raw: scopeArgs,
    };
  }

  const value = Number(match[1]);
  if (!Number.isInteger(value) || value <= 0) {
    return {
      action: "invalid",
      scope,
      delayMs: null,
      seconds: null,
      raw: scopeArgs,
    };
  }

  const unit = (match[2] || "s").toLowerCase();
  const seconds = unit === "m" ? value * 60 : value;
  if (seconds > MAX_WAIT_WINDOW_SECS) {
    return {
      action: "invalid",
      scope,
      delayMs: null,
      seconds: null,
      raw: scopeArgs,
    };
  }

  return {
    action: "set",
    scope,
    delayMs: seconds * 1000,
    seconds,
  };
}

export function parseLanguageCommandArgs(rawArgs) {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return {
      action: "show",
      language: null,
      raw: "",
    };
  }

  const language = parseUiLanguage(trimmed);
  if (!language) {
    return {
      action: "invalid",
      language: null,
      raw: trimmed,
    };
  }

  return {
    action: "set",
    language,
    raw: trimmed,
  };
}

export function parseScopedRuntimeSettingCommandArgs(rawArgs) {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return {
      scope: "topic",
      action: "show",
      value: null,
    };
  }

  let scope = "topic";
  let scopeArgs = trimmed;
  if (/^global(?:\s+|$)/iu.test(trimmed)) {
    scope = "global";
    scopeArgs = trimmed.slice("global".length).trim();
  }

  if (!scopeArgs) {
    return {
      scope,
      action: "show",
      value: null,
    };
  }

  const lowered = scopeArgs.toLowerCase();
  if (lowered === "list" || lowered === "ls") {
    return {
      scope,
      action: "list",
      value: null,
    };
  }

  if (lowered === "clear" || lowered === "reset" || lowered === "default") {
    return {
      scope,
      action: "clear",
      value: null,
    };
  }

  return {
    scope,
    action: "set",
    value: scopeArgs,
  };
}

export function buildReplyMessageParams(message, text) {
  const params = {
    chat_id: message.chat.id,
    text,
  };

  if (isNumericMessageThreadId(message.message_thread_id)) {
    params.message_thread_id = message.message_thread_id;
  }
  if (Number.isInteger(message?.message_id) && message.message_id > 0) {
    params.reply_to_message_id = message.message_id;
  }

  return params;
}
