import path from "node:path";
import { execFile } from "node:child_process";

import { writeTextAtomic } from "../state/file-utils.js";
import { buildCodexExecTaskArgs } from "../codex-exec/telegram-exec-runner.js";
import { inspectHostReadiness } from "./host-doctor.js";
import { runHostBash, shellQuote } from "./host-command-runner.js";

const REMOTE_SMOKE_TIMEOUT_MS = 10 * 60 * 1000;
const REMOTE_SMOKE_EXPECTED_PREFIX = "smoke-proof";
const REMOTE_CWD_PLACEHOLDER = "__CODEX_REMOTE_SMOKE_CWD__";

function parseKeyValueLines(text) {
  const pairs = {};
  for (const rawLine of String(text || "").split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    pairs[key] = value;
  }

  return pairs;
}

function buildRemoteSmokeScript({
  autoCompactTokenLimit = null,
  contextWindow = null,
  host,
  model = null,
  reasoningEffort = null,
  smokeDirectory,
  expectedText,
  promptText,
  workingDirectory,
}) {
  const codexArgs = buildCodexExecTaskArgs({
    cwd: REMOTE_CWD_PLACEHOLDER,
    model,
    reasoningEffort,
    contextWindow,
    autoCompactTokenLimit,
  }).map((arg) =>
    arg === REMOTE_CWD_PLACEHOLDER ? '"$working_directory"' : shellQuote(arg)
  ).join(" ");
  return [
    "set -euo pipefail",
    "expand_path() {",
    '  local value="$1"',
    '  if [[ "$value" == "~" ]]; then printf "%s\\n" "$HOME"; return; fi',
    '  if [[ "$value" == "~/"* ]]; then printf "%s/%s\\n" "$HOME" "${value:2}"; return; fi',
    '  printf "%s\\n" "$value"',
    "}",
    "latest_session() {",
    '  if [[ ! -d "$HOME/.codex/sessions" ]]; then return 0; fi',
    '  find "$HOME/.codex/sessions" -type f -name "*.jsonl" -printf "%T@ %p\\n" 2>/dev/null | sort -n | tail -1 | cut -d" " -f2-',
    "}",
    `working_directory=$(expand_path ${shellQuote(workingDirectory)})`,
    `smoke_directory=$(expand_path ${shellQuote(smokeDirectory)})`,
    `expected_text=${shellQuote(expectedText)}`,
    `prompt_text=${shellQuote(promptText)}`,
    `configured_codex=$(expand_path ${shellQuote(host.codex_bin_path || "codex")})`,
    `temp_last_message=${shellQuote(`/tmp/${path.posix.basename(smokeDirectory)}-last-message.txt`)}`,
    `temp_events=${shellQuote(`/tmp/${path.posix.basename(smokeDirectory)}-events.jsonl`)}`,
    'mkdir -p "$smoke_directory"',
    'before_session="$(latest_session || true)"',
    'rm -f "$temp_last_message" "$temp_events"',
    `printf "%s" "$prompt_text" | timeout 120s "$configured_codex" ${codexArgs} > "$temp_events"`,
    'if grep -Fq "\\"text\\":\\"$expected_text\\"" "$temp_events"; then',
    '  printf "%s\\n" "$expected_text" > "$temp_last_message"',
    "else",
    '  tail -n 1 "$temp_events" | tr -d \'\\r\' | tr -d \'\\n\' | cut -c1-500 > "$temp_last_message"',
    "fi",
    'after_session="$(latest_session || true)"',
    'cp "$temp_last_message" "$smoke_directory/last-message.txt"',
    'cp "$temp_events" "$smoke_directory/events.jsonl"',
    'last_message="$(tr -d \'\\r\' < "$temp_last_message" | tr -d \'\\n\')"',
    'printf "smoke_directory=%s\\n" "$smoke_directory"',
    'printf "expected_text=%s\\n" "$expected_text"',
    'printf "last_message=%s\\n" "$last_message"',
    'printf "matched=%s\\n" "$([[ "$last_message" == "$expected_text" ]] && echo 1 || echo 0)"',
    'printf "before_session=%s\\n" "$before_session"',
    'printf "after_session=%s\\n" "$after_session"',
  ].join("\n");
}

export async function runHostRemoteSmoke({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl = execFile,
  hostsRoot,
  model = null,
  reasoningEffort = "low",
  contextWindow = null,
  autoCompactTokenLimit = null,
  registryService,
  targetHostId,
  workingDirectory = null,
}) {
  if (!targetHostId) {
    throw new Error("Host remote smoke requires --host");
  }

  const host = await registryService.getHost(targetHostId);
  if (!host) {
    throw new Error(`Unknown host for remote smoke: ${targetHostId}`);
  }
  if (host.host_id === currentHostId) {
    throw new Error("Host remote smoke target must be different from the current host");
  }

  const readiness = await inspectHostReadiness({
    codexSpaceRoot: path.join(hostsRoot, "..", "codex-space"),
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
  });
  if (!readiness.ready) {
    throw new Error(
      `Host ${host.host_id} is not ready for remote smoke: ${readiness.failure_reason}`,
    );
  }

  const ranAt = new Date().toISOString();
  const stamp = ranAt.replace(/[:.]/gu, "-");
  const smokeDirectory = path.posix.join(
    host.worker_runtime_root,
    "host-smoke",
    stamp,
  );
  const expectedText = `${REMOTE_SMOKE_EXPECTED_PREFIX}-${host.host_id}`;
  const promptText = `Reply with EXACT text: ${expectedText}`;
  const remoteRun = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    maxBufferBytes: 4 * 1024 * 1024,
    script: buildRemoteSmokeScript({
      autoCompactTokenLimit,
      contextWindow,
      host,
      model,
      reasoningEffort,
      smokeDirectory,
      expectedText,
      promptText,
      workingDirectory:
        workingDirectory
        || host.workspace_root
        || host.default_binding_path
        || "~",
    }),
    timeoutMs: REMOTE_SMOKE_TIMEOUT_MS,
  });
  const parsedFields = parseKeyValueLines(remoteRun.stdout);
  const parsed = {
    smoke_directory: parsedFields.smoke_directory || null,
    expected_text: parsedFields.expected_text || expectedText,
    last_message: parsedFields.last_message || "",
    matched: parsedFields.matched === "1",
    before_session: parsedFields.before_session || null,
    after_session: parsedFields.after_session || null,
  };
  const summary = {
    ran_at: ranAt,
    current_host_id: currentHostId,
    host_id: host.host_id,
    status: parsed.matched ? "ok" : "failed",
    readiness,
    smoke: parsed,
  };

  await writeTextAtomic(
    path.join(hostsRoot, "remote-smoke-last-run.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  if (!parsed.matched) {
    throw new Error(
      `Remote smoke on ${host.host_id} returned unexpected text: ${parsed.last_message}`,
    );
  }

  return summary;
}
