import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSmokeSupported,
  resolveSmokeVariant,
} from "../src/cli/run-smoke-common.js";

test("resolveSmokeVariant detects omni flag", () => {
  assert.equal(resolveSmokeVariant(["node", "run-smoke.js"]), "spike");
  assert.equal(resolveSmokeVariant(["node", "run-smoke.js", "--omni"]), "omni");
});

test("assertSmokeSupported rejects native Windows smoke runs", async () => {
  await assert.rejects(
    () => assertSmokeSupported("codex-telegram-gateway.service", {
      platform: "win32",
      execFileAsync: async () => {},
    }),
    /Linux\/operator-only/u,
  );
});

test("assertSmokeSupported allows inactive Linux user services", async () => {
  await assert.doesNotReject(() => assertSmokeSupported("codex-telegram-gateway.service", {
    platform: "linux",
    execFileAsync: async () => {
      const error = new Error("inactive");
      error.code = 3;
      throw error;
    },
  }));
});

test("assertSmokeSupported fails closed when systemctl health is unknown", async () => {
  await assert.rejects(
    () => assertSmokeSupported("codex-telegram-gateway.service", {
      platform: "linux",
      execFileAsync: async () => {
        const error = new Error("Failed to connect to bus");
        error.code = 1;
        error.stderr = "Failed to connect to bus";
        throw error;
      },
    }),
    /Unable to confirm .* systemctl --user/u,
  );
});
