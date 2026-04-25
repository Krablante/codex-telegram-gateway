import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TelegramBotApiClient } from "../src/telegram/bot-api-client.js";
import {
  PRIVATE_FILE_MODE,
  supportsPosixFileModes,
} from "../src/state/file-utils.js";

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

test("TelegramBotApiClient retries retry_after responses inside one sendMessage call", async () => {
  const calls = [];
  let attempt = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    attempt += 1;
    calls.push(JSON.parse(options.body));
    if (attempt === 1) {
      return {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        async json() {
          return {
            ok: false,
            description: "Too Many Requests: retry after 1",
            parameters: {
              retry_after: 0.001,
            },
          };
        },
      };
    }

    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: {
            message_id: 3,
          },
        };
      },
    };
  };

  try {
    const client = new TelegramBotApiClient({ token: "TOKEN" });
    const result = await client.sendMessage({
      chat_id: 1,
      text: "hello",
    });
    assert.equal(result.message_id, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0].text, "hello");
  assert.deepEqual(calls[0], calls[1]);
});

test("TelegramBotApiClient streams multipart uploads from disk-backed blobs", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-upload-"),
  );
  const filePath = path.join(tempRoot, "report.txt");
  await fs.writeFile(filePath, "report\n", "utf8");
  let capturedBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    capturedBody = options.body;
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          result: {
            message_id: 7,
          },
        };
      },
    };
  };

  try {
    const client = new TelegramBotApiClient({ token: "TOKEN" });
    await client.sendDocument({
      chat_id: 1,
      document: {
        filePath,
        fileName: "report.txt",
        contentType: "text/plain",
      },
    });

    const uploaded = capturedBody.get("document");
    assert.equal(uploaded.name, "report.txt");
    assert.equal(uploaded.type, "text/plain");
    assert.equal(await uploaded.text(), "report\n");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("TelegramBotApiClient fails after exhausting the retry_after budget", async () => {
  let attempts = 0;
  const retryWaits = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      async json() {
        return {
          ok: false,
          description: "Too Many Requests: retry after 10",
          parameters: {
            retry_after: 10,
          },
        };
      },
    };
  };

  try {
    const client = new TelegramBotApiClient({
      token: "TOKEN",
      waitForRetryDelay: async (timeoutMs) => {
        retryWaits.push(timeoutMs);
      },
    });
    await assert.rejects(
      client.sendMessage({
        chat_id: 1,
        text: "hello",
      }),
      /exhausted retry_after budget/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(attempts, 4);
  assert.deepEqual(retryWaits, [10_000, 10_000, 10_000]);
});

test("TelegramBotApiClient streams file downloads with a byte limit", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-download-"),
  );
  const originalFetch = globalThis.fetch;
  const responseBodies = [
    [Buffer.from("pay"), Buffer.from("load")],
    [Buffer.alloc(3), Buffer.alloc(3)],
  ];
  globalThis.fetch = async () => {
    const chunks = responseBodies.shift();
    return {
      ok: true,
      body: {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) {
            yield chunk;
          }
        },
      },
    };
  };

  try {
    const client = new TelegramBotApiClient({ token: "TOKEN" });
    const successPath = path.join(tempRoot, "incoming", "download.txt");
    const result = await client.downloadFile("documents/download.txt", successPath, {
      maxBytes: 7,
    });

    assert.equal(result.sizeBytes, 7);
    assert.equal(await fs.readFile(successPath, "utf8"), "payload");
    if (supportsPosixFileModes()) {
      assert.equal((await fs.stat(successPath)).mode & 0o777, PRIVATE_FILE_MODE);
    }

    const oversizedPath = path.join(tempRoot, "incoming", "oversized.bin");
    await assert.rejects(
      () => client.downloadFile("documents/oversized.bin", oversizedPath, {
        maxBytes: 5,
      }),
      { name: "TelegramFileDownloadTooLargeError" },
    );
    await assert.rejects(() => fs.stat(oversizedPath), { code: "ENOENT" });
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("TelegramBotApiClient refuses to overwrite an existing download path", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-download-existing-"),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async arrayBuffer() {
      return Buffer.from("new payload");
    },
  });

  try {
    const client = new TelegramBotApiClient({ token: "TOKEN" });
    const existingPath = path.join(tempRoot, "incoming", "download.txt");
    await fs.mkdir(path.dirname(existingPath), { recursive: true });
    await fs.writeFile(existingPath, "original", "utf8");

    await assert.rejects(
      () => client.downloadFile("documents/download.txt", existingPath),
      /Refusing to overwrite existing Telegram download path/u,
    );
    assert.equal(await fs.readFile(existingPath, "utf8"), "original");
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("TelegramBotApiClient aborts stalled file downloads with a timeout", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-download-timeout-"),
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(options.signal.reason);
      }, { once: true });
    });

  try {
    const client = new TelegramBotApiClient({ token: "TOKEN" });
    await assert.rejects(
      () => client.downloadFile(
        "documents/never.bin",
        path.join(tempRoot, "never.bin"),
        { timeoutMs: 1 },
      ),
      /Telegram file download timed out/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
