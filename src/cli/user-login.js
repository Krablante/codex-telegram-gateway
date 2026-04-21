import process from "node:process";
import { pathToFileURL } from "node:url";
import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

import { promptPassword, promptText } from "./interactive-prompts.js";
import { getOperatorCommandHint } from "../runtime/operator-command-hints.js";
import {
  buildTelegramUserAccountSnapshot,
  loadTelegramUserBootstrap,
  readTelegramUserSession,
  writeTelegramUserSession,
} from "../live-user/client.js";

function buildUserLoginRetryHint() {
  return getOperatorCommandHint("user-login") || "make user-login";
}

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function formatTelegramAuthError(error) {
  return normalizeText(error?.errorMessage)
    || normalizeText(error?.message)
    || String(error ?? "Telegram auth failed");
}

function buildPhoneCodePrompt({ isCodeViaApp }) {
  return isCodeViaApp
    ? "Telegram login code from Telegram app: "
    : "Telegram login code from Telegram app/SMS: ";
}

function buildPasswordPrompt(hint) {
  const normalizedHint = normalizeText(hint);
  return normalizedHint
    ? `Telegram 2FA password (${normalizedHint}): `
    : "Telegram 2FA password: ";
}

export async function authorizeTelegramUser({
  client,
  apiId,
  apiHash,
  phoneNumber = null,
  promptTextImpl = promptText,
  promptPasswordImpl = promptPassword,
  logError = (message) => console.error(message),
  logInfo = (message) => console.log(message),
}) {
  const apiCredentials = { apiId, apiHash };
  await client.connect();

  if (await client.checkAuthorization()) {
    return client.getMe();
  }

  const resolvedPhoneNumber =
    normalizeText(phoneNumber)
    || await promptTextImpl("Telegram phone number (+123456789): ");
  if (!resolvedPhoneNumber) {
    throw new Error("Telegram phone number is required.");
  }

  const { phoneCodeHash, isCodeViaApp } = await client.sendCode(
    apiCredentials,
    resolvedPhoneNumber,
  );
  if (!normalizeText(phoneCodeHash)) {
    throw new Error("Telegram did not return a phone code hash.");
  }

  logInfo(
    isCodeViaApp
      ? "Telegram login code sent to the Telegram app."
      : "Telegram login code sent via Telegram app/SMS.",
  );

  while (true) {
    const phoneCode = await promptTextImpl(
      buildPhoneCodePrompt({ isCodeViaApp }),
    );
    if (!phoneCode) {
      logError("Telegram user login failed: code is empty.");
      continue;
    }

    try {
      const result = await client.invoke(new Api.auth.SignIn({
        phoneNumber: resolvedPhoneNumber,
        phoneCodeHash,
        phoneCode,
      }));
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        throw new Error("This phone number is not registered on Telegram.");
      }

      return result.user;
    } catch (error) {
      const errorMessage = formatTelegramAuthError(error);
      if (errorMessage === "SESSION_PASSWORD_NEEDED") {
        logInfo("Telegram account requires 2FA password.");
        return client.signInWithPassword(apiCredentials, {
          password: async (hint) =>
            promptPasswordImpl(buildPasswordPrompt(hint)),
          onError: async (passwordError) => {
            logError(
              `Telegram 2FA login failed: ${formatTelegramAuthError(passwordError)}`,
            );
            return false;
          },
        });
      }

      if (
        errorMessage === "PHONE_CODE_INVALID"
        || errorMessage === "PHONE_CODE_EMPTY"
      ) {
        logError("Telegram user login failed: invalid code, try again.");
        continue;
      }

      if (
        errorMessage === "PHONE_CODE_EXPIRED"
        || errorMessage === "PHONE_CODE_HASH_EMPTY"
      ) {
        throw new Error(
          `Telegram login code expired. Request a new code and rerun ${buildUserLoginRetryHint()}.`,
        );
      }

      throw error;
    }
  }
}

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
        `Fill TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH from https://my.telegram.org/apps, then rerun ${buildUserLoginRetryHint()}.`,
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
        `Fill TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH from https://my.telegram.org/apps, then rerun ${buildUserLoginRetryHint()}.`,
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
    const me = await authorizeTelegramUser({
      client,
      apiId: userConfig.apiId,
      apiHash: userConfig.apiHash,
      phoneNumber: userConfig.phoneNumber,
    });
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

const isDirectRun =
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
