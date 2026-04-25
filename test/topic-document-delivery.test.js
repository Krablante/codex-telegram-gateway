import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  TELEGRAM_DOCUMENT_CAPTION_LIMIT_CHARS,
  deliverDocumentToTopic,
} from "../src/transport/topic-document-delivery.js";

test("deliverDocumentToTopic caps outgoing captions to Telegram's document limit", async () => {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-document-"),
  );
  const filePath = path.join(tempDir, "report.txt");
  await fs.writeFile(filePath, "ok\n", "utf8");
  const sends = [];

  try {
    const result = await deliverDocumentToTopic({
      api: {
        async sendDocument(payload) {
          sends.push(payload);
        },
      },
      chatId: -1001234567890,
      messageThreadId: 2203,
      document: {
        filePath,
        fileName: "report.txt",
        caption: "x".repeat(TELEGRAM_DOCUMENT_CAPTION_LIMIT_CHARS + 100),
      },
    });

    assert.equal(result.delivered, true);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].caption.length, TELEGRAM_DOCUMENT_CAPTION_LIMIT_CHARS);
    assert.match(sends[0].caption, /…$/u);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
