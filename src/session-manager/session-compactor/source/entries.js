import {
  BOUNDED_ENTRY_FIELD_MAX_BYTES,
  BOUNDED_PROGRESS_NOTE_MAX_BYTES,
  BOUNDED_RECENT_PROGRESS_MAX_BYTES,
  BOUNDED_RECENT_PROGRESS_TARGET_NOTES,
} from "./limits.js";
import {
  getUtf8ByteLength,
  truncateTextMiddleToUtf8Bytes,
  truncateTextToUtf8Bytes,
} from "./utf8.js";

function getFenceForText(text) {
  const runs = String(text || "").match(/`+/gu) || [];
  const longestRun = runs.reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

function buildFencedTextBlock(text) {
  const normalized = String(text || "");
  const fence = getFenceForText(normalized);
  return [
    `${fence}text`,
    normalized || "(empty)",
    fence,
  ];
}

export function buildBoundedExchangeEntry(entry, index, totalEntries) {
  const userPrompt = truncateTextMiddleToUtf8Bytes(
    String(entry?.user_prompt || ""),
    BOUNDED_ENTRY_FIELD_MAX_BYTES,
  );
  const assistantReply = truncateTextMiddleToUtf8Bytes(
    String(entry?.assistant_reply || ""),
    BOUNDED_ENTRY_FIELD_MAX_BYTES,
  );

  return [
    `### Exchange ${index + 1} of ${totalEntries}`,
    `- created_at: ${entry?.created_at ?? "unknown"}`,
    `- status: ${entry?.status ?? "unknown"}`,
    "- user_prompt:",
    ...buildFencedTextBlock(userPrompt),
    "- assistant_reply:",
    ...buildFencedTextBlock(assistantReply),
  ].join("\n");
}

export function buildFullExchangeEntry(entry, index, totalEntries) {
  return [
    `### Exchange ${index + 1} of ${totalEntries}`,
    `- created_at: ${entry?.created_at ?? "unknown"}`,
    `- status: ${entry?.status ?? "unknown"}`,
    "- user_prompt:",
    ...buildFencedTextBlock(String(entry?.user_prompt || "")),
    "- assistant_reply:",
    ...buildFencedTextBlock(String(entry?.assistant_reply || "")),
  ].join("\n");
}

function buildBoundedProgressNote(entry, index, totalEntries) {
  const text = truncateTextToUtf8Bytes(
    String(entry?.text || ""),
    BOUNDED_PROGRESS_NOTE_MAX_BYTES,
  );

  return [
    `### Progress note ${index + 1} of ${totalEntries}`,
    `- created_at: ${entry?.created_at ?? "unknown"}`,
    `- source: ${entry?.source ?? "unknown"}`,
    `- thread_id: ${entry?.thread_id ?? "unknown"}`,
    ...buildFencedTextBlock(text),
  ].join("\n");
}

export function pushNewestBounded({
  items = [],
  maxBytes,
  serialize,
  targetCount,
}) {
  const boundedEntries = [];
  const selectedItems = [];
  let usedBytes = 0;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const serialized = serialize(item, index, items.length);
    const serializedWithGap = `${serialized}\n\n`;
    const serializedBytes = getUtf8ByteLength(serializedWithGap);
    if (serializedBytes > maxBytes - usedBytes) {
      if (boundedEntries.length === 0 && maxBytes > usedBytes) {
        const truncated = truncateTextToUtf8Bytes(serialized, maxBytes - usedBytes);
        boundedEntries.unshift(truncated);
        selectedItems.unshift(item);
        usedBytes += getUtf8ByteLength(truncated);
      }
      break;
    }

    boundedEntries.unshift(serialized);
    selectedItems.unshift(item);
    usedBytes += serializedBytes;
    if (boundedEntries.length >= targetCount) {
      break;
    }
  }

  return {
    entries: boundedEntries,
    selectedItems,
    usedBytes,
  };
}

export function pushOldestBounded({
  items = [],
  maxBytes,
  serialize,
  targetCount,
}) {
  const boundedEntries = [];
  const selectedItems = [];
  let usedBytes = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const serialized = serialize(item, index, items.length);
    const serializedWithGap = `${serialized}\n\n`;
    const serializedBytes = getUtf8ByteLength(serializedWithGap);
    if (serializedBytes > maxBytes - usedBytes) {
      if (boundedEntries.length === 0 && maxBytes > usedBytes) {
        const truncated = truncateTextMiddleToUtf8Bytes(
          serialized,
          maxBytes - usedBytes,
        );
        boundedEntries.push(truncated);
        selectedItems.push(item);
      }
      break;
    }

    boundedEntries.push(serialized);
    selectedItems.push(item);
    usedBytes += serializedBytes;
    if (boundedEntries.length >= targetCount) {
      break;
    }
  }

  return {
    entries: boundedEntries,
    selectedItems,
    usedBytes,
  };
}

export function buildBoundedProgressNotes(progressNotes = []) {
  return pushNewestBounded({
    items: progressNotes,
    maxBytes: BOUNDED_RECENT_PROGRESS_MAX_BYTES,
    serialize: buildBoundedProgressNote,
    targetCount: BOUNDED_RECENT_PROGRESS_TARGET_NOTES,
  }).entries;
}
