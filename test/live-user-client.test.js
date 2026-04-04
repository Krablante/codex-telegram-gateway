import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ensureTelegramUserBootstrapFiles,
  resolveTelegramUserPaths,
  TELEGRAM_USER_PRIVATE_FILE_MODE,
} from "../src/live-user/config.js";
import { writeTelegramUserSession } from "../src/live-user/client.js";
import { supportsPosixFileModes } from "../src/state/file-utils.js";

async function getFileMode(filePath) {
  return (await fs.stat(filePath)).mode & 0o777;
}

async function assertPrivateFileState(filePath) {
  await fs.access(filePath);
  if (!supportsPosixFileModes()) {
    return;
  }

  assert.equal(
    await getFileMode(filePath),
    TELEGRAM_USER_PRIVATE_FILE_MODE,
  );
}

test("live-user bootstrap hardens env, session, and account files to 0600", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-live-user-"),
  );
  const paths = resolveTelegramUserPaths({ stateRoot });

  await ensureTelegramUserBootstrapFiles(paths);
  await assertPrivateFileState(paths.envFilePath);

  await writeTelegramUserSession(paths, {
    sessionString: "session-value",
    account: {
      id: "1234567890",
      username: "stupidumbidiot",
    },
  });
  await assertPrivateFileState(paths.sessionFilePath);
  await assertPrivateFileState(paths.accountFilePath);
});

test("live-user bootstrap tightens permissions on pre-existing files", async () => {
  const stateRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-telegram-gateway-live-user-existing-"),
  );
  const paths = resolveTelegramUserPaths({ stateRoot });
  await fs.mkdir(paths.liveUserRoot, { recursive: true });
  await fs.writeFile(paths.envFilePath, "TELEGRAM_USER_API_ID=1\n", "utf8");
  await fs.writeFile(paths.sessionFilePath, "session\n", "utf8");
  await fs.writeFile(paths.accountFilePath, "{}\n", "utf8");
  await fs.chmod(paths.envFilePath, 0o664);
  await fs.chmod(paths.sessionFilePath, 0o664);
  await fs.chmod(paths.accountFilePath, 0o664);

  const result = await ensureTelegramUserBootstrapFiles(paths);

  assert.equal(result.envTemplateCreated, false);
  await assertPrivateFileState(paths.envFilePath);
  await assertPrivateFileState(paths.sessionFilePath);
  await assertPrivateFileState(paths.accountFilePath);
});
