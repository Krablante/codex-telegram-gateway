import test from "node:test";
import assert from "node:assert/strict";

import {
  isRetryableFilesystemError,
  retryFilesystemOperation,
} from "../src/runtime/fs-retry.js";

test("isRetryableFilesystemError is scoped to Windows transient codes", () => {
  assert.equal(isRetryableFilesystemError({ code: "EPERM" }, { platform: "win32" }), true);
  assert.equal(isRetryableFilesystemError({ code: "EPERM" }, { platform: "linux" }), false);
  assert.equal(isRetryableFilesystemError({ code: "ENOENT" }, { platform: "win32" }), false);
});

test("retryFilesystemOperation retries transient Windows filesystem errors", async () => {
  let attempts = 0;
  const result = await retryFilesystemOperation(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error("busy");
      error.code = "EPERM";
      throw error;
    }
    return "ok";
  }, {
    platform: "win32",
    delayMs: 0,
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});
