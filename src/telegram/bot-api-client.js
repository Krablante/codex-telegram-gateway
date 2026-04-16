import fs from "node:fs/promises";
import path from "node:path";
import { renderTelegramHtml } from "../transport/telegram-reply-normalizer.js";

const TELEGRAM_HTML_PARSE_MODE = "HTML";

class TelegramRetryAfterError extends Error {
  constructor(method, description, retryAfterSeconds) {
    super(`Telegram API ${method} failed: ${description}`);
    this.name = "TelegramRetryAfterError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
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

async function executeWithRetry(operation, { signal } = {}) {
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof TelegramRetryAfterError)) {
        throw error;
      }
      await waitForAbortOrTimeout(error.retryAfterSeconds * 1000, signal);
    }
  }
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
  const fileBuffer = await fs.readFile(filePath);
  const blob = new Blob([fileBuffer], {
    type: formattedParams[fieldName].contentType || defaultContentType,
  });
  form.append(fieldName, blob, fileName);
  return form;
}

export class TelegramBotApiClient {
  constructor(options) {
    if (!options?.token) {
      throw new Error("TelegramBotApiClient requires a bot token");
    }

    this.token = options.token;
    this.baseUrl = options.baseUrl || "https://api.telegram.org";
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
    }, {
      signal: options.signal,
    });
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
    }, {
      signal: options.signal,
    });
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
    const response = await fetch(
      new URL(`/file/bot${this.token}/${normalizedPath}`, this.baseUrl),
      {
        method: "GET",
        signal: options.signal,
      },
    );

    if (!response.ok) {
      throw new Error(
        `Telegram file download failed: ${response.status} ${response.statusText}`,
      );
    }

    const fileBuffer = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, fileBuffer);
    return {
      filePath: destinationPath,
      sizeBytes: fileBuffer.length,
    };
  }
}
