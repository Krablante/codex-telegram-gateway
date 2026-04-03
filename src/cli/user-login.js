import input from "input";
import process from "node:process";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import {
  buildTelegramUserAccountSnapshot,
  loadTelegramUserBootstrap,
  readTelegramUserSession,
  writeTelegramUserSession,
} from "../live-user/client.js";

async function main() {
  let bootstrap;
  try {
    bootstrap = await loadTelegramUserBootstrap();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (bootstrap.envTemplateCreated) {
    console.error(
      [
        `Created ${bootstrap.paths.envFilePath}.`,
        "Fill TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH from https://my.telegram.org/apps, then rerun make user-login.",
      ].join(" "),
    );
    process.exitCode = 1;
    return;
  }
  if (bootstrap.userConfigError || !bootstrap.userConfig) {
    console.error(
      [
        bootstrap.userConfigError?.message
          || `Missing Telegram user config in ${bootstrap.paths.envFilePath}.`,
        "Fill TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH from https://my.telegram.org/apps, then rerun make user-login.",
      ].join(" "),
    );
    process.exitCode = 1;
    return;
  }

  const { userConfig, paths } = bootstrap;
  const sessionString = await readTelegramUserSession(paths);
  const client = new TelegramClient(
    new StringSession(sessionString),
    userConfig.apiId,
    userConfig.apiHash,
    {
      connectionRetries: 5,
    },
  );

  try {
    await client.start({
      phoneNumber: async () =>
        userConfig.phoneNumber
        || input.text("Telegram phone number (+123456789):"),
      phoneCode: async () =>
        input.text("Telegram login code from Telegram app/SMS:"),
      password: async () =>
        input.password("Telegram 2FA password:"),
      onError: (error) => {
        console.error(`Telegram user login failed: ${error.message}`);
      },
    });

    const me = await client.getMe();
    await writeTelegramUserSession(paths, {
      sessionString: client.session.save(),
      account: buildTelegramUserAccountSnapshot(me),
    });

    console.log("Telegram user session saved.");
    console.log(`env: ${paths.envFilePath}`);
    console.log(`session: ${paths.sessionFilePath}`);
    console.log(`account: ${paths.accountFilePath}`);
    console.log(
      `authorized as @${me?.username || "no-username"} (${me?.id || "unknown-id"})`,
    );
  } finally {
    await client.disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
