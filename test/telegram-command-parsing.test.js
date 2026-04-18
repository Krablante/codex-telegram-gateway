import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReplyMessageParams,
  extractBotCommand,
  getTopicLabel,
  isAuthorizedMessage,
  parseLanguageCommandArgs,
  parseNewTopicCommandArgs,
  parsePromptSuffixCommandArgs,
  parseQueueCommandArgs,
  parseScopedRuntimeSettingCommandArgs,
  parseWaitCommandArgs,
} from "../src/telegram/command-parsing.js";

const config = {
  telegramAllowedUserId: "5825672398",
  telegramAllowedUserIds: ["5825672398"],
  telegramAllowedBotIds: ["8603043042"],
  telegramForumChatId: "-1003577434463",
};

test("extractBotCommand parses direct commands and bot username suffix", () => {
  const rawCommand = "/status@jvan34fsdfbifbiwnoi4bot";
  const message = {
    text: `${rawCommand} now`,
    entities: [{ type: "bot_command", offset: 0, length: rawCommand.length }],
  };

  const command = extractBotCommand(message, "jvan34fsdfbifbiwnoi4bot");
  assert.equal(command.name, "status");
  assert.equal(command.args, "now");
});

test("extractBotCommand still parses @bot commands when Telegram only marks the slash token as bot_command", () => {
  const message = {
    text: "/menu@gatewaybot",
    entities: [{ type: "bot_command", offset: 0, length: 5 }],
  };

  const command = extractBotCommand(message, "gatewaybot");
  assert.equal(command.name, "menu");
  assert.equal(command.raw, "/menu@gatewaybot");
  assert.equal(command.args, "");
});

test("extractBotCommand parses @bot commands even when Telegram omits command entities", () => {
  const message = {
    text: "/menu@gatewaybot",
  };

  const command = extractBotCommand(message, "gatewaybot");
  assert.equal(command.name, "menu");
  assert.equal(command.raw, "/menu@gatewaybot");
  assert.equal(command.args, "");
});

test("extractBotCommand also parses commands from caption entities", () => {
  const message = {
    caption: "/interrupt now",
    caption_entities: [{ type: "bot_command", offset: 0, length: 10 }],
  };

  const command = extractBotCommand(message, "gatewaybot");
  assert.equal(command.name, "interrupt");
  assert.equal(command.args, "now");
});

test("extractBotCommand accepts bare wait commands when args are valid", () => {
  assert.deepEqual(
    extractBotCommand(
      {
        text: "wait 600",
      },
      "gatewaybot",
    ),
    {
      name: "wait",
      raw: "wait",
      args: "600",
    },
  );
  assert.equal(
    extractBotCommand(
      {
        text: "wait why is this broken",
      },
      "gatewaybot",
    ),
    null,
  );
});

test("parseQueueCommandArgs distinguishes queue actions from prompt text", () => {
  assert.deepEqual(parseQueueCommandArgs("status"), {
    action: "status",
    text: null,
    position: null,
  });
  assert.deepEqual(parseQueueCommandArgs("delete 2"), {
    action: "delete",
    text: null,
    position: 2,
  });
  assert.deepEqual(parseQueueCommandArgs("delete node_modules and retry"), {
    action: "enqueue",
    text: "delete node_modules and retry",
    position: null,
  });
});

test("parseNewTopicCommandArgs keeps legacy title mode and supports explicit binding path", () => {
  assert.deepEqual(parseNewTopicCommandArgs("Slice 4 test"), {
    bindingPath: null,
    title: "Slice 4 test",
  });
  assert.deepEqual(
    parseNewTopicCommandArgs("cwd=/home/bloob/atlas Gateway topic"),
    {
      bindingPath: "/home/bloob/atlas",
      title: "Gateway topic",
    },
  );
  assert.deepEqual(
    parseNewTopicCommandArgs("--cwd=homelab/infra/automation/codex-telegram-gateway"),
    {
      bindingPath: "homelab/infra/automation/codex-telegram-gateway",
      title: "",
    },
  );
  assert.deepEqual(
    parseNewTopicCommandArgs('cwd="C:/Users/Konstantin/Source Repos" Windows topic'),
    {
      bindingPath: "C:/Users/Konstantin/Source Repos",
      title: "Windows topic",
    },
  );
});

test("parsePromptSuffixCommandArgs supports show, toggle, and set modes", () => {
  assert.deepEqual(parsePromptSuffixCommandArgs(""), {
    scope: "topic",
    action: "show",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("on"), {
    scope: "topic",
    action: "on",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("off"), {
    scope: "topic",
    action: "off",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("clear"), {
    scope: "topic",
    action: "clear",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("P.S.\nKeep it short."), {
    scope: "topic",
    action: "set",
    text: "P.S.\nKeep it short.",
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("global"), {
    scope: "global",
    action: "show",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("global on"), {
    scope: "global",
    action: "on",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("global clear"), {
    scope: "global",
    action: "clear",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("global P.S.\nKeep it short."), {
    scope: "global",
    action: "set",
    text: "P.S.\nKeep it short.",
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("topic"), {
    scope: "topic-control",
    action: "show",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("topic off"), {
    scope: "topic-control",
    action: "off",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("topic on"), {
    scope: "topic-control",
    action: "on",
    text: null,
  });
  assert.deepEqual(parsePromptSuffixCommandArgs("help"), {
    scope: "help",
    action: "show",
    text: null,
  });
});

test("parseWaitCommandArgs supports local and global wait scopes", () => {
  assert.deepEqual(parseWaitCommandArgs(""), {
    action: "show",
    scope: "effective",
    delayMs: null,
    seconds: null,
  });
  assert.deepEqual(parseWaitCommandArgs("off"), {
    action: "off",
    scope: "topic",
    delayMs: null,
    seconds: null,
  });
  assert.deepEqual(parseWaitCommandArgs("60"), {
    action: "set",
    scope: "topic",
    delayMs: 60000,
    seconds: 60,
  });
  assert.deepEqual(parseWaitCommandArgs("1m"), {
    action: "set",
    scope: "topic",
    delayMs: 60000,
    seconds: 60,
  });
  assert.deepEqual(parseWaitCommandArgs("90s"), {
    action: "set",
    scope: "topic",
    delayMs: 90000,
    seconds: 90,
  });
  assert.deepEqual(parseWaitCommandArgs("global"), {
    action: "show",
    scope: "global",
    delayMs: null,
    seconds: null,
  });
  assert.deepEqual(parseWaitCommandArgs("global 60"), {
    action: "set",
    scope: "global",
    delayMs: 60000,
    seconds: 60,
  });
  assert.deepEqual(parseWaitCommandArgs("global off"), {
    action: "off",
    scope: "global",
    delayMs: null,
    seconds: null,
  });
  assert.equal(parseWaitCommandArgs("9999").action, "invalid");
});

test("parseLanguageCommandArgs supports show and ENG/RUS values", () => {
  assert.deepEqual(parseLanguageCommandArgs(""), {
    action: "show",
    language: null,
    raw: "",
  });
  assert.deepEqual(parseLanguageCommandArgs("eng"), {
    action: "set",
    language: "eng",
    raw: "eng",
  });
  assert.deepEqual(parseLanguageCommandArgs("RUS"), {
    action: "set",
    language: "rus",
    raw: "RUS",
  });
  assert.equal(parseLanguageCommandArgs("deu").action, "invalid");
});

test("parseScopedRuntimeSettingCommandArgs supports topic and global modes", () => {
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs(""), {
    scope: "topic",
    action: "show",
    value: null,
  });
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs("list"), {
    scope: "topic",
    action: "list",
    value: null,
  });
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs("clear"), {
    scope: "topic",
    action: "clear",
    value: null,
  });
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs("gpt-5.4-mini"), {
    scope: "topic",
    action: "set",
    value: "gpt-5.4-mini",
  });
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs("global"), {
    scope: "global",
    action: "show",
    value: null,
  });
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs("global list"), {
    scope: "global",
    action: "list",
    value: null,
  });
  assert.deepEqual(parseScopedRuntimeSettingCommandArgs("global xhigh"), {
    scope: "global",
    action: "set",
    value: "xhigh",
  });
});

test("isAuthorizedMessage allows trusted human and trusted bot principals in configured chat", () => {
  const message = {
    from: { id: 5825672398, is_bot: false },
    chat: { id: -1003577434463 },
  };

  assert.equal(isAuthorizedMessage(message, config), true);
  assert.equal(
    isAuthorizedMessage(
      {
        from: { id: 8603043042, is_bot: true },
        chat: { id: -1003577434463 },
      },
      config,
    ),
    true,
  );
  assert.equal(
    isAuthorizedMessage(
      {
        ...message,
        from: { id: 1, is_bot: false },
      },
      config,
    ),
    false,
  );
  assert.equal(
    isAuthorizedMessage(
      {
        from: { id: 999999999, is_bot: true },
        chat: { id: -1003577434463 },
      },
      config,
    ),
    false,
  );
});

test("buildReplyMessageParams keeps topic routing when message_thread_id exists", () => {
  const message = {
    chat: { id: -1003577434463 },
    message_id: 77,
    message_thread_id: 42,
  };

  assert.deepEqual(buildReplyMessageParams(message, "ok"), {
    chat_id: -1003577434463,
    text: "ok",
    message_thread_id: 42,
    reply_to_message_id: 77,
  });
  assert.equal(getTopicLabel(message), "42");
});
