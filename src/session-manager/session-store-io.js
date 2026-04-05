import fs from "node:fs/promises";

import { quarantineCorruptFile } from "../state/file-utils.js";
import { normalizeStoredSessionMeta } from "./session-store-meta.js";

export async function readMetaJson(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return {
      ...normalizeStoredSessionMeta(parsed),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    if (error instanceof SyntaxError) {
      await quarantineCorruptFile(filePath);
      return null;
    }

    throw error;
  }
}

export async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export function buildArtifactFileName(kind, extension) {
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "");
  const safeKind = kind.replace(/[^a-z0-9-]+/giu, "-");
  return `${stamp}-${safeKind}.${extension}`;
}

export function normalizeExchangeLogEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const userPrompt =
    typeof entry.user_prompt === "string" && entry.user_prompt.trim()
      ? entry.user_prompt
      : null;
  const assistantReply =
    typeof entry.assistant_reply === "string" && entry.assistant_reply.trim()
      ? entry.assistant_reply
      : null;

  if (!userPrompt && !assistantReply) {
    return null;
  }

  return {
    schema_version: 1,
    created_at:
      typeof entry.created_at === "string" && entry.created_at.trim()
        ? entry.created_at
        : new Date().toISOString(),
    status:
      typeof entry.status === "string" && entry.status.trim()
        ? entry.status
        : "completed",
    user_prompt: userPrompt,
    assistant_reply: assistantReply,
  };
}
