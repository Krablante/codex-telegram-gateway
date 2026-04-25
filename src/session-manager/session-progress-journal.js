import fs from "node:fs/promises";

import { appendTextFile } from "../state/file-utils.js";

const DEFAULT_PROGRESS_NOTE_LIMIT = 200;
const MAX_PROGRESS_NOTE_TEXT_CHARS = 4000;

function normalizeText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function truncateText(value, maxChars = MAX_PROGRESS_NOTE_TEXT_CHARS) {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(maxChars - 36, 0)).trimEnd()}\n\n[truncated for progress journal]`;
}

function normalizeProgressNoteEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const text = truncateText(entry.text);
  if (!text) {
    return null;
  }

  return {
    schema_version: 1,
    created_at: normalizeText(entry.created_at) || new Date().toISOString(),
    session_key: normalizeText(entry.session_key) || null,
    run_started_at: normalizeText(entry.run_started_at) || null,
    thread_id: normalizeText(entry.thread_id) || null,
    source: normalizeText(entry.source) || "agent_message",
    event_type: normalizeText(entry.event_type) || null,
    text,
  };
}

function clampLimit(limit) {
  if (limit === null || limit === "all") {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(limit)) {
    return DEFAULT_PROGRESS_NOTE_LIMIT;
  }
  const normalized = Math.trunc(limit);
  if (normalized <= 0) {
    return DEFAULT_PROGRESS_NOTE_LIMIT;
  }
  return Math.min(normalized, 1000);
}

export async function loadProgressNotes(store, meta, { limit = DEFAULT_PROGRESS_NOTE_LIMIT } = {}) {
  const current =
    (await store.load(meta.chat_id, meta.topic_id)) || meta;
  const filePath = store.getProgressNotesPath(current.chat_id, current.topic_id);
  const maxEntries = clampLimit(limit);

  try {
    const text = await fs.readFile(filePath, "utf8");
    const entries = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const normalized = normalizeProgressNoteEntry(JSON.parse(trimmed));
        if (normalized) {
          entries.push(normalized);
        }
      } catch {
        // Progress notes are recovery hints. A malformed line must not break session load/compact.
      }
    }
    return maxEntries === Number.POSITIVE_INFINITY
      ? entries
      : entries.slice(-maxEntries);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function appendProgressNoteEntry(store, meta, entry) {
  const current =
    (await store.load(meta.chat_id, meta.topic_id)) || meta;
  const normalized = normalizeProgressNoteEntry({
    ...entry,
    session_key: entry?.session_key || current.session_key,
  });
  if (!normalized) {
    return { session: current, entry: null };
  }

  const filePath = store.getProgressNotesPath(current.chat_id, current.topic_id);
  await appendTextFile(filePath, `${JSON.stringify(normalized)}\n`);

  return { session: current, entry: normalized };
}
