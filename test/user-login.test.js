import test from "node:test";
import assert from "node:assert/strict";

import { authorizeTelegramUser } from "../src/cli/user-login.js";

test("authorizeTelegramUser retries an invalid phone code and then signs in", async () => {
  const prompts = ["11111", "22222"];
  const errors = [];
  const infos = [];
  let invokeCount = 0;

  const user = await authorizeTelegramUser({
    client: {
      async connect() {},
      async checkAuthorization() {
        return false;
      },
      async sendCode() {
        return {
          phoneCodeHash: "hash-1",
          isCodeViaApp: true,
        };
      },
      async invoke(request) {
        invokeCount += 1;
        assert.equal(request.phoneCodeHash, "hash-1");
        if (invokeCount === 1) {
          throw {
            errorMessage: "PHONE_CODE_INVALID",
          };
        }
        assert.equal(request.phoneCode, "22222");
        return {
          user: {
            id: 1,
            username: "tester",
          },
        };
      },
    },
    apiId: 123,
    apiHash: "hash",
    phoneNumber: "+123456789",
    promptTextImpl: async () => prompts.shift() || "",
    logError: (message) => errors.push(message),
    logInfo: (message) => infos.push(message),
  });

  assert.equal(user.username, "tester");
  assert.equal(invokeCount, 2);
  assert.deepEqual(errors, [
    "Telegram user login failed: invalid code, try again.",
  ]);
  assert.deepEqual(infos, [
    "Telegram login code sent to the Telegram app.",
  ]);
});

test("authorizeTelegramUser delegates to 2FA password auth when Telegram requires it", async () => {
  const infos = [];
  const errors = [];
  const passwordPrompts = [];

  const user = await authorizeTelegramUser({
    client: {
      async connect() {},
      async checkAuthorization() {
        return false;
      },
      async sendCode() {
        return {
          phoneCodeHash: "hash-2",
          isCodeViaApp: false,
        };
      },
      async invoke() {
        throw {
          errorMessage: "SESSION_PASSWORD_NEEDED",
        };
      },
      async signInWithPassword(_apiCredentials, authParams) {
        const password = await authParams.password("hint-2fa");
        assert.equal(password, "secret-password");
        return {
          id: 2,
          username: "twofa-user",
        };
      },
    },
    apiId: 321,
    apiHash: "hash-2fa",
    phoneNumber: "+1987654321",
    promptTextImpl: async () => "99999",
    promptPasswordImpl: async (prompt) => {
      passwordPrompts.push(prompt);
      return "secret-password";
    },
    logError: (message) => errors.push(message),
    logInfo: (message) => infos.push(message),
  });

  assert.equal(user.username, "twofa-user");
  assert.deepEqual(passwordPrompts, [
    "Telegram 2FA password (hint-2fa): ",
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(infos, [
    "Telegram login code sent via Telegram app/SMS.",
    "Telegram account requires 2FA password.",
  ]);
});
