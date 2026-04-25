import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import {
  ensureFileMode,
  ensurePrivateDirectory,
  PRIVATE_FILE_MODE,
} from "../state/file-utils.js";
import { renderTelegramHtml } from "../transport/telegram-reply-normalizer.js";

const TELEGRAM_HTML_PARSE_MODE = "HTML";
const DEFAULT_RETRY_AFTER_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_AFTER_MAX_WAIT_MS = 30000;
const DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS = 120000;

class TelegramRetryAfterError extends Error {
  constructor(method, description, retryAfterSeconds) {
    super(`Telegram API ${method} failed: ${description}`);
    this.name = "TelegramRetryAfterError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

class TelegramFileDownloadTooLargeError extends Error {
  constructor({ filePath, sizeBytes, limitBytes }) {
    super(
      `Telegram file download exceeded ${limitBytes} byte limit: ${filePath}`,
    );
    this.name = "TelegramFileDownloadTooLargeError";
    this.filePath = filePath;
    this.sizeBytes = sizeBytes;
    this.limitBytes = limitBytes;
  }
}

function normalizeMaxDownloadBytes(maxBytes) {
  const value = Number(maxBytes);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function writeResponseBodyToPrivateFile(response, destinationPath, {
  maxBytes = null,
} = {}) {
  const normalizedMaxBytes = normalizeMaxDownloadBytes(maxBytes);
  await ensurePrivateDirectory(path.dirname(destinationPath));
  try {
    await fs.lstat(destinationPath);
    throw new Error(`Refusing to overwrite existing Telegram download path: ${destinationPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  if (!response.body?.[Symbol.asyncIterator]) {
    const fileBuffer = Buffer.from(await response.arrayBuffer());
    if (
      normalizedMaxBytes !== null
      && fileBuffer.length > normalizedMaxBytes
    ) {
      throw new TelegramFileDownloadTooLargeError({
        filePath: destinationPath,
        sizeBytes: fileBuffer.length,
        limitBytes: normalizedMaxBytes,
      });
    }
    await fs.writeFile(destinationPath, fileBuffer, {
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    await ensureFileMode(destinationPath, PRIVATE_FILE_MODE);
    return fileBuffer.length;
  }

  let sizeBytes = 0;
  let completed = false;
  const fileHandle = await fs.open(destinationPath, "wx", PRIVATE_FILE_MODE);
  try {
    await ensureFileMode(destinationPath, PRIVATE_FILE_MODE);
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += buffer.length;
      if (
        normalizedMaxBytes !== null
        && sizeBytes > normalizedMaxBytes
      ) {
        throw new TelegramFileDownloadTooLargeError({
          filePath: destinationPath,
          sizeBytes,
          limitBytes: normalizedMaxBytes,
        });
      }
      await fileHandle.write(buffer);
    }
    completed = true;
  } finally {
    await fileHandle.close();
    if (!completed) {
      await fs.rm(destinationPath, { force: true }).catch(() => {});
    }
  }

  await ensureFileMode(destinationPath, PRIVATE_FILE_MODE);
  return sizeBytes;
}

function parseRetryAfterSeconds(payload, description) {
  const structuredRetryAfter = Number(payload?.parameters?.retry_after);
  if (Number.isFinite(structuredRetryAfter) && structuredRetryAfter > 0) {
    return structuredRetryAfter;
  }

  const match = String(description || "").match(/retry after\s+(\d+)/iu);
  if (!match) {
    return null;
  }

  const parsedValue = Number(match[1]);
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : null;
}

function waitForAbortOrTimeout(timeoutMs, signal) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }

    let settled = false;
    const finish = (handler) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      handler();
    };

    const timer = setTimeout(() => finish(resolve), timeoutMs);
    const onAbort = () => finish(() => reject(signal.reason ?? new Error("Aborted")));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function executeWithRetry(
  operation,
  {
    signal,
    maxRetryAfterAttempts = DEFAULT_RETRY_AFTER_MAX_ATTEMPTS,
    maxRetryAfterTotalWaitMs = DEFAULT_RETRY_AFTER_MAX_WAIT_MS,
    waitForRetryDelay = waitForAbortOrTimeout,
  } = {},
) {
  let retryAttempts = 0;
  let accumulatedRetryWaitMs = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof TelegramRetryAfterError)) {
        throw error;
      }
      const retryWaitMs = error.retryAfterSeconds * 1000;
      retryAttempts += 1;

      if (
        retryAttempts > maxRetryAfterAttempts
        || accumulatedRetryWaitMs + retryWaitMs > maxRetryAfterTotalWaitMs
      ) {
        throw new Error(
          `${error.message} (exhausted retry_after budget after ${retryAttempts} attempt(s))`,
          { cause: error },
        );
      }

      accumulatedRetryWaitMs += retryWaitMs;
      await waitForRetryDelay(retryWaitMs, signal);
    }
  }
}

function resolveRetryOptions(defaults = {}, overrides = {}) {
  return {
    signal: overrides.signal,
    maxRetryAfterAttempts:
      overrides.maxRetryAfterAttempts ?? defaults.maxRetryAfterAttempts,
    maxRetryAfterTotalWaitMs:
      overrides.maxRetryAfterTotalWaitMs ?? defaults.maxRetryAfterTotalWaitMs,
    waitForRetryDelay:
      overrides.waitForRetryDelay ?? defaults.waitForRetryDelay,
  };
}

function withTelegramHtmlFormatting(method, params) {
  if (!params || typeof params !== "object" || typeof params.parse_mode === "string") {
    return params;
  }

  if (
    (method === "sendMessage" || method === "editMessageText")
    && typeof params.text === "string"
  ) {
    return {
      ...params,
      text: renderTelegramHtml(params.text),
      parse_mode: TELEGRAM_HTML_PARSE_MODE,
    };
  }

  if (
    (method === "sendDocument" || method === "sendPhoto")
    && typeof params.caption === "string"
  ) {
    return {
      ...params,
      caption: renderTelegramHtml(params.caption),
      parse_mode: TELEGRAM_HTML_PARSE_MODE,
    };
  }

  return params;
}

function buildMethodUrl(token, baseUrl, method) {
  return new URL(`/bot${token}/${method}`, baseUrl);
}

async function parseTelegramResponse(response, method) {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const description = payload?.description || response.statusText;
    const retryAfterSeconds = parseRetryAfterSeconds(payload, description);
    if (retryAfterSeconds) {
      throw new TelegramRetryAfterError(method, description, retryAfterSeconds);
    }
    throw new Error(`Telegram API ${method} failed: ${description}`);
  }

  return payload.result;
}

function appendFormValue(form, key, value) {
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value === "object" && !(value instanceof Blob)) {
    form.append(key, JSON.stringify(value));
    return;
  }

  form.append(key, String(value));
}

async function buildFileFormData(params, {
  fieldName,
  methodName,
  defaultContentType,
} = {}) {
  const formattedParams = withTelegramHtmlFormatting(methodName, params);
  if (!formattedParams?.[fieldName]) {
    throw new Error(`${methodName} requires a ${fieldName} payload`);
  }

  const form = new FormData();
  for (const [key, value] of Object.entries(formattedParams)) {
    if (key === fieldName) {
      continue;
    }

    appendFormValue(form, key, value);
  }

  if (typeof formattedParams[fieldName] === "string") {
    form.append(fieldName, formattedParams[fieldName]);
    return form;
  }

  const filePath = formattedParams[fieldName].filePath;
  if (!filePath) {
    throw new Error(
      `${methodName} requires ${fieldName}.filePath or ${fieldName} string`,
    );
  }

  const fileName =
    formattedParams[fieldName].fileName ||
    formattedParams[fieldName].filename ||
    path.basename(filePath);
  const blob = await openAsBlob(filePath, {
    type: formattedParams[fieldName].contentType || defaultContentType,
  });
  form.append(fieldName, blob, fileName);
  return form;
}

function createAbortSignalWithTimeout(signal, timeoutMs) {
  const normalizedTimeoutMs = Number(timeoutMs);
  if (!signal && (!Number.isFinite(normalizedTimeoutMs) || normalizedTimeoutMs <= 0)) {
    return {
      signal: undefined,
      cleanup() {},
    };
  }

  const controller = new AbortController();
  let timer = null;
  const abort = (reason) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };
  const onAbort = () => abort(signal.reason ?? new Error("Aborted"));

  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }

  if (Number.isFinite(normalizedTimeoutMs) && normalizedTimeoutMs > 0) {
    timer = setTimeout(() => {
      abort(new Error(`Telegram file download timed out after ${normalizedTimeoutMs} ms`));
    }, normalizedTimeoutMs);
    timer.unref?.();
  }

  return {
    signal: controller.signal,
    cleanup() {
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export class TelegramBotApiClient {
  constructor(options) {
    if (!options?.token) {
      throw new Error("TelegramBotApiClient requires a bot token");
    }

    this.token = options.token;
    this.baseUrl = options.baseUrl || "https://api.telegram.org";
    this.retryOptions = {
      maxRetryAfterAttempts: options.maxRetryAfterAttempts,
      maxRetryAfterTotalWaitMs: options.maxRetryAfterTotalWaitMs,
      waitForRetryDelay:
        typeof options.waitForRetryDelay === "function"
          ? options.waitForRetryDelay
          : undefined,
    };
  }

  async call(method, params = undefined, options = {}) {
    return executeWithRetry(async () => {
      const url = buildMethodUrl(this.token, this.baseUrl, method);
      const formattedParams = withTelegramHtmlFormatting(method, params);
      const hasParams = formattedParams && Object.keys(formattedParams).length > 0;
      const response = await fetch(url, {
        method: hasParams ? "POST" : "GET",
        headers: hasParams ? { "content-type": "application/json" } : undefined,
        body: hasParams ? JSON.stringify(formattedParams) : undefined,
        signal: options.signal,
      });

      return parseTelegramResponse(response, method);
    }, resolveRetryOptions(this.retryOptions, options));
  }

  async callMultipart(method, buildBody, options = {}) {
    return executeWithRetry(async () => {
      const body = typeof buildBody === "function" ? await buildBody() : buildBody;
      const response = await fetch(buildMethodUrl(this.token, this.baseUrl, method), {
        method: "POST",
        body,
        signal: options.signal,
      });

      return parseTelegramResponse(response, method);
    }, resolveRetryOptions(this.retryOptions, options));
  }

  async getWebhookInfo(options = {}) {
    return this.call("getWebhookInfo", undefined, options);
  }

  async deleteWebhook(params = {}, options = {}) {
    return this.call("deleteWebhook", params, options);
  }

  async getUpdates(params = {}, options = {}) {
    return this.call("getUpdates", params, options);
  }

  async getMyCommands(params = {}, options = {}) {
    return this.call("getMyCommands", params, options);
  }

  async setMyCommands(params, options = {}) {
    return this.call("setMyCommands", params, options);
  }

  async deleteMyCommands(params = {}, options = {}) {
    return this.call("deleteMyCommands", params, options);
  }

  async getFile(params, options = {}) {
    return this.call("getFile", params, options);
  }

  async sendMessage(params, options = {}) {
    return this.call("sendMessage", params, options);
  }

  async answerCallbackQuery(params, options = {}) {
    return this.call("answerCallbackQuery", params, options);
  }

  async editMessageText(params, options = {}) {
    return this.call("editMessageText", params, options);
  }

  async sendChatAction(params, options = {}) {
    return this.call("sendChatAction", params, options);
  }

  async deleteMessage(params, options = {}) {
    return this.call("deleteMessage", params, options);
  }

  async deleteMessages(params, options = {}) {
    return this.call("deleteMessages", params, options);
  }

  async pinChatMessage(params, options = {}) {
    return this.call("pinChatMessage", params, options);
  }

  async sendDocument(params, options = {}) {
    return this.callMultipart(
      "sendDocument",
      () => buildFileFormData(params, {
        fieldName: "document",
        methodName: "sendDocument",
        defaultContentType: "application/octet-stream",
      }),
      options,
    );
  }

  async sendPhoto(params, options = {}) {
    return this.callMultipart(
      "sendPhoto",
      () => buildFileFormData(params, {
        fieldName: "photo",
        methodName: "sendPhoto",
        defaultContentType: "image/png",
      }),
      options,
    );
  }

  async createForumTopic(params, options = {}) {
    return this.call("createForumTopic", params, options);
  }

  async editForumTopic(params, options = {}) {
    return this.call("editForumTopic", params, options);
  }

  async closeForumTopic(params, options = {}) {
    return this.call("closeForumTopic", params, options);
  }

  async reopenForumTopic(params, options = {}) {
    return this.call("reopenForumTopic", params, options);
  }

  async deleteForumTopic(params, options = {}) {
    return this.call("deleteForumTopic", params, options);
  }

  async downloadFile(filePath, destinationPath, options = {}) {
    const normalizedPath = String(filePath || "").replace(/^\/+/u, "");
    const downloadSignal = createAbortSignalWithTimeout(
      options.signal,
      options.timeoutMs ?? DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS,
    );
    try {
      const response = await fetch(
        new URL(`/file/bot${this.token}/${normalizedPath}`, this.baseUrl),
        {
          method: "GET",
          signal: downloadSignal.signal,
        },
      );

      if (!response.ok) {
        throw new Error(
          `Telegram file download failed: ${response.status} ${response.statusText}`,
        );
      }

      const sizeBytes = await writeResponseBodyToPrivateFile(
        response,
        destinationPath,
        { maxBytes: options.maxBytes },
      );
      return {
        filePath: destinationPath,
        sizeBytes,
      };
    } finally {
      downloadSignal.cleanup();
    }
  }
}
