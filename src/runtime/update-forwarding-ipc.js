import crypto from "node:crypto";

import {
  buildLoopbackIpcEndpoint,
  LoopbackJsonServer,
  postLoopbackJson,
} from "./local-loopback-ipc.js";

function buildNamespace(stateRoot = "") {
  return crypto
    .createHash("sha1")
    .update(String(stateRoot))
    .digest("hex")
    .slice(0, 8);
}

export function buildForwardingEndpoint({
  stateRoot,
  serviceKind,
  generationId,
} = {}) {
  const namespace = buildNamespace(stateRoot);
  const safeServiceKind = String(serviceKind ?? "service");
  const safeGenerationId = String(generationId ?? "generation");
  return buildLoopbackIpcEndpoint({
    namespace,
    channel: `forward-${safeServiceKind}`,
    generationId: safeGenerationId,
  });
}

export class UpdateForwardingServer {
  constructor({ endpoint, onRequest, serverFactory }) {
    this.endpoint = endpoint;
    this.onRequest = onRequest;
    this.server = new LoopbackJsonServer({
      endpoint,
      onRequest: async (payload) => ({
        ok: true,
        result: await this.onRequest(payload),
      }),
      serverFactory,
    });
  }

  async start() {
    await this.server.start();
    this.endpoint = this.server.endpoint;
  }

  async stop() {
    await this.server.stop();
  }
}

export async function probeForwardingEndpoint({
  endpoint,
  generationId,
  instanceToken = null,
  timeoutMs = 1000,
}) {
  const response = await postLoopbackJson({
    endpoint,
    timeoutMs,
    payload: {
      type: "generation-probe",
    },
  });
  if (!response?.ok) {
    return false;
  }

  const result = response.result ?? null;
  if (result?.generation_id !== String(generationId ?? "")) {
    return false;
  }

  if (instanceToken && result?.instance_token !== String(instanceToken)) {
    return false;
  }

  return true;
}

export async function forwardUpdate({ endpoint, payload }) {
  const response = await postLoopbackJson({
    endpoint,
    payload,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "IPC forward failed");
  }
  return response.result ?? null;
}
