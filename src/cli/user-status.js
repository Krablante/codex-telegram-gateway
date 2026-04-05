import process from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import { getOperatorCommandHint } from "../runtime/operator-command-hints.js";
import {
  buildTelegramUserAccountSnapshot,
  loadTelegramUserBootstrap,
  readTelegramUserSession,
} from "../live-user/client.js";

function buildUserLoginHint() {
  return getOperatorCommandHint("user-login") || "make user-login";
}

async function main() {
  const bootstrap = await loadTelegramUserBootstrap();
  if (bootstrap.envTemplateCreated) {
    console.error(
      `Missing Telegram user bootstrap config. Fill ${bootstrap.paths.envFilePath} first.`,
    );
    process.exitCode = 1;
    return;
  }
  if (bootstrap.userConfigError || !bootstrap.userConfig) {
    console.error(
      bootstrap.userConfigError?.message
      || `Missing Telegram user config in ${bootstrap.paths.envFilePath}.`,
    );
    process.exitCode = 1;
    return;
  }

  const sessionString = await readTelegramUserSession(bootstrap.paths);
  if (!sessionString) {
    console.error(
      `Missing Telegram user session. Run ${buildUserLoginHint()} first. Expected: ${bootstrap.paths.sessionFilePath}`,
    );
    process.exitCode = 1;
    return;
  }

  const client = new TelegramClient(
    new StringSession(sessionString),
    bootstrap.userConfig.apiId,
    bootstrap.userConfig.apiHash,
    {
      connectionRetries: 5,
    },
  );

  try {
    await client.connect();
    if (!await client.checkAuthorization()) {
      throw new Error(
        `Stored Telegram user session is not authorized anymore: ${bootstrap.paths.sessionFilePath}`,
      );
    }

    const me = await client.getMe();
    console.log(JSON.stringify(buildTelegramUserAccountSnapshot(me), null, 2));
    console.log(`session: ${bootstrap.paths.sessionFilePath}`);
    console.log(`env: ${bootstrap.paths.envFilePath}`);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
