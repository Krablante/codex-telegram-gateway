import { createHash } from "node:crypto";
import http from "node:http";

const LOOPBACK_HOST = "127.0.0.1";
const PORT_RANGE_START = 39000;
const PORT_RANGE_SIZE = 20000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_BIND_ATTEMPTS = 16;

function buildSeed(parts = []) {
  return parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(":");
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function normalizePathSegment(value, fallback) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || fallback;
}

function parseEndpoint(endpoint) {
  const url = new URL(String(endpoint ?? ""));
  if (url.protocol !== "http:") {
    throw new Error(`Unsupported IPC protocol for ${endpoint}`);
  }
  if (url.hostname !== LOOPBACK_HOST && url.hostname !== "localhost") {
    throw new Error(`IPC endpoint must bind to loopback: ${endpoint}`);
  }
  if (!url.port) {
    throw new Error(`IPC endpoint must include a port: ${endpoint}`);
  }
  if (!url.pathname || url.pathname === "/") {
    throw new Error(`IPC endpoint must include a tokenized path: ${endpoint}`);
  }
  return url;
}

function formatEndpoint(url) {
  return `http://${url.hostname}:${url.port}${url.pathname}`;
}

function buildRetryUrl(url, attempt) {
  const next = new URL(url.toString());
  const basePort = Number(url.port);
  const nextPort =
    PORT_RANGE_START
    + ((basePort - PORT_RANGE_START + attempt) % PORT_RANGE_SIZE);
  next.port = String(nextPort);
  return next;
}

function writeJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

export function buildLoopbackIpcEndpoint({
  namespace,
  channel,
  generationId,
  host = LOOPBACK_HOST,
} = {}) {
  const scope = normalizePathSegment(channel, "ipc");
  const seed = buildSeed([namespace, scope, generationId]);
  const hash = hashText(seed);
  const portOffset = Number.parseInt(hash.slice(0, 8), 16) % PORT_RANGE_SIZE;
  const port = PORT_RANGE_START + portOffset;
  const token = hashText(`${seed}:token`).slice(0, 32);
  return `http://${host}:${port}/ipc/${scope}/${token}`;
}

export class LoopbackJsonServer {
  constructor({
    endpoint,
    onRequest,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  }) {
    if (typeof onRequest !== "function") {
      throw new Error("LoopbackJsonServer requires onRequest");
    }
    this.endpoint = endpoint;
    this.onRequest = onRequest;
    this.maxBodyBytes = maxBodyBytes;
    this.server = null;
    this.url = parseEndpoint(endpoint);
  }

  async start() {
    if (this.server) {
      return;
    }

    let lastError = null;
    for (let attempt = 0; attempt < DEFAULT_BIND_ATTEMPTS; attempt += 1) {
      const listenUrl =
        attempt === 0 ? this.url : buildRetryUrl(this.url, attempt);
      const expectedPath = listenUrl.pathname;
      const server = http.createServer((req, res) => {
        if (req.method !== "POST" || req.url !== expectedPath) {
          writeJson(res, 404, {
            ok: false,
            error: "IPC endpoint not found",
          });
          return;
        }

        let body = "";
        let bodyBytes = 0;
        let aborted = false;

        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          if (aborted) {
            return;
          }

          bodyBytes += Buffer.byteLength(chunk);
          if (bodyBytes > this.maxBodyBytes) {
            aborted = true;
            writeJson(res, 413, {
              ok: false,
              error: "IPC request body too large",
            });
            req.destroy();
            return;
          }

          body += chunk;
        });

        req.on("end", async () => {
          if (aborted) {
            return;
          }

          try {
            const payload = body.trim() ? JSON.parse(body) : null;
            const result = await this.onRequest(payload);
            writeJson(res, 200, result ?? null);
          } catch (error) {
            writeJson(res, 500, {
              ok: false,
              error: error?.message || "IPC request failed",
            });
          }
        });

        req.on("error", () => {
          if (!res.headersSent) {
            writeJson(res, 500, {
              ok: false,
              error: "IPC request stream failed",
            });
          }
        });
      });

      try {
        await new Promise((resolve, reject) => {
          const handleError = (error) => {
            server.off("listening", handleListening);
            reject(error);
          };
          const handleListening = () => {
            server.off("error", handleError);
            resolve();
          };
          server.once("error", handleError);
          server.once("listening", handleListening);
          server.listen(Number(listenUrl.port), listenUrl.hostname);
        });
        this.server = server;
        this.url = listenUrl;
        this.endpoint = formatEndpoint(listenUrl);
        return;
      } catch (error) {
        lastError = error;
        server.close();
        if (error?.code !== "EADDRINUSE") {
          throw error;
        }
      }
    }

    throw lastError || new Error("Loopback IPC server did not become ready");
  }

  async stop() {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  }
}

export async function postLoopbackJson({
  endpoint,
  payload,
  timeoutMs = 5000,
}) {
  const url = parseEndpoint(endpoint);
  const body = JSON.stringify(payload ?? null);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const request = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          finish(() => {
            try {
              resolve(raw.trim() ? JSON.parse(raw) : null);
            } catch (error) {
              reject(error);
            }
          });
        });
      },
    );

    const timer = setTimeout(() => {
      finish(() => reject(new Error("IPC request timed out")));
      request.destroy();
    }, timeoutMs);
    timer.unref?.();

    request.once("error", (error) => {
      finish(() => reject(error));
    });

    request.write(body);
    request.end();
  });
}
