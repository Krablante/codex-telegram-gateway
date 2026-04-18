import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ingestIncomingAttachments } from "../src/telegram/incoming-attachments.js";

test("ingestIncomingAttachments keeps stored relative paths in slash form and sanitizes Windows reserved file names", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-incoming-"),
  );
  const session = {
    chat_id: "-1003577434463",
    topic_id: "2203",
    ui_language: "eng",
  };
  const sessionStore = {
    getSessionDir(chatId, topicId) {
      return path.join(sessionsRoot, String(chatId), String(topicId));
    },
  };
  const api = {
    async getFile() {
      return { file_path: "documents/con.txt" };
    },
    async downloadFile(_telegramPath, targetPath) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, "payload", "utf8");
    },
  };

  try {
    const descriptors = await ingestIncomingAttachments({
      api,
      message: {
        message_id: 44,
        document: {
          file_id: "doc-1",
          file_unique_id: "doc-1",
          file_name: "con.txt ",
          mime_type: "text/plain",
          file_size: 7,
        },
      },
      session,
      sessionStore,
    });

    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0].file_name.endsWith("-file.txt"), true);
    assert.match(descriptors[0].relative_path, /^incoming\//u);
    assert.doesNotMatch(descriptors[0].relative_path, /\\/u);
  } finally {
    await fs.rm(sessionsRoot, { recursive: true, force: true });
  }
});
