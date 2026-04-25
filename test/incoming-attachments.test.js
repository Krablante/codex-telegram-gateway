import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ingestIncomingAttachments } from "../src/telegram/incoming-attachments.js";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  supportsPosixFileModes,
} from "../src/state/file-utils.js";

async function getMode(filePath) {
  return (await fs.stat(filePath)).mode & 0o777;
}

test("ingestIncomingAttachments keeps stored relative paths in slash form and sanitizes Windows reserved file names", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-incoming-"),
  );
  const session = {
    chat_id: "-1001234567890",
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
    async downloadFile(_telegramPath, targetPath, options = {}) {
      assert.equal(options.maxBytes, 20 * 1024 * 1024);
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
    if (supportsPosixFileModes()) {
      assert.equal(
        await getMode(path.dirname(descriptors[0].file_path)),
        PRIVATE_DIRECTORY_MODE,
      );
      assert.equal(await getMode(descriptors[0].file_path), PRIVATE_FILE_MODE);
    }
  } finally {
    await fs.rm(sessionsRoot, { recursive: true, force: true });
  }
});

test("ingestIncomingAttachments rejects and removes files that exceed the limit after download", async () => {
  const sessionsRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-incoming-"),
  );
  const session = {
    chat_id: "-1001234567890",
    topic_id: "2204",
    ui_language: "eng",
  };
  const sessionStore = {
    getSessionDir(chatId, topicId) {
      return path.join(sessionsRoot, String(chatId), String(topicId));
    },
  };
  let downloadedPath = null;
  const api = {
    async getFile() {
      return { file_path: "documents/underreported.bin" };
    },
    async downloadFile(_telegramPath, targetPath) {
      downloadedPath = targetPath;
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, "");
      await fs.truncate(targetPath, 20 * 1024 * 1024 + 1);
    },
  };

  try {
    await assert.rejects(
      () => ingestIncomingAttachments({
        api,
        message: {
          message_id: 45,
          document: {
            file_id: "doc-oversized",
            file_unique_id: "doc-oversized",
            file_name: "underreported.bin",
            mime_type: "application/octet-stream",
            file_size: 1,
          },
        },
        session,
        sessionStore,
      }),
      /Attachment is too large/u,
    );
    await assert.rejects(() => fs.stat(downloadedPath), { code: "ENOENT" });
  } finally {
    await fs.rm(sessionsRoot, { recursive: true, force: true });
  }
});
