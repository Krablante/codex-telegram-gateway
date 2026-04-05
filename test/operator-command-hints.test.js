import test from "node:test";
import assert from "node:assert/strict";

import {
  formatOperatorCommandHints,
  getOperatorCommandHint,
} from "../src/runtime/operator-command-hints.js";

test("operator command hints stay make-based on Linux", () => {
  assert.equal(getOperatorCommandHint("user-login", { platform: "linux" }), "make user-login");
  assert.equal(getOperatorCommandHint("user-status", { platform: "linux" }), "make user-status");
});

test("operator command hints point Windows operators at wrapper scripts", () => {
  assert.equal(
    getOperatorCommandHint("admin", { platform: "win32" }),
    "scripts\\windows\\admin.cmd",
  );
  assert.equal(
    getOperatorCommandHint("user-e2e", { platform: "win32" }),
    "scripts\\windows\\user-e2e.cmd",
  );
  assert.equal(
    formatOperatorCommandHints(["doctor", "run"], { platform: "win32" }),
    "`scripts\\windows\\doctor.cmd`, `scripts\\windows\\run.cmd`",
  );
});
