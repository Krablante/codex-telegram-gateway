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
    )?.commands.some((command) => command.command === "auto"),
    true,
  );
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

test("buildTelegramCommandSyncPlan omits Omni commands from Spike when Omni is disabled", () => {
  const plan = buildTelegramCommandSyncPlan("spike", "-1001234567890", {
    omniEnabled: false,
  });

  const commands = [
    ...new Set(
      plan.flatMap((entry) => entry.commands.map((command) => command.command)),
    ),
  ];
  assert.equal(commands.includes("auto"), false);
  assert.equal(commands.includes("omni"), false);
  assert.equal(commands.includes("omni_model"), false);
  assert.equal(commands.includes("omni_reasoning"), false);
});

test("buildTelegramCommandSyncPlan includes Omni auto commands for group scopes", () => {
  const plan = buildTelegramCommandSyncPlan("omni", "-1001234567890");

  assert.equal(plan.length, 4);
  assert.deepEqual(
    [...new Set(plan.flatMap((entry) => entry.commands.map((command) => command.command)))],
    ["auto", "omni"],
  );
});

test("buildTelegramCommandSyncPlan returns an empty Omni catalog when Omni is disabled", () => {
  const plan = buildTelegramCommandSyncPlan("omni", "-1001234567890", {
    omniEnabled: false,
  });

  assert.deepEqual(plan, []);
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

test("syncTelegramCommandCatalog clears stale Omni commands when Omni is disabled", async () => {
  const deleted = [];
  const api = {
    async setMyCommands() {
      throw new Error("disabled Omni sync should clear, not set");
    },
    async deleteMyCommands(params) {
      deleted.push(params);
      return true;
    },
  };

  const plan = await syncTelegramCommandCatalog(api, "omni", "-1001234567890", {
    omniEnabled: false,
  });

  assert.deepEqual(plan, []);
  assert.equal(deleted.length, 4);
  assert.deepEqual(
    deleted[0],
    {
      scope: { type: "all_group_chats" },
    },
  );
  assert.deepEqual(
    deleted[1],
    {
      scope: { type: "all_group_chats" },
      language_code: "ru",
    },
  );
});
