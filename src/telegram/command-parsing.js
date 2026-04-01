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

export function isAuthorizedMessage(message, config) {
  if (!message?.from || message.from.is_bot) {
    return false;
  }

  return (
    String(message.from.id) === config.telegramAllowedUserId &&
    String(message.chat?.id) === config.telegramForumChatId
  );
}

export function extractBotCommand(message, botUsername) {
  const text = String(message?.text ?? message?.caption ?? "");
  if (!text.trim()) {
    return null;
  }

  const entities = Array.isArray(message.entities)
    ? message.entities
    : Array.isArray(message.caption_entities)
      ? message.caption_entities
      : null;

  if (!entities) {
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

  const commandEntity = entities.find(
    (entity) => entity.type === "bot_command" && entity.offset === 0,
  );
  if (!commandEntity) {
    return null;
  }

  const rawCommand = text.slice(0, commandEntity.length);
  if (!rawCommand.startsWith("/")) {
    return null;
  }

  const [commandName, commandTarget] = rawCommand.slice(1).split("@");
  if (
    commandTarget &&
    botUsername &&
    commandTarget.toLowerCase() !== botUsername.toLowerCase()
  ) {
    return null;
  }

  return {
    name: commandName.toLowerCase(),
    raw: rawCommand,
    args: text.slice(commandEntity.length).trim(),
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

  const tokens = trimmed.split(/\s+/u);
  const firstToken = tokens[0];
  const prefixes = ["cwd=", "path=", "--cwd=", "--path="];
  const matchedPrefix = prefixes.find((prefix) => firstToken.startsWith(prefix));
  if (!matchedPrefix) {
    return {
      bindingPath: null,
      title: trimmed,
    };
  }

  const bindingPath = firstToken.slice(matchedPrefix.length).trim();
  return {
    bindingPath: bindingPath || null,
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

export function parseWaitCommandArgs(rawArgs) {
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return {
      action: "show",
      delayMs: null,
      seconds: null,
    };
  }

  const lowered = trimmed.toLowerCase();
  if (
    lowered === "off" ||
    lowered === "cancel" ||
    lowered === "clear" ||
    lowered === "stop"
  ) {
    return {
      action: "off",
      delayMs: null,
      seconds: null,
    };
  }

  const match = trimmed.match(/^(\d+)\s*([sm]?)$/iu);
  if (!match) {
    return {
      action: "invalid",
      delayMs: null,
      seconds: null,
      raw: trimmed,
    };
  }

  const value = Number(match[1]);
  if (!Number.isInteger(value) || value <= 0) {
    return {
      action: "invalid",
      delayMs: null,
      seconds: null,
      raw: trimmed,
    };
  }

  const unit = (match[2] || "s").toLowerCase();
  const seconds = unit === "m" ? value * 60 : value;
  if (seconds > MAX_WAIT_WINDOW_SECS) {
    return {
      action: "invalid",
      delayMs: null,
      seconds: null,
      raw: trimmed,
    };
  }

  return {
    action: "set",
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

export function buildReplyMessageParams(message, text) {
  const params = {
    chat_id: message.chat.id,
    text,
  };

  if (isNumericMessageThreadId(message.message_thread_id)) {
    params.message_thread_id = message.message_thread_id;
  }

  return params;
}
