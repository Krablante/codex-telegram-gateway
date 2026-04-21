import fs from "node:fs/promises";

import { quarantineCorruptFile, writeTextAtomic } from "../state/file-utils.js";
import { normalizeStoredSessionMeta } from "./session-store-meta.js";

export class CorruptSessionMetaError extends Error {
  constructor(filePath, cause = null) {
    super(`Corrupt session meta quarantined: ${filePath}`, cause ? { cause } : undefined);
    this.name = "CorruptSessionMetaError";
    this.code = "SESSION_META_CORRUPT";
    this.filePath = filePath;
  }
}

export function isCorruptSessionMetaError(error) {
  return error?.code === "SESSION_META_CORRUPT";
}

export function getCorruptSessionMetaMarkerPath(filePath) {
  return `${filePath}.quarantined`;
}

export async function hasCorruptSessionMetaMarker(filePath) {
  try {
    await fs.access(getCorruptSessionMetaMarkerPath(filePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

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
      await writeTextAtomic(
        getCorruptSessionMetaMarkerPath(filePath),
        `${JSON.stringify({
          schema_version: 1,
          reason: "corrupt-session-meta",
          quarantined_at: new Date().toISOString(),
        }, null, 2)}\n`,
      );
      throw new CorruptSessionMetaError(filePath, error);
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
