import test from "node:test";
import assert from "node:assert/strict";

import {
  TELEGRAM_USER_ACCOUNT_FILE_NAME,
  TELEGRAM_USER_ENV_FILE_NAME,
  TELEGRAM_USER_SESSION_FILE_NAME,
  buildTelegramUserEnvTemplate,
  parseTelegramUserConfig,
  resolveTelegramUserPaths,
} from "../src/live-user/config.js";

test("resolveTelegramUserPaths builds default files under state root", () => {
  const paths = resolveTelegramUserPaths({
    stateRoot: "/tmp/codex-telegram-gateway-state",
  });

  assert.equal(
    paths.envFilePath,
    "/tmp/codex-telegram-gateway-state/live-user-testing/"
      + TELEGRAM_USER_ENV_FILE_NAME,
  );
  assert.equal(
    paths.sessionFilePath,
    "/tmp/codex-telegram-gateway-state/live-user-testing/"
      + TELEGRAM_USER_SESSION_FILE_NAME,
  );
  assert.equal(
    paths.accountFilePath,
    "/tmp/codex-telegram-gateway-state/live-user-testing/"
      + TELEGRAM_USER_ACCOUNT_FILE_NAME,
  );
});

test("buildTelegramUserEnvTemplate points operators at the state-only bootstrap files", () => {
  const paths = resolveTelegramUserPaths({
    stateRoot: "/tmp/codex-telegram-gateway-state",
  });
  const text = buildTelegramUserEnvTemplate(paths);

  assert.match(text, /my\.telegram\.org\/apps/u);
  assert.match(text, /TELEGRAM_USER_API_ID=/u);
  assert.match(text, /TELEGRAM_USER_API_HASH=/u);
  assert.match(text, new RegExp(paths.sessionFilePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

test("parseTelegramUserConfig validates api credentials and keeps optional phone", () => {
  const paths = resolveTelegramUserPaths({
    stateRoot: "/tmp/codex-telegram-gateway-state",
  });
  const config = parseTelegramUserConfig(
    {
      TELEGRAM_USER_API_ID: "123456",
      TELEGRAM_USER_API_HASH: "abcdef123456",
      TELEGRAM_USER_PHONE: "+15551234567",
    },
    paths,
  );

  assert.equal(config.apiId, 123456);
  assert.equal(config.apiHash, "abcdef123456");
  assert.equal(config.phoneNumber, "+15551234567");
});

test("parseTelegramUserConfig rejects missing api hash", () => {
  const paths = resolveTelegramUserPaths({
    stateRoot: "/tmp/codex-telegram-gateway-state",
  });

  assert.throws(
    () => parseTelegramUserConfig(
      {
        TELEGRAM_USER_API_ID: "123456",
      },
      paths,
    ),
    /TELEGRAM_USER_API_HASH/u,
  );
});
