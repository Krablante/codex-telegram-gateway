import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import {
  buildForwardingEndpoint,
  forwardUpdate,
  probeForwardingEndpoint,
  UpdateForwardingServer,
} from "../src/runtime/update-forwarding-ipc.js";
import { LoopbackJsonServer } from "../src/runtime/local-loopback-ipc.js";

test("buildForwardingEndpoint returns a loopback HTTP endpoint", () => {
  const endpoint = buildForwardingEndpoint({
    stateRoot: "/tmp/codex-state",
    serviceKind: "spike",
    generationId: "gen-123",
  });

  const url = new URL(endpoint);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.match(url.pathname, /^\/ipc\/forward-spike\/[a-f0-9]{32}$/u);
});

test("UpdateForwardingServer forwards payloads over loopback HTTP", async () => {
  const generationId = `gen-${crypto.randomUUID()}`;
  const endpoint = buildForwardingEndpoint({
    stateRoot: "/tmp/codex-state",
    serviceKind: "spike",
    generationId,
  });
  const server = new UpdateForwardingServer({
    endpoint,
    onRequest: async (payload) => ({
      echoed: payload,
      handled: true,
    }),
  });

  await server.start();

  try {
    const response = await forwardUpdate({
      endpoint: server.endpoint,
      payload: {
        type: "spike-update",
        update: {
          update_id: 42,
        },
      },
    });

    assert.deepEqual(response, {
      echoed: {
        type: "spike-update",
        update: {
          update_id: 42,
        },
      },
      handled: true,
    });
  } finally {
    await server.stop();
  }
});

test("LoopbackJsonServer retries a blocked loopback port and binds the next candidate", async () => {
  const endpoint = "http://127.0.0.1:39000/ipc/forward-spike/retry-token";
  let listenCalls = 0;
  const server = new LoopbackJsonServer({
    endpoint,
    onRequest: async () => ({ ok: true }),
    serverFactory() {
      const server = new EventEmitter();
      server.listen = () => {
        listenCalls += 1;
        setImmediate(() => {
          if (listenCalls === 1) {
            const error = new Error("permission denied");
            error.code = "EACCES";
            server.emit("error", error);
            return;
          }

          server.emit("listening");
        });
      };
      server.close = (callback) => {
        callback?.();
      };
      return server;
    },
  });

  await server.start();

  try {
    assert.notEqual(server.endpoint, endpoint);
    const reboundUrl = new URL(server.endpoint);
    assert.equal(reboundUrl.port, "39001");
    assert.equal(listenCalls, 2);
  } finally {
    await server.stop();
  }
});

test("forwardUpdate surfaces remote handler failures", async () => {
  const generationId = `gen-${crypto.randomUUID()}`;
  const endpoint = buildForwardingEndpoint({
    stateRoot: "/tmp/codex-state",
    serviceKind: "spike",
    generationId,
  });
  const server = new UpdateForwardingServer({
    endpoint,
    onRequest: async () => {
      throw new Error("boom");
    },
  });

  await server.start();

  try {
    await assert.rejects(
      forwardUpdate({
        endpoint: server.endpoint,
        payload: {
          type: "spike-update",
        },
      }),
      /boom/u,
    );
  } finally {
    await server.stop();
  }
});

test("probeForwardingEndpoint verifies the generation identity over loopback IPC", async () => {
  const generationId = `gen-${crypto.randomUUID()}`;
  const instanceToken = crypto.randomUUID();
  const endpoint = buildForwardingEndpoint({
    stateRoot: "/tmp/codex-state",
    serviceKind: "spike",
    generationId,
  });
  const server = new UpdateForwardingServer({
    endpoint,
    onRequest: async (payload) => {
      if (payload?.type === "generation-probe") {
        return {
          generation_id: generationId,
          instance_token: instanceToken,
        };
      }

      throw new Error("unexpected payload");
    },
  });

  await server.start();

  try {
    assert.equal(
      await probeForwardingEndpoint({
        endpoint: server.endpoint,
        generationId,
        instanceToken,
      }),
      true,
    );
    assert.equal(
      await probeForwardingEndpoint({
        endpoint: server.endpoint,
        generationId,
        instanceToken: "wrong-token",
      }),
      false,
    );
  } finally {
    await server.stop();
  }
});
