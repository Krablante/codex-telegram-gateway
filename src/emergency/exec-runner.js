import path from "node:path";

import {
  buildCodexExecArgs,
  startCodexExecRun,
} from "../codex-exec/exec-runner.js";

export function buildEmergencyExecArgs(options) {
  return buildCodexExecArgs(options);
}

export function startEmergencyExecRun({
  stateRoot,
  ...options
}) {
  return startCodexExecRun({
    ...options,
    outputDir: path.join(stateRoot, "emergency", "runs"),
    outputPrefix: "last-message",
  });
}
