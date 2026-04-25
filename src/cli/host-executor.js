import process from "node:process";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCodexTask } from "../pty-worker/codex-runner.js";
import {
  buildRpcError,
  buildRpcRequest,
  buildRpcResult,
  createRpcError,
  encodeRpcMessage,
  parseRpcLine,
} from "../pty-worker/remote-executor-contract.js";

function createDeferred() {
  let resolve = null;
  let reject = null;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createSerialMessageQueue() {
  let queue = Promise.resolve();
  return (handler, onError) => {
    queue = queue
      .then(handler)
      .catch(onError);
  };
}

function expandHomePath(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    return null;
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (normalized === "~") {
    return homeDir || normalized;
  }
  if (normalized.startsWith("~/")) {
    return homeDir ? path.join(homeDir, normalized.slice(2)) : normalized;
  }

  return normalized;
}

function normalizeInputItems(input = []) {
  return (Array.isArray(input) ? input : []).map((item) => {
    if (item?.type !== "localImage" || !item.path) {
      return item;
    }

    return {
      ...item,
      path: expandHomePath(item.path),
    };
  });
}

export function buildRunCodexTaskArgs(params = {}) {
  return {
    codexBinPath: params.codexBinPath,
    cwd: expandHomePath(params.cwd),
    prompt: params.prompt,
    baseInstructions: params.baseInstructions ?? null,
    imagePaths: normalizeInputItems(
      Array.isArray(params.imagePaths)
        ? params.imagePaths.map((imagePath) => ({
            type: "localImage",
            path: imagePath,
          }))
        : [],
    )
      .map((item) => item.path)
      .filter(Boolean),
    sessionKey: params.sessionKey ?? null,
    sessionThreadId: params.sessionThreadId ?? null,
    providerSessionId: params.providerSessionId ?? null,
    knownRolloutPath: expandHomePath(params.knownRolloutPath ?? null),
    skipThreadHistoryLookup: params.skipThreadHistoryLookup === true,
    model: params.model ?? null,
    reasoningEffort: params.reasoningEffort ?? null,
    contextWindow: params.contextWindow ?? null,
    autoCompactTokenLimit: params.autoCompactTokenLimit ?? null,
  };
}

async function writeMessage(stream, message) {
  if (!stream || stream.destroyed || stream.writableEnded) {
    throw new Error("Remote executor stdout is closed");
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

async function main() {
  if (!process.argv.includes("--stdio-jsonrpc")) {
    throw new Error("host-executor requires --stdio-jsonrpc");
  }

  const stdout = process.stdout;
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  const pendingRequests = new Map();
  let nextRequestId = 1;
  let controller = null;
  let finishing = false;
  const enqueueInputLine = createSerialMessageQueue();

  const sendRequest = async (method, params) => {
    const id = `h${nextRequestId++}`;
    const deferred = createDeferred();
    pendingRequests.set(id, deferred);
    try {
      await writeMessage(stdout, buildRpcRequest(id, method, params));
    } catch (error) {
      pendingRequests.delete(id);
      throw error;
    }
    return deferred.promise;
  };

  const notifyFinished = async (result) => {
    if (finishing) {
      return;
    }

    finishing = true;
    try {
      await sendRequest("finished", { result });
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  const notifyFailed = async (error) => {
    if (finishing) {
      return;
    }

    finishing = true;
    try {
      await sendRequest("failed", {
        error: {
          message: error?.message || "Remote executor failed",
          code: Number.isFinite(error?.code) ? error.code : null,
          data: error?.data ?? null,
        },
      });
    } finally {
      process.exit(1);
    }
  };

  const handleRequest = async (message) => {
    switch (message.method) {
      case "startRun": {
        if (controller) {
          throw new Error("Remote executor already has an active run");
        }

        controller = runCodexTask({
          ...buildRunCodexTaskArgs(message.params),
          onRuntimeState: (payload) => sendRequest("onRuntimeState", payload),
          onEvent: (summary) => sendRequest("onEvent", { summary }),
        });
        controller.finished
          .then((result) => notifyFinished(result))
          .catch((error) => notifyFailed(error));
        return {
          started: true,
        };
      }
      case "steer":
        if (!controller) {
          return {
            ok: false,
            reason: "not-started",
          };
        }
        return controller.steer({
          input: normalizeInputItems(message.params?.input),
        });
      case "interrupt":
        if (!controller) {
          return false;
        }
        return controller.interrupt({
          threadId: message.params?.threadId,
          turnId: message.params?.turnId,
        });
      default:
        throw new Error(`Unknown remote executor method: ${message.method}`);
    }
  };

  process.stdin.on("end", () => {
    if (!controller || finishing) {
      return;
    }
    void controller.interrupt({}).catch(() => {});
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (!controller || finishing) {
        process.exit(0);
        return;
      }
      void controller.interrupt({}).catch(() => {}).finally(() => {
        process.exit(0);
      });
    });
  }

  input.on("line", (line) => {
    enqueueInputLine(
      async () => {
        const message = parseRpcLine(line);
        if (!message) {
          return;
        }

        if (message.method && message.id !== undefined) {
          try {
            const result = await handleRequest(message);
            await writeMessage(stdout, buildRpcResult(message.id, result));
          } catch (error) {
            await writeMessage(
              stdout,
              buildRpcError(
                message.id,
                error,
                `Remote executor method failed: ${message.method}`,
              ),
            );
          }
          return;
        }

        const pending = pendingRequests.get(message.id);
        if (!pending) {
          return;
        }

        pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(
            createRpcError(message.error, "Remote executor callback failed"),
          );
          return;
        }

        pending.resolve(message.result ?? null);
      },
      (error) => {
        void notifyFailed(error);
      },
    );
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
