function normalizeRpcError(error, fallbackMessage = "Remote executor request failed") {
  if (!error || typeof error !== "object") {
    return {
      message: fallbackMessage,
      code: null,
      data: null,
    };
  }

  return {
    message:
      typeof error.message === "string" && error.message.trim()
        ? error.message
        : fallbackMessage,
    code: Number.isFinite(error.code) ? error.code : null,
    data: error.data ?? null,
  };
}

export function encodeRpcMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

export function parseRpcLine(line) {
  const normalizedLine = String(line ?? "").trim();
  if (!normalizedLine) {
    return null;
  }

  return JSON.parse(normalizedLine);
}

export function buildRpcRequest(id, method, params = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };
}

export function buildRpcResult(id, result = {}) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

export function buildRpcError(id, error, fallbackMessage) {
  return {
    jsonrpc: "2.0",
    id,
    error: normalizeRpcError(error, fallbackMessage),
  };
}

export function createRpcError(error, fallbackMessage) {
  const normalized = normalizeRpcError(error, fallbackMessage);
  const wrapped = new Error(normalized.message);
  if (normalized.code !== null) {
    wrapped.code = normalized.code;
  }
  if (normalized.data !== null) {
    wrapped.data = normalized.data;
  }
  return wrapped;
}
