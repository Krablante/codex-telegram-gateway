import {
  createErrorFromJsonRpc,
  safeJsonParse,
} from "./codex-runner-common.js";

const STARTUP_OUTPUT_TAIL_LINES = 20;

function rememberStartupOutput(lines, streamName, line) {
  const normalized = String(line ?? "").trimEnd();
  if (!normalized) {
    return;
  }

  lines.push(`[${streamName}] ${normalized}`);
  if (lines.length > STARTUP_OUTPUT_TAIL_LINES) {
    lines.shift();
  }
}

function appendStartupOutput(message, lines) {
  if (lines.length === 0) {
    return message;
  }

  return `${message}\nRecent Codex app-server output:\n${lines.join("\n")}`;
}

export function waitForListenUrl(
  stdoutReader,
  stderrReader,
  child,
  { timeoutMs } = {},
) {
  return new Promise((resolve, reject) => {
    const startupOutput = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          appendStartupOutput(
            "Timed out waiting for Codex app-server to start",
            startupOutput,
          ),
        ),
      );
    }, timeoutMs);

    const onLine = (streamName, line) => {
      rememberStartupOutput(startupOutput, streamName, line);
      const match = String(line || "").match(/listening on:\s*(\S+)/iu);
      if (!match) {
        return;
      }

      cleanup();
      resolve(match[1]);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onClose = (code, signal) => {
      cleanup();
      const message = code === 0 && !signal
        ? "Codex app-server ended before startup"
        : `Codex app-server exited before startup (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      reject(
        new Error(
          appendStartupOutput(
            message,
            startupOutput,
          ),
        ),
      );
    };

    const cleanup = () => {
      clearTimeout(timer);
      stdoutReader.off("line", onStdoutLine);
      stderrReader.off("line", onStderrLine);
      child.off("error", onError);
      child.off("close", onClose);
    };

    const onStdoutLine = (line) => {
      onLine("stdout", line);
    };
    const onStderrLine = (line) => {
      onLine("stderr", line);
    };

    stdoutReader.on("line", onStdoutLine);
    stderrReader.on("line", onStderrLine);
    child.on("error", onError);
    child.on("close", onClose);
  });
}

export function openWebSocket(listenUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(listenUrl);
    let settled = false;

    const cleanup = () => {
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
    };

    ws.onopen = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(ws);
    };

    ws.onerror = () => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error(`Failed to connect to Codex app-server at ${listenUrl}`));
    };

    ws.onclose = (event) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(
        new Error(
          `Codex app-server closed before connection completed (code=${event.code})`,
        ),
      );
    };
  });
}

export function createJsonRpcClient(ws, { onNotification, onDisconnect }) {
  let nextId = 1;
  const pending = new Map();

  const settlePending = (error) => {
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
  };

  ws.onmessage = (event) => {
    const raw = typeof event.data === "string" ? event.data : event.data.toString();
    const message = safeJsonParse(raw);
    if (!message) {
      return;
    }

    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) {
        return;
      }

      pending.delete(message.id);
      if (message.error) {
        entry.reject(
          createErrorFromJsonRpc(message.error, `Codex request ${entry.method} failed`),
        );
        return;
      }

      entry.resolve(message.result);
      return;
    }

    if (message.method) {
      onNotification?.(message);
    }
  };

  ws.onclose = (event) => {
    const error = new Error(
      `Codex app-server websocket closed (code=${event.code}, clean=${event.wasClean})`,
    );
    settlePending(error);
    onDisconnect?.(error);
  };

  ws.onerror = () => {};

  return {
    request(method, params = {}, { timeoutMs = 0 } = {}) {
      const id = nextId;
      nextId += 1;

      return new Promise((resolve, reject) => {
        let timer = null;
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Codex request ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }
        pending.set(id, {
          method,
          resolve(value) {
            if (timer) {
              clearTimeout(timer);
            }
            resolve(value);
          },
          reject(error) {
            if (timer) {
              clearTimeout(timer);
            }
            reject(error);
          },
        });
        try {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
          }));
        } catch (error) {
          if (timer) {
            clearTimeout(timer);
          }
          pending.delete(id);
          reject(error);
        }
      });
    },

    notify(method, params = undefined) {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method,
          ...(params === undefined ? {} : { params }),
        }),
      );
    },

    close() {
      try {
        ws.close();
      } catch {}
    },
  };
}
