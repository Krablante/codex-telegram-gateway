import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";

import { appendCodexRuntimeConfigArgs } from "../codex-runtime/config-args.js";
import { appendTextFile } from "../state/file-utils.js";
import {
  buildRsyncBaseArgs,
  buildRsyncRemotePath,
  buildSshBaseArgs,
  normalizeRsyncLocalPath,
  runCommand,
  runHostBash,
  shellQuote,
} from "../hosts/host-command-runner.js";
import { resolveExecutionCwd } from "../hosts/host-paths.js";
import { buildCodexChildEnv } from "../runtime/codex-child-env.js";
import { signalChildProcessTree } from "../runtime/process-tree.js";
import { spawnRuntimeCommand } from "../runtime/spawn-command.js";

export const CODEX_EXEC_BACKEND = "exec-json";

const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_MAX_BYTES = 16 * 1024;
const STDERR_TAIL_LINE_MAX_BYTES = 2 * 1024;
const STREAM_CLOSE_GRACE_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function truncateUtf8(text, maxBytes) {
  const normalized = String(text ?? "");
  if (Buffer.byteLength(normalized, "utf8") <= maxBytes) {
    return normalized;
  }

  const suffix = "... [truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const availableBytes = Math.max(maxBytes - suffixBytes, 0);
  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(normalized.slice(0, mid), "utf8") <= availableBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return `${normalized.slice(0, low)}${suffix}`;
}

function tailBytes(lines) {
  return Buffer.byteLength(lines.join("\n"), "utf8");
}

function rememberTail(
  lines,
  line,
  {
    maxBytes = STDERR_TAIL_MAX_BYTES,
    maxLineBytes = STDERR_TAIL_LINE_MAX_BYTES,
    maxLines = STDERR_TAIL_LINES,
  } = {},
) {
  const normalized = truncateUtf8(String(line ?? "").trimEnd(), maxLineBytes);
  if (!normalized) {
    return;
  }

  lines.push(normalized);
  while (lines.length > maxLines || tailBytes(lines) > maxBytes) {
    lines.shift();
  }
}

function sanitizePathSegment(value, fallback = "item") {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  return normalized || fallback;
}

function parseKeyValueLines(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    values[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1);
  }

  return values;
}

function isInterruptExit({ code, signal }) {
  return (
    signal === "SIGINT"
    || signal === "SIGTERM"
    || signal === "SIGKILL"
    || code === 130
    || code === 143
  );
}

function isLikelyNonPrimaryExecEvent(event, item = event?.item ?? null) {
  const markers = [
    event?.source,
    event?.origin,
    event?.agent_kind,
    event?.agent_type,
    item?.source,
    item?.origin,
    item?.agent_kind,
    item?.agent_type,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (
    markers.some((value) =>
      value.includes("subagent")
      || value.includes("sub-agent")
      || value.includes("collab"),
    )
  ) {
    return true;
  }

  return Boolean(
    event?.is_subagent === true
    || item?.is_subagent === true
    || item?.sender_thread_id
    || item?.agent_path
    || item?.agent_id,
  );
}

function resolveDeveloperInstructions({
  developerInstructions = null,
  baseInstructions = null,
} = {}) {
  return normalizeOptionalText(developerInstructions)
    || normalizeOptionalText(baseInstructions);
}

export function buildCodexExecPrompt({ prompt = "" } = {}) {
  return String(prompt || "");
}

export function buildCodexExecTaskArgs({
  cwd,
  sessionThreadId = null,
  imagePaths = [],
  model = null,
  reasoningEffort = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  developerInstructions = null,
} = {}) {
  const normalizedCwd = normalizeOptionalText(cwd);
  if (!normalizedCwd) {
    throw new Error("codex exec requires cwd");
  }

  const normalizedThreadId = normalizeOptionalText(sessionThreadId);
  const args = [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    normalizedCwd,
  ];

  if (normalizedThreadId) {
    args.push("resume");
  }

  appendCodexRuntimeConfigArgs(args, {
    model,
    reasoningEffort,
    contextWindow,
    autoCompactTokenLimit,
    developerInstructions,
  });

  for (const imagePath of Array.isArray(imagePaths) ? imagePaths : []) {
    const normalizedImagePath = normalizeOptionalText(imagePath);
    if (normalizedImagePath) {
      args.push("-i", normalizedImagePath);
    }
  }

  if (normalizedThreadId) {
    args.push(normalizedThreadId, "-");
  } else {
    args.push("-");
  }

  return args;
}

export function summarizeCodexExecEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  if (event.type === "thread.started") {
    if (isLikelyNonPrimaryExecEvent(event)) {
      return null;
    }
    return {
      kind: "thread",
      eventType: "thread.started",
      text: `Codex thread started: ${event.thread_id}`,
      threadId: event.thread_id || null,
    };
  }

  if (event.type === "turn.started") {
    if (isLikelyNonPrimaryExecEvent(event)) {
      return null;
    }
    return {
      kind: "turn",
      eventType: "turn.started",
      text: "Codex turn started",
    };
  }

  if (event.type === "turn.completed") {
    if (isLikelyNonPrimaryExecEvent(event)) {
      return null;
    }
    return {
      kind: "turn",
      eventType: "turn.completed",
      text: "Codex turn completed",
      usage: event.usage || null,
      turnStatus: "completed",
    };
  }

  if (event.type === "turn.failed") {
    if (isLikelyNonPrimaryExecEvent(event)) {
      return null;
    }
    const message = event.error?.message || "Codex turn failed";
    return {
      kind: "turn",
      eventType: "turn.failed",
      text: message,
      turnStatus: "failed",
      turnError: event.error || { message },
    };
  }

  if (event.type === "error") {
    if (isLikelyNonPrimaryExecEvent(event)) {
      return null;
    }
    const message = event.message || "Codex exec stream error";
    return {
      kind: "turn",
      eventType: "error",
      text: message,
      turnStatus: "failed",
      turnError: { message },
    };
  }

  if (!["item.started", "item.updated", "item.completed"].includes(event.type)) {
    return null;
  }

  const item = event.item || null;
  if (!item || typeof item !== "object") {
    return null;
  }
  if (isLikelyNonPrimaryExecEvent(event, item)) {
    return null;
  }

  if (item.type === "command_execution") {
    const command = item.command || "command";
    return {
      kind: "command",
      eventType: event.type,
      text: event.type === "item.completed"
        ? `Completed command: ${command}`
        : `Running command: ${command}`,
      command,
      exitCode: item.exit_code ?? null,
      aggregatedOutput: item.aggregated_output || "",
    };
  }

  if (item.type === "agent_message") {
    if (event.type !== "item.completed") {
      return null;
    }
    const text = normalizeOptionalText(item.text);
    if (!text) {
      return null;
    }
    return {
      kind: "agent_message",
      eventType: event.type,
      text,
      messagePhase: "commentary",
      progressSource: "agent_message",
    };
  }

  if (item.type === "reasoning") {
    const text = normalizeOptionalText(item.text);
    if (!text) {
      return null;
    }
    return {
      kind: "agent_message",
      eventType: event.type,
      text,
      messagePhase: "commentary",
      progressSource: "reasoning",
    };
  }

  return null;
}

function createJsonlProcessor({ onEvent, onWarning, onRuntimeState }) {
  let resolveTerminalEvent;
  const terminalEventPromise = new Promise((resolve) => {
    resolveTerminalEvent = resolve;
  });
  const state = {
    latestThreadId: null,
    sawTurnCompleted: false,
    sawTurnFailed: false,
    fatalError: null,
    latestAgentMessageText: null,
    emittedFinalAnswer: false,
    malformedLineCount: 0,
  };
  let chain = Promise.resolve();
  let chainError = null;

  const handleEvent = async (event) => {
    const nonPrimaryEvent = isLikelyNonPrimaryExecEvent(event);
    let terminalEvent = null;
    if (event.type === "thread.started" && event.thread_id && !nonPrimaryEvent) {
      state.latestThreadId = event.thread_id;
      await onRuntimeState?.({ threadId: event.thread_id });
    }
    if (event.type === "turn.started" && !nonPrimaryEvent) {
      state.latestAgentMessageText = null;
      state.emittedFinalAnswer = false;
    } else if (event.type === "turn.completed" && !nonPrimaryEvent) {
      state.sawTurnCompleted = true;
      terminalEvent = event;
    } else if (event.type === "turn.failed" && !nonPrimaryEvent) {
      state.sawTurnFailed = true;
      state.fatalError = event.error || { message: "Codex turn failed" };
      terminalEvent = event;
    } else if (event.type === "error" && !nonPrimaryEvent) {
      state.fatalError = { message: event.message || "Codex exec stream error" };
      terminalEvent = event;
    }

    const summary = summarizeCodexExecEvent(event);
    if (summary?.threadId) {
      state.latestThreadId = summary.threadId;
    }
    if (
      summary?.kind === "agent_message"
      && summary.eventType === "item.completed"
      && summary.progressSource === "agent_message"
      && typeof summary.text === "string"
      && summary.text.trim()
    ) {
      state.latestAgentMessageText = summary.text;
    }
    if (summary) {
      await onEvent?.(summary);
    }
    if (
      event.type === "turn.completed"
      && !nonPrimaryEvent
      && !state.emittedFinalAnswer
      && typeof state.latestAgentMessageText === "string"
      && state.latestAgentMessageText.trim()
    ) {
      state.emittedFinalAnswer = true;
      await onEvent?.({
        kind: "agent_message",
        eventType: "turn.completed",
        text: state.latestAgentMessageText,
        messagePhase: "final_answer",
      });
    }
    if (terminalEvent) {
      resolveTerminalEvent(terminalEvent);
    }
  };

  return {
    state,
    terminalEventPromise,
    ingestLine(line) {
      chain = chain
        .then(async () => {
          const trimmed = String(line || "").trim();
          if (!trimmed) {
            return;
          }

          const event = safeJsonParse(trimmed);
          if (!event) {
            state.malformedLineCount += 1;
            onWarning?.(`Malformed codex exec JSONL ignored: ${trimmed.slice(0, 200)}`);
            return;
          }

          await handleEvent(event);
        })
        .catch((error) => {
          chainError = error;
        });
    },
    async settle() {
      await chain;
      if (chainError) {
        throw chainError;
      }
    },
  };
}

async function waitForReaderClose(reader, closePromise, graceMs) {
  const result = await Promise.race([
    closePromise.then(() => "closed"),
    sleep(graceMs).then(() => "timeout"),
  ]);
  if (result === "timeout") {
    reader.close();
  }
  await closePromise.catch(() => null);
}

async function stageExecImagesToRemote({
  connectTimeoutSecs,
  execFileImpl,
  host,
  imagePaths = [],
  platform = process.platform,
  remoteInputRoot,
}) {
  const staged = [];
  const cache = new Map();
  for (const imagePath of Array.isArray(imagePaths) ? imagePaths : []) {
    const normalizedImagePath = normalizeOptionalText(imagePath);
    if (!normalizedImagePath) {
      continue;
    }

    const resolvedLocalPath = await fs.realpath(normalizedImagePath);
    const cached = cache.get(resolvedLocalPath);
    if (cached) {
      staged.push(cached);
      continue;
    }

    const remoteFileName = [
      String(cache.size + 1).padStart(4, "0"),
      sanitizePathSegment(path.basename(resolvedLocalPath), "image"),
    ].join("-");
    const remotePath = path.posix.join(remoteInputRoot, remoteFileName);
    await runCommand(
      "rsync",
      [
        ...buildRsyncBaseArgs(connectTimeoutSecs),
        "--chmod=F600,D700",
        normalizeRsyncLocalPath(resolvedLocalPath, { platform }),
        buildRsyncRemotePath(host.ssh_target, remotePath),
      ],
      {
        execFileImpl,
        timeoutMs: 30_000,
      },
    );
    cache.set(resolvedLocalPath, remotePath);
    staged.push(remotePath);
  }

  return staged;
}

function buildRemoteExecShellCommand({ codexBinPath, args }) {
  const command = [codexBinPath, ...args].map((part) => shellQuote(part)).join(" ");
  const script = [
    "set -euo pipefail",
    "exec 3<&0",
    "child_pid=",
    "terminate_child() {",
    '  if [[ -n "${child_pid:-}" ]]; then',
    '    kill -TERM -- "-${child_pid}" 2>/dev/null || kill -TERM "$child_pid" 2>/dev/null || true',
    "    sleep 1",
    '    kill -KILL -- "-${child_pid}" 2>/dev/null || kill -KILL "$child_pid" 2>/dev/null || true',
    "  fi",
    "}",
    'trap "terminate_child; exit 130" INT',
    'trap "terminate_child; exit 143" HUP TERM',
    `if command -v setsid >/dev/null 2>&1; then setsid ${command} <&3 & else ${command} <&3 & fi`,
    "child_pid=$!",
    "set +e",
    'wait "$child_pid"',
    "exit_code=$?",
    "child_pid=",
    "exit $exit_code",
  ].join("\n");
  return `bash -lc ${shellQuote(script)}`;
}

function buildPrepareRemoteExecPathsScript({
  codexBinPath,
  remoteCwd,
  remoteInputRoot,
}) {
  return [
    "set -euo pipefail",
    "expand_path() {",
    '  local value="$1"',
    '  if [[ "$value" == "~" ]]; then printf "%s\\n" "$HOME"; return; fi',
    '  if [[ "$value" == "~/"* ]]; then printf "%s/%s\\n" "$HOME" "${value:2}"; return; fi',
    '  printf "%s\\n" "$value"',
    "}",
    `remote_cwd="$(expand_path ${shellQuote(remoteCwd)})"`,
    `remote_input_root="$(expand_path ${shellQuote(remoteInputRoot)})"`,
    `remote_codex_bin="$(expand_path ${shellQuote(codexBinPath)})"`,
    '[[ -d "$remote_cwd" ]]',
    'mkdir -p "$remote_input_root"',
    '[[ -d "$remote_input_root" ]]',
    'printf "cwd=%s\\n" "$remote_cwd"',
    'printf "input_root=%s\\n" "$remote_input_root"',
    'printf "codex_bin=%s\\n" "$remote_codex_bin"',
  ].join("\n");
}

function buildRemoteInputRunSegment() {
  return [
    "run",
    Date.now(),
    Math.random().toString(16).slice(2),
  ].join("-");
}

async function cleanupRemoteInputRoot({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  remoteInputRoot,
}) {
  await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: [
      "set -euo pipefail",
      `target=${shellQuote(remoteInputRoot)}`,
      'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
      'rm -rf -- "$target"',
    ].join("; "),
    timeoutMs: 20_000,
  });
}

async function prepareRemoteExecPaths({
  codexBinPath,
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  hostId,
  remoteCwd,
  remoteInputRoot,
}) {
  const result = await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: buildPrepareRemoteExecPathsScript({
      codexBinPath,
      remoteCwd,
      remoteInputRoot,
    }),
    timeoutMs: Math.max(connectTimeoutSecs * 1000, 5000),
  }).catch((error) => {
    throw new Error(`Remote exec paths are unavailable on ${hostId}: ${error.message}`);
  });
  const parsed = parseKeyValueLines(result.stdout);
  if (!parsed.cwd || !parsed.input_root || !parsed.codex_bin) {
    throw new Error(`Remote exec path expansion failed on ${hostId}`);
  }

  return {
    remoteCwd: parsed.cwd,
    remoteInputRoot: parsed.input_root,
    remoteCodexBinPath: parsed.codex_bin,
  };
}

export function buildRemoteCodexExecSshArgs({
  host,
  connectTimeoutSecs,
  codexBinPath,
  args,
} = {}) {
  if (!host?.ssh_target) {
    throw new Error("Remote exec host is missing ssh_target metadata");
  }

  return [
    "-T",
    ...buildSshBaseArgs(host.ssh_target, connectTimeoutSecs),
    buildRemoteExecShellCommand({ codexBinPath, args }),
  ];
}

function startExecChild({
  command,
  args,
  cwd = undefined,
  prompt,
  onEvent,
  onWarning,
  onRuntimeState,
  spawnImpl,
  platform = process.platform,
  detached = platform !== "win32",
  jsonlLogPath = null,
  sessionThreadId = null,
  streamCloseGraceMs = STREAM_CLOSE_GRACE_MS,
}) {
  const child = spawnRuntimeCommand(command, args, {
    cwd,
    env: buildCodexChildEnv(),
    platform,
    stdio: ["pipe", "pipe", "pipe"],
    detached,
    spawnImpl,
  });
  const stdoutReader = readline.createInterface({ input: child.stdout });
  const stderrReader = readline.createInterface({ input: child.stderr });
  const stderrTail = [];
  const processor = createJsonlProcessor({ onEvent, onWarning, onRuntimeState });
  let jsonlLogWriteChain = Promise.resolve();
  let jsonlLogWarningEmitted = false;

  const appendJsonlLogLine = (line) => {
    const logPath = normalizeOptionalText(jsonlLogPath);
    if (!logPath) {
      return;
    }

    jsonlLogWriteChain = jsonlLogWriteChain
      .then(() => appendTextFile(logPath, `${line}\n`))
      .catch((error) => {
        if (!jsonlLogWarningEmitted) {
          jsonlLogWarningEmitted = true;
          onWarning?.(`Failed to mirror codex exec JSONL: ${error.message}`);
        }
      });
  };

  stdoutReader.on("line", (line) => {
    appendJsonlLogLine(line);
    processor.ingestLine(line);
  });
  stderrReader.on("line", (line) => {
    rememberTail(stderrTail, line);
  });

  const closePromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const exitSettledPromise = closePromise.then(
    (exit) => ({ kind: "child-exit", exit }),
    (error) => ({ kind: "child-error", error }),
  );
  const terminalSettledPromise = processor.terminalEventPromise.then(
    (event) => ({ kind: "terminal-event", event }),
  );
  const stdoutClosed = once(stdoutReader, "close").catch(() => null);
  const stderrClosed = once(stderrReader, "close").catch(() => null);

  if (child.stdin) {
    child.stdin.end(String(prompt || ""));
  }

  let userInterruptRequested = false;
  let steerInterruptRequested = false;

  const finished = (async () => {
    const firstCompletion = await Promise.race([
      exitSettledPromise,
      terminalSettledPromise,
    ]);
    if (firstCompletion.kind === "child-error") {
      throw firstCompletion.error;
    }

    let exit = firstCompletion.kind === "child-exit"
      ? firstCompletion.exit
      : null;
    const completedFromTerminalEvent = firstCompletion.kind === "terminal-event";
    if (completedFromTerminalEvent) {
      signalChildProcessTree(child, "SIGTERM", { platform });
      const maybeExit = await Promise.race([
        exitSettledPromise,
        sleep(streamCloseGraceMs).then(() => null),
      ]);
      if (maybeExit?.kind === "child-exit") {
        exit = maybeExit.exit;
      }
    }

    await Promise.all([
      waitForReaderClose(stdoutReader, stdoutClosed, streamCloseGraceMs),
      waitForReaderClose(stderrReader, stderrClosed, streamCloseGraceMs),
    ]);
    await jsonlLogWriteChain;
    await processor.settle();
    exit ??= { code: null, signal: null };

    const requestedInterrupt = userInterruptRequested || steerInterruptRequested;
    const requestedInterruptWithoutTerminalEvent =
      requestedInterrupt
      && !processor.state.sawTurnCompleted
      && !processor.state.sawTurnFailed
      && !processor.state.fatalError;
    const interrupted =
      !completedFromTerminalEvent
      && (
        isInterruptExit(exit)
        || requestedInterruptWithoutTerminalEvent
      );
    const warnings = [];
    if (processor.state.malformedLineCount > 0) {
      warnings.push(
        `Ignored malformed codex exec JSONL lines: ${processor.state.malformedLineCount}`,
      );
    }
    if (processor.state.fatalError?.message && !interrupted) {
      warnings.push(`Codex exec failed: ${processor.state.fatalError.message}`);
    }
    if (
      !completedFromTerminalEvent
      && (exit.code !== 0 || exit.signal)
      && stderrTail.length > 0
      && !interrupted
    ) {
      warnings.push(`codex exec stderr:\n${stderrTail.join("\n")}`);
    }
    if (!processor.state.sawTurnCompleted && !interrupted) {
      warnings.push("Codex exec stream ended before turn.completed");
    }

    const ok =
      (completedFromTerminalEvent || exit.code === 0)
      && (completedFromTerminalEvent || !exit.signal)
      && processor.state.sawTurnCompleted
      && !processor.state.fatalError;
    const requestedThreadId = normalizeOptionalText(sessionThreadId);
    const resumeReplacement =
      requestedThreadId
      && !processor.state.latestThreadId
      && !interrupted
      && !ok
        ? {
          requestedThreadId,
          replacementThreadId: null,
          reason: "exec-resume-unavailable",
        }
        : null;
    const abortReason = interrupted
      ? "interrupted"
      : resumeReplacement
        ? "resume_unavailable"
        : processor.state.sawTurnFailed
          ? "turn_failed"
          : processor.state.fatalError
            ? "exec_stream_error"
            : !processor.state.sawTurnCompleted
              ? "exec_stream_incomplete"
              : null;

    return {
      backend: CODEX_EXEC_BACKEND,
      ok,
      exitCode: exit.code,
      signal: exit.signal,
      interrupted,
      interruptReason: interrupted
        ? steerInterruptRequested
          ? "upstream"
          : userInterruptRequested
          ? "user"
          : "upstream"
        : null,
      preserveContinuity: Boolean(processor.state.latestThreadId || requestedThreadId),
      threadId: processor.state.latestThreadId || requestedThreadId,
      warnings,
      resumeReplacement,
      abortReason,
    };
  })();

  return {
    child,
    finished,
    interrupt() {
      userInterruptRequested = true;
      return Promise.resolve(
        signalChildProcessTree(child, "SIGINT", { platform }),
      );
    },
    async steer() {
      steerInterruptRequested = true;
      const signalled = await Promise.resolve(
        signalChildProcessTree(child, "SIGINT", { platform }),
      );
      if (signalled === false) {
        steerInterruptRequested = false;
      }
      return {
        ok: signalled !== false,
        reason: signalled === false ? "steer-failed" : "steered",
      };
    },
  };
}

export function runCodexExecTask({
  codexBinPath,
  cwd,
  prompt,
  developerInstructions = null,
  baseInstructions = null,
  sessionThreadId = null,
  imagePaths = [],
  model = null,
  reasoningEffort = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  onEvent,
  onWarning,
  onRuntimeState,
  jsonlLogPath = null,
  spawnImpl,
  platform = process.platform,
  streamCloseGraceMs = STREAM_CLOSE_GRACE_MS,
}) {
  const args = buildCodexExecTaskArgs({
    cwd,
    sessionThreadId,
    imagePaths,
    model,
    reasoningEffort,
    contextWindow,
    autoCompactTokenLimit,
    developerInstructions: resolveDeveloperInstructions({
      developerInstructions,
      baseInstructions,
    }),
  });

  return startExecChild({
    command: codexBinPath,
    args,
    cwd,
    prompt: buildCodexExecPrompt({ prompt }),
    onEvent,
    onWarning,
    onRuntimeState,
    jsonlLogPath,
    spawnImpl,
    platform,
    sessionThreadId,
    streamCloseGraceMs,
  });
}

export async function runRemoteCodexExecTask({
  codexBinPath,
  connectTimeoutSecs = 8,
  currentHostId,
  executionHost,
  host = executionHost?.host ?? null,
  imagePaths = [],
  model = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  onEvent,
  onRuntimeState = null,
  onWarning,
  jsonlLogPath = null,
  prompt,
  developerInstructions = null,
  baseInstructions = null,
  execFileImpl,
  reasoningEffort = null,
  session,
  sessionKey = null,
  sessionThreadId = null,
  spawnImpl,
  platform = process.platform,
  streamCloseGraceMs = STREAM_CLOSE_GRACE_MS,
}) {
  const resolvedHost = host || null;
  const hostId = normalizeOptionalText(executionHost?.hostId || resolvedHost?.host_id);
  if (!resolvedHost || !hostId || !resolvedHost.ssh_target) {
    throw new Error("Remote execution host is missing ssh_target metadata");
  }

  const rawRemoteCwd = resolveExecutionCwd({
    workspaceBinding: session?.workspace_binding,
    host: resolvedHost,
    currentHostId,
  });
  if (!rawRemoteCwd) {
    throw new Error(`Cannot resolve remote cwd for host ${hostId}`);
  }

  const rawRemoteInputRoot = path.posix.join(
    resolvedHost.worker_runtime_root || resolvedHost.repo_root || rawRemoteCwd,
    "remote-inputs",
    sanitizePathSegment(sessionKey || session?.session_key || hostId, hostId),
    buildRemoteInputRunSegment(),
  );
  const rawRemoteCodexBinPath = resolvedHost.codex_bin_path || codexBinPath;
  const {
    remoteCwd,
    remoteInputRoot,
    remoteCodexBinPath,
  } = await prepareRemoteExecPaths({
    codexBinPath: rawRemoteCodexBinPath,
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host: resolvedHost,
    hostId,
    remoteCwd: rawRemoteCwd,
    remoteInputRoot: rawRemoteInputRoot,
  });

  const stagedImagePaths = await stageExecImagesToRemote({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host: resolvedHost,
    imagePaths,
    platform,
    remoteInputRoot,
  });
  const args = buildCodexExecTaskArgs({
    cwd: remoteCwd,
    sessionThreadId,
    imagePaths: stagedImagePaths,
    model,
    reasoningEffort,
    contextWindow,
    autoCompactTokenLimit,
    developerInstructions: resolveDeveloperInstructions({
      developerInstructions,
      baseInstructions,
    }),
  });
  const sshArgs = buildRemoteCodexExecSshArgs({
    host: resolvedHost,
    connectTimeoutSecs,
    codexBinPath: remoteCodexBinPath,
    args,
  });

  const execTask = startExecChild({
    command: "ssh",
    args: sshArgs,
    prompt: buildCodexExecPrompt({ prompt }),
    onEvent,
    onWarning,
    onRuntimeState,
    jsonlLogPath,
    spawnImpl,
    platform,
    detached: platform !== "win32",
    sessionThreadId,
    streamCloseGraceMs,
  });
  return {
    ...execTask,
    finished: execTask.finished.finally(async () => {
      await cleanupRemoteInputRoot({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host: resolvedHost,
        remoteInputRoot,
      }).catch((error) => {
        onWarning?.(`Failed to clean remote exec input staging: ${error.message}`);
      });
    }),
  };
}
