import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

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
import { signalChildProcessTree } from "../runtime/process-tree.js";
import { spawnRuntimeCommand } from "../runtime/spawn-command.js";
import {
  buildRpcError,
  buildRpcRequest,
  buildRpcResult,
  createRpcError,
  encodeRpcMessage,
  parseRpcLine,
} from "./remote-executor-contract.js";

const REMOTE_EXECUTOR_START_TIMEOUT_MS = 20_000;
const REMOTE_EXECUTOR_STEER_TIMEOUT_MS = 20_000;
const REMOTE_EXECUTOR_STDERR_TAIL_LINES = 20;
const LOCAL_GATEWAY_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

function sanitizePathSegment(value, fallback = "item") {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  return normalized || fallback;
}

export function buildRemoteStartRunParams({
  resolvedHost,
  codexBinPath,
  remoteCwd,
  prompt,
  baseInstructions = null,
  localizedImagePaths = [],
  sessionKey = null,
  sessionThreadId = null,
  providerSessionId = null,
  knownRolloutPath = null,
  skipThreadHistoryLookup = false,
  model = null,
  reasoningEffort = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
} = {}) {
  const normalizedBaseInstructions = normalizeOptionalText(baseInstructions);
  return {
    codexBinPath: resolvedHost?.codex_bin_path || codexBinPath,
    cwd: remoteCwd,
    prompt,
    ...(normalizedBaseInstructions
      ? { baseInstructions: normalizedBaseInstructions }
      : {}),
    imagePaths: Array.isArray(localizedImagePaths) ? localizedImagePaths : [],
    sessionKey,
    sessionThreadId,
    providerSessionId,
    knownRolloutPath,
    skipThreadHistoryLookup,
    model,
    reasoningEffort,
    contextWindow,
    autoCompactTokenLimit,
  };
}

function rememberStderrLine(lines, line) {
  const normalized = String(line ?? "").trimEnd();
  if (!normalized) {
    return;
  }

  lines.push(normalized);
  if (lines.length > REMOTE_EXECUTOR_STDERR_TAIL_LINES) {
    lines.shift();
  }
}

function buildRemoteExecutorCommand(repoRoot) {
  return [
    "set -euo pipefail",
    `repo_root=${shellQuote(repoRoot)}`,
    'if [[ "$repo_root" == "~" ]]; then repo_root="$HOME"; elif [[ "$repo_root" == "~/"* ]]; then repo_root="$HOME/${repo_root:2}"; fi',
    'export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"',
    'cd "$repo_root"',
    "exec node src/cli/host-executor.js --stdio-jsonrpc",
  ].join("; ");
}

export function assertSafeRemoteGatewayRepoRoot(repoRoot, hostId = "unknown") {
  const normalizedRepoRoot = normalizeOptionalText(repoRoot);
  if (!normalizedRepoRoot) {
    throw new Error(`Remote execution host ${hostId} is missing repo_root`);
  }

  const expandedRepoRoot =
    normalizedRepoRoot === "~"
      ? "/"
      : normalizedRepoRoot.startsWith("~/")
        ? normalizedRepoRoot.slice(2)
        : normalizedRepoRoot;
  const rootName = path.posix.basename(expandedRepoRoot.replace(/\/+$/u, ""));
  if (
    rootName !== "codex-telegram-gateway"
    || normalizedRepoRoot === "/"
    || normalizedRepoRoot === "~"
    || normalizedRepoRoot.includes("\0")
  ) {
    throw new Error(
      `Remote execution host ${hostId} repo_root must point at a codex-telegram-gateway checkout before sync`,
    );
  }
}

async function syncGatewayRepoToRemote({
  connectTimeoutSecs,
  execFileImpl,
  host,
  platform = process.platform,
}) {
  assertSafeRemoteGatewayRepoRoot(host.repo_root, host.host_id);
  await runCommand(
    "rsync",
    [
      ...buildRsyncBaseArgs(connectTimeoutSecs),
      "--delete",
      "--exclude=.git/",
      "--exclude=node_modules/",
      "--exclude=.env",
      normalizeRsyncLocalPath(
        `${LOCAL_GATEWAY_REPO_ROOT}${path.sep}`,
        { platform },
      ),
      buildRsyncRemotePath(host.ssh_target, `${host.repo_root}/`),
    ],
    {
      execFileImpl,
      timeoutMs: 60_000,
    },
  );
  await runCommand(
    "rsync",
    [
      ...buildRsyncBaseArgs(connectTimeoutSecs),
      "--delete",
      normalizeRsyncLocalPath(
        path.join(LOCAL_GATEWAY_REPO_ROOT, ".git", path.sep),
        { platform },
      ),
      buildRsyncRemotePath(host.ssh_target, `${host.repo_root}/.git/`),
    ],
    {
      execFileImpl,
      timeoutMs: 60_000,
    },
  );
}

function buildStartupErrorMessage(hostId, stderrTail, fallbackMessage) {
  if (stderrTail.length === 0) {
    return fallbackMessage;
  }

  return [
    fallbackMessage,
    `Recent remote executor stderr for ${hostId}:`,
    ...stderrTail,
  ].join("\n");
}

function createDeferred() {
  let resolve = null;
  let reject = null;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createIdGenerator(prefix) {
  let nextId = 1;
  return () => `${prefix}${nextId++}`;
}

function createSerialMessageQueue() {
  let queue = Promise.resolve();
  return (handler, onError) => {
    queue = queue
      .then(handler)
      .catch(onError);
  };
}

async function writeMessage(stream, message) {
  if (!stream || stream.destroyed || stream.writableEnded) {
    throw new Error("Remote executor stdin is closed");
  }

  const payload = encodeRpcMessage(message);
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("error", onError);
      stream.off("drain", onDrain);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };

    stream.on("error", onError);
    const accepted = stream.write(payload, "utf8");
    if (accepted) {
      cleanup();
      resolve();
      return;
    }

    stream.on("drain", onDrain);
  });
}

async function ensureRemoteDirectory({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  directory,
  create = false,
}) {
  const normalizedDirectory = normalizeOptionalText(directory);
  if (!normalizedDirectory) {
    throw new Error(`Remote directory is missing for host ${host?.host_id || "unknown"}`);
  }

  const commands = [
    `target=${shellQuote(normalizedDirectory)}`,
    'if [[ "$target" == "~" ]]; then target="$HOME"; elif [[ "$target" == "~/"* ]]; then target="$HOME/${target:2}"; fi',
  ];
  if (create) {
    commands.push('mkdir -p "$target"');
  }
  commands.push('[[ -d "$target" ]]');

  await runHostBash({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host,
    script: commands.join("; "),
    timeoutMs: Math.max(connectTimeoutSecs * 1000, 5000),
  });
}

async function stageImageToRemote({
  connectTimeoutSecs,
  execFileImpl,
  host,
  imagePath,
  platform = process.platform,
  remoteInputRoot,
  cache,
}) {
  const resolvedLocalPath = await fs.realpath(imagePath);
  const cachedPath = cache.get(resolvedLocalPath);
  if (cachedPath) {
    return cachedPath;
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
  return remotePath;
}

async function localizeRemoteInputItems({
  connectTimeoutSecs,
  currentHostId,
  execFileImpl,
  host,
  input = [],
  platform = process.platform,
  remoteInputRoot,
  cache,
}) {
  const localized = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type !== "localImage" || !item.path) {
      localized.push(item);
      continue;
    }

    const remotePath = await stageImageToRemote({
      connectTimeoutSecs,
      currentHostId,
      execFileImpl,
      host,
      imagePath: item.path,
      platform,
      remoteInputRoot,
      cache,
    });
    localized.push({
      ...item,
      path: remotePath,
    });
  }

  return localized;
}

export async function runRemoteCodexTask({
  codexBinPath,
  connectTimeoutSecs,
  currentHostId,
  executionHost,
  host = executionHost?.host ?? null,
  imagePaths = [],
  knownRolloutPath = null,
  model = null,
  contextWindow = null,
  autoCompactTokenLimit = null,
  onEvent,
  onRuntimeState = null,
  onWarning,
  prompt,
  baseInstructions = null,
  execFileImpl,
  providerSessionId = null,
  reasoningEffort = null,
  session,
  sessionKey = null,
  sessionThreadId = null,
  platform = process.platform,
  skipThreadHistoryLookup = false,
  spawnImpl,
}) {
  const resolvedHost = host || null;
  const hostId = normalizeOptionalText(executionHost?.hostId || resolvedHost?.host_id);
  if (!resolvedHost || !hostId || !resolvedHost.ssh_target) {
    throw new Error("Remote execution host is missing ssh_target metadata");
  }
  if (!resolvedHost.repo_root) {
    throw new Error(`Remote execution host ${hostId} is missing repo_root`);
  }
  if (!resolvedHost.worker_runtime_root) {
    throw new Error(`Remote execution host ${hostId} is missing worker_runtime_root`);
  }

  const remoteCwd = resolveExecutionCwd({
    workspaceBinding: session?.workspace_binding,
    host: resolvedHost,
    currentHostId,
  });
  if (!remoteCwd) {
    throw new Error(`Cannot resolve remote cwd for host ${hostId}`);
  }

  await ensureRemoteDirectory({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host: resolvedHost,
    directory: resolvedHost.repo_root,
    create: true,
  });
  await syncGatewayRepoToRemote({
    connectTimeoutSecs,
    execFileImpl,
    host: resolvedHost,
    platform,
  });

  await ensureRemoteDirectory({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host: resolvedHost,
    directory: remoteCwd,
  }).catch((error) => {
    throw new Error(`Remote cwd is unavailable on ${hostId}: ${error.message}`);
  });

  const remoteInputRoot = path.posix.join(
    resolvedHost.worker_runtime_root,
    "remote-inputs",
    sanitizePathSegment(sessionKey || session?.session_key || hostId, hostId),
  );
  await ensureRemoteDirectory({
    connectTimeoutSecs,
    currentHostId,
    execFileImpl,
    host: resolvedHost,
    directory: remoteInputRoot,
    create: true,
  });

  const stagedImageCache = new Map();
  const localizedImagePaths = [];
  for (const imagePath of Array.isArray(imagePaths) ? imagePaths : []) {
    localizedImagePaths.push(
      await stageImageToRemote({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host: resolvedHost,
        imagePath,
        platform,
        remoteInputRoot,
        cache: stagedImageCache,
      }),
    );
  }

  const child = spawnRuntimeCommand(
    "ssh",
    [
      ...buildSshBaseArgs(resolvedHost.ssh_target, connectTimeoutSecs),
      `bash -c ${shellQuote(buildRemoteExecutorCommand(resolvedHost.repo_root))}`,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      detached: platform !== "win32",
      platform,
      spawnImpl,
    },
  );
  const stdoutReader = readline.createInterface({ input: child.stdout });
  const stderrReader = readline.createInterface({ input: child.stderr });
  const nextRequestId = createIdGenerator("n");
  const pendingRequests = new Map();
  const remoteFinished = createDeferred();
  const stderrTail = [];
  let settled = false;
  const enqueueStdoutLine = createSerialMessageQueue();

  const settleRemote = (error, result = null) => {
    if (settled) {
      return;
    }

    settled = true;
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
    if (error) {
      remoteFinished.reject(error);
      return;
    }
    remoteFinished.resolve(result || {
      exitCode: 0,
      signal: null,
      threadId: null,
      warnings: [],
      resumeReplacement: null,
    });
  };

  const sendRequest = async (method, params, { timeoutMs = 0 } = {}) => {
    const id = nextRequestId();
    const deferred = createDeferred();
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        pendingRequests.delete(id);
        deferred.reject(new Error(`Remote executor request timed out: ${method}`));
      }, timeoutMs);
    }
    pendingRequests.set(id, {
      resolve: (value) => {
        if (timer) {
          clearTimeout(timer);
        }
        deferred.resolve(value);
      },
      reject: (error) => {
        if (timer) {
          clearTimeout(timer);
        }
        deferred.reject(error);
      },
      method,
    });
    try {
      await writeMessage(child.stdin, buildRpcRequest(id, method, params));
    } catch (error) {
      pendingRequests.delete(id);
      if (timer) {
        clearTimeout(timer);
      }
      throw error;
    }
    return deferred.promise;
  };

  const handleRequest = async (message) => {
    if (!message?.method || message.id === undefined) {
      return;
    }

    try {
      switch (message.method) {
        case "onRuntimeState":
          await onRuntimeState?.(message.params || {});
          await writeMessage(child.stdin, buildRpcResult(message.id, { ok: true }));
          return;
        case "onEvent":
          await onEvent?.(message.params?.summary ?? null, null);
          await writeMessage(child.stdin, buildRpcResult(message.id, { ok: true }));
          return;
        case "finished":
          await writeMessage(child.stdin, buildRpcResult(message.id, { ok: true }));
          settleRemote(null, message.params?.result || {
            exitCode: 0,
            signal: null,
            threadId: null,
            warnings: [],
            resumeReplacement: null,
          });
          return;
        case "failed":
          await writeMessage(child.stdin, buildRpcResult(message.id, { ok: true }));
          settleRemote(
            createRpcError(
              message.params?.error || {
                message: message.params?.message || "Remote executor failed",
              },
              "Remote executor failed",
            ),
          );
          return;
        default:
          await writeMessage(
            child.stdin,
            buildRpcError(
              message.id,
              { message: `Unknown remote executor method: ${message.method}` },
              "Unknown remote executor method",
            ),
          );
      }
    } catch (error) {
      await writeMessage(
        child.stdin,
        buildRpcError(
          message.id,
          error,
          `Remote executor callback failed: ${message.method}`,
        ),
      ).catch(() => {});
      if (message.method === "finished" || message.method === "failed") {
        settleRemote(error);
      }
    }
  };

  stdoutReader.on("line", (line) => {
    enqueueStdoutLine(
      async () => {
        const message = parseRpcLine(line);
        if (!message) {
          return;
        }

        if (message.method) {
          await handleRequest(message);
          return;
        }

        const pending = pendingRequests.get(message.id);
        if (!pending) {
          return;
        }

        pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(
            createRpcError(
              message.error,
              `Remote executor request failed: ${pending.method}`,
            ),
          );
          return;
        }

        pending.resolve(message.result ?? null);
      },
      (error) => {
        settleRemote(error);
      },
    );
  });

  stderrReader.on("line", (line) => {
    rememberStderrLine(stderrTail, line);
    onWarning?.(`[remote:${hostId}] ${line}`);
  });

  child.on("error", (error) => {
    settleRemote(error);
  });

  child.on("close", (code, signal) => {
    if (settled) {
      return;
    }

    settleRemote(
      new Error(
        buildStartupErrorMessage(
          hostId,
          stderrTail,
          `Remote executor exited before finishing (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      ),
    );
  });

  try {
    await sendRequest(
      "startRun",
      buildRemoteStartRunParams({
        resolvedHost,
        codexBinPath,
        remoteCwd,
        prompt,
        baseInstructions,
        localizedImagePaths,
        sessionKey,
        sessionThreadId,
        providerSessionId,
        knownRolloutPath,
        skipThreadHistoryLookup,
        model,
        reasoningEffort,
        contextWindow,
        autoCompactTokenLimit,
      }),
      {
        timeoutMs: REMOTE_EXECUTOR_START_TIMEOUT_MS,
      },
    );
  } catch (error) {
    signalChildProcessTree(child, "SIGTERM", { platform });
    throw error;
  }

  return {
    child,
    finished: remoteFinished.promise,
    async steer({ input } = {}) {
      const localizedInput = await localizeRemoteInputItems({
        connectTimeoutSecs,
        currentHostId,
        execFileImpl,
        host: resolvedHost,
        input,
        platform,
        remoteInputRoot,
        cache: stagedImageCache,
      });
      return sendRequest(
        "steer",
        {
          input: localizedInput,
        },
        {
          timeoutMs: REMOTE_EXECUTOR_STEER_TIMEOUT_MS,
        },
      );
    },
    interrupt({ threadId, turnId } = {}) {
      return sendRequest("interrupt", { threadId, turnId })
        .then((result) => Boolean(result))
        .catch(() => false);
    },
  };
}
