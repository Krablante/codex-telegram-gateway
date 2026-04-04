import fs from "node:fs/promises";
import path from "node:path";
import { renderTelegramHtml } from "../transport/telegram-reply-normalizer.js";

const TELEGRAM_HTML_PARSE_MODE = "HTML";

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
  }

  async callMultipart(method, body, options = {}) {
    const response = await fetch(buildMethodUrl(this.token, this.baseUrl, method), {
      method: "POST",
      body,
      signal: options.signal,
    });

    return parseTelegramResponse(response, method);
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
      await buildFileFormData(params, {
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
      await buildFileFormData(params, {
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
