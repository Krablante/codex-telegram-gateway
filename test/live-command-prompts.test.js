import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSleepCommand,
  buildSleepCommandPrompt,
} from "../src/runtime/live-command-prompts.js";

test("buildSleepCommand stays POSIX on Linux", () => {
  assert.equal(buildSleepCommand(3, { platform: "linux" }), "sh -lc 'sleep 3; pwd'");
});

test("buildSleepCommand switches to PowerShell on Windows", () => {
  assert.equal(
    buildSleepCommand(4, { platform: "win32" }),
    'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 4; (Get-Location).Path"',
  );
  assert.match(buildSleepCommandPrompt(4, { platform: "win32" }), /Run exactly this shell command first:/u);
});
