import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = [];
  child.pid = null;
  child.kill = (signal = "SIGTERM") => {
    child.killCalls.push(signal);
    if (child.exitCode !== null || child.signalCode !== null) {
      return true;
    }

    child.signalCode = signal;
    setImmediate(() => {
      child.emit("close", null, signal);
    });
    return true;
  };
  return child;
}

export function createStandardRequestHandlers({
  threadId = "root-thread",
  turnId = "root-turn",
  onTurnSteer = null,
} = {}) {
  const handlers = {
    initialize() {
      return { ok: true };
    },
    "thread/start"() {
      return {
        thread: {
          id: threadId,
        },
      };
    },
    "thread/resume"() {
      return {
        thread: {
          id: threadId,
        },
      };
    },
    "turn/start"() {
      return {
        turn: {
          id: turnId,
        },
      };
    },
  };

  if (typeof onTurnSteer === "function") {
    handlers["turn/steer"] = onTurnSteer;
  }

  return handlers;
}

export function createMockWebSocket({
  requestHandlers = {},
} = {}) {
  return {
    onmessage: null,
    onclose: null,
    onerror: null,
    closed: false,
    sentMessages: [],
    send(raw) {
      if (this.closed) {
        throw new Error("websocket closed");
      }
      const message = JSON.parse(raw);
      this.sentMessages.push(message);
      if (message.id === undefined) {
        return;
      }

      const handler = requestHandlers[message.method];
      Promise.resolve()
        .then(() => handler ? handler(message.params, message) : {})
        .then((result) => {
          this.onmessage?.({
            data: JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result,
            }),
          });
        })
        .catch((error) => {
          this.onmessage?.({
            data: JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: {
                message: error.message,
              },
            }),
          });
        });
    },
    close() {
      this.closed = true;
      this.onclose?.({
        code: 1000,
        wasClean: true,
      });
    },
    emitNotification(message) {
      this.onmessage?.({
        data: JSON.stringify(message),
      });
    },
    emitClose({ code = 1006, wasClean = false } = {}) {
      this.closed = true;
      this.onclose?.({ code, wasClean });
    },
  };
}

export async function waitForCondition(
  predicate,
  { timeoutMs = 1000, intervalMs = 5 } = {},
) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function emitListenBanner(child, port) {
  child.stderr.write(`  listening on: ws://127.0.0.1:${port}\n`);
}
