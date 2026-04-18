import process from "node:process";

function normalizeSleepSecs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Sleep seconds must be > 0, got: ${value}`);
  }
  return Math.trunc(numeric);
}

export function buildSleepCommand(
  sleepSecs,
  { platform = process.platform } = {},
) {
  const seconds = normalizeSleepSecs(sleepSecs);
  if (platform === "win32") {
    return `powershell.exe -NoProfile -Command "Start-Sleep -Seconds ${seconds}; (Get-Location).Path"`;
  }

  return `sh -lc 'sleep ${seconds}; pwd'`;
}

export function buildSleepCommandPrompt(
  sleepSecs,
  { platform = process.platform } = {},
) {
  return `Run exactly this shell command first: ${buildSleepCommand(sleepSecs, { platform })}`;
}
