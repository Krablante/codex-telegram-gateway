import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTelegramCommandSyncPlan,
  syncTelegramCommandCatalog,
} from "../src/telegram/command-catalog.js";

test("buildTelegramCommandSyncPlan includes full Spike forum/private catalogs", () => {
  const plan = buildTelegramCommandSyncPlan("spike", "-1001234567890");

  assert.equal(plan.length, 8);
  assert.equal(
    plan.find(
      (entry) =>
        entry.scope.type === "chat"
        && entry.scope.chat_id === "-1001234567890"
        && entry.languageCode === null,
    )?.commands.some((command) => command.command === "global"),
    true,
  );
  assert.equal(
    plan.find(
      (entry) =>
        entry.scope.type === "chat"
        && entry.scope.chat_id === "-1001234567890"
        && entry.languageCode === null,
    )?.commands.some((command) => command.command === "menu"),
    true,
  );
  assert.equal(
    plan.find(
      (entry) =>
        entry.scope.type === "chat"
        && entry.scope.chat_id === "-1001234567890"
        && entry.languageCode === null,
    )?.commands.some((command) => command.command === "zoo"),
    true,
  );
  assert.equal(
    plan.find(
      (entry) =>
        entry.scope.type === "chat"
        && entry.scope.chat_id === "-1001234567890"
        && entry.languageCode === null,
    )?.commands.some((command) => command.command === "limits"),
    true,
  );
  assert.deepEqual(
    plan
      .filter((entry) => entry.scope.type === "all_private_chats")
      .map((entry) => entry.commands.map((command) => command.command)),
    [
      ["help", "status", "interrupt"],
      ["help", "status", "interrupt"],
    ],
  );
});

test("buildTelegramCommandSyncPlan does not expose removed legacy commands", () => {
  const plan = buildTelegramCommandSyncPlan("spike", "-1001234567890");

  const commands = [
    ...new Set(
      plan.flatMap((entry) => entry.commands.map((command) => command.command)),
    ),
  ];
  assert.equal(commands.includes("auto"), false);
});

test("buildTelegramCommandSyncPlan rejects unknown catalogs", () => {
  assert.throws(
    () => buildTelegramCommandSyncPlan("legacy", "-1001234567890"),
    /Unsupported Telegram command catalog kind: legacy/u,
  );
});

test("syncTelegramCommandCatalog applies every scoped command list", async () => {
  const calls = [];
  const api = {
    async setMyCommands(params) {
      calls.push(params);
      return true;
    },
  };

  const plan = await syncTelegramCommandCatalog(api, "spike", "-1001234567890");

  assert.equal(calls.length, plan.length);
  assert.deepEqual(
    calls.at(0),
    {
      commands: plan[0].commands,
      scope: plan[0].scope,
    },
  );
  assert.equal(calls.at(1).language_code, "ru");
});

test("syncTelegramCommandCatalog rejects unknown catalogs", async () => {
  const api = {
    async setMyCommands() {
      throw new Error("should not be called");
    },
  };

  await assert.rejects(
    () => syncTelegramCommandCatalog(api, "legacy", "-1001234567890"),
    /Unsupported Telegram command catalog kind: legacy/u,
  );
});
