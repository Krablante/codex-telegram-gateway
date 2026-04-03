import test from "node:test";
import assert from "node:assert/strict";

import { TelegramBotApiClient } from "../src/telegram/bot-api-client.js";

test("TelegramBotApiClient formats sendMessage text as Telegram HTML", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    calls.push({
      method: options.method,
      headers: options.headers,
      body: options.body ? JSON.parse(options.body) : null,
    });
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: {
            message_id: 1,
          },
        };
      },
    };
  };

  try {
    const client = new TelegramBotApiClient({ token: "TOKEN" });
    await client.sendMessage({
      chat_id: 1,
      text: "Создан [`test.js`](/tmp/test.js) и **готово**.",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.parse_mode, "HTML");
  assert.equal(
    calls[0].body.text,
    "Создан <code>test.js</code> и <b>готово</b>.",
  );
});

test("TelegramBotApiClient formats editMessageText text as Telegram HTML", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    calls.push(JSON.parse(options.body));
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: {
            message_id: 2,
          },
        };
      },
    };
  };

  try {
    const client = new TelegramBotApiClient({ token: "TOKEN" });
    await client.editMessageText({
      chat_id: 1,
      message_id: 2,
      text: "# Title\n\n[docs](https://example.com)",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].parse_mode, "HTML");
  assert.equal(
    calls[0].text,
    '<b>Title</b>\n\n<a href="https://example.com">docs</a>',
  );
});
