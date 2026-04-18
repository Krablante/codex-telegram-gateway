import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GeneralMessageLedgerStore } from "../src/session-manager/general-message-ledger-store.js";

test("GeneralMessageLedgerStore serializes overlapping track and forget calls", async () => {
  const settingsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-general-ledger-"),
  );
  const store = new GeneralMessageLedgerStore(settingsRoot);
  await store.save({
    schema_version: 1,
    tracked_message_ids: [1, 2],
  });

  await Promise.all([
    store.trackMessageId(3),
    store.forgetMessageIds([1]),
    store.trackMessageId(4),
  ]);

  const reloaded = await store.load({ force: true });
  assert.deepEqual(reloaded.tracked_message_ids, [2, 3, 4]);
});
