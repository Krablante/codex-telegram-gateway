import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTelegramReply } from "../src/transport/telegram-reply-normalizer.js";

test("normalizeTelegramReply removes inline markdown noise for Telegram chat", () => {
  const source = [
    "Создан [`test.js`](/home/bloob/atlas/test.js).",
    "Проверил `SIGTERM` и `atlas`.",
    "",
    "Смотри [документацию](https://example.com/docs).",
  ].join("\n");

  assert.equal(
    normalizeTelegramReply(source),
    [
      "Создан test.js.",
      "Проверил SIGTERM и atlas.",
      "",
      "Смотри документацию: https://example.com/docs.",
    ].join("\n"),
  );
});

test("normalizeTelegramReply preserves fenced code blocks", () => {
  const source = [
    "Открой [`test.js`](/home/bloob/atlas/test.js).",
    "",
    "```js",
    "console.log(`keep backticks here`);",
    "```",
  ].join("\n");

  assert.equal(
    normalizeTelegramReply(source),
    [
      "Открой test.js.",
      "",
      "```js",
      "console.log(`keep backticks here`);",
      "```",
    ].join("\n"),
  );
});

test("normalizeTelegramReply keeps only file labels for local code references", () => {
  const source = [
    "Смотри [README.md#L5](/home/bloob/atlas/README.md#L5) и [worker-pool.js#L392](/home/bloob/atlas/src/worker-pool.js#L392).",
  ].join("\n");

  assert.equal(
    normalizeTelegramReply(source),
    "Смотри README.md#L5 и worker-pool.js#L392.",
  );
});
