import {
  BOUNDED_ACTIVE_BRIEF_MAX_BYTES,
  BOUNDED_CHRONOLOGY_CHECKPOINT_MAX_BYTES,
  BOUNDED_CHRONOLOGY_CHECKPOINT_TARGET_ENTRIES,
  BOUNDED_HIGH_SIGNAL_EXCHANGE_MAX_BYTES,
  BOUNDED_HIGH_SIGNAL_TARGET_ENTRIES,
  BOUNDED_RECENT_EXCHANGE_MAX_BYTES,
  BOUNDED_RECENT_EXCHANGE_TARGET_ENTRIES,
  HIGH_SIGNAL_EXCHANGE_RE,
} from "./limits.js";
import {
  buildBoundedExchangeEntry,
  buildBoundedProgressNotes,
  buildFullExchangeEntry,
  pushNewestBounded,
  pushOldestBounded,
} from "./entries.js";
import { truncateTextMiddleToUtf8Bytes } from "./utf8.js";

function isHighSignalExchange(entry) {
  return HIGH_SIGNAL_EXCHANGE_RE.test(String(entry?.user_prompt || ""))
    || HIGH_SIGNAL_EXCHANGE_RE.test(String(entry?.assistant_reply || ""));
}

function buildOlderHighSignalExchangeSelection(exchangeLog, recentExchangeEntries) {
  const recentStartIndex = Math.max(exchangeLog.length - recentExchangeEntries, 0);
  const olderHighSignalEntries = exchangeLog
    .slice(0, recentStartIndex)
    .map((entry, index) => ({
      entry,
      index,
      totalEntries: exchangeLog.length,
    }))
    .filter(({ entry }) => isHighSignalExchange(entry));

  const selection = pushNewestBounded({
    items: olderHighSignalEntries,
    maxBytes: BOUNDED_HIGH_SIGNAL_EXCHANGE_MAX_BYTES,
    serialize: ({ entry, index, totalEntries }) =>
      buildBoundedExchangeEntry(entry, index, totalEntries),
    targetCount: BOUNDED_HIGH_SIGNAL_TARGET_ENTRIES,
  });

  return {
    entries: selection.entries,
    indexes: selection.selectedItems.map(({ index }) => index),
  };
}

function pickChronologyCheckpointIndexes(olderEntryCount) {
  if (olderEntryCount <= 0) {
    return [];
  }

  const anchors = [
    0,
    1,
    Math.floor(olderEntryCount * 0.25),
    Math.floor(olderEntryCount * 0.5),
    Math.floor(olderEntryCount * 0.75),
    olderEntryCount - 2,
    olderEntryCount - 1,
  ];
  return [...new Set(
    anchors.filter((index) => index >= 0 && index < olderEntryCount),
  )].sort((left, right) => left - right);
}

function buildOlderChronologyCheckpointSelection({
  activeBrief,
  excludedIndexes = new Set(),
  exchangeLog,
  recentExchangeEntries,
}) {
  if (String(activeBrief || "").trim()) {
    return {
      entries: [],
      indexes: [],
    };
  }

  const recentStartIndex = Math.max(exchangeLog.length - recentExchangeEntries, 0);
  const checkpointIndexes = pickChronologyCheckpointIndexes(recentStartIndex)
    .filter((index) => !excludedIndexes.has(index));
  const checkpoints = checkpointIndexes.map((index) => ({
    entry: exchangeLog[index],
    index,
    totalEntries: exchangeLog.length,
  }));

  const selection = pushOldestBounded({
    items: checkpoints,
    maxBytes: BOUNDED_CHRONOLOGY_CHECKPOINT_MAX_BYTES,
    serialize: ({ entry, index, totalEntries }) =>
      buildBoundedExchangeEntry(entry, index, totalEntries),
    targetCount: BOUNDED_CHRONOLOGY_CHECKPOINT_TARGET_ENTRIES,
  });

  return {
    entries: selection.entries,
    indexes: selection.selectedItems.map(({ index }) => index),
  };
}

function buildRecentExchangeIndexSet(exchangeLog, recentExchangeEntries) {
  const indexes = new Set();
  const recentStartIndex = Math.max(exchangeLog.length - recentExchangeEntries, 0);
  for (let index = recentStartIndex; index < exchangeLog.length; index += 1) {
    indexes.add(index);
  }
  return indexes;
}

function countOmittedExchangeEntries({
  exchangeLog,
  recentExchangeEntries,
  highSignalIndexes,
  chronologyCheckpointIndexes,
}) {
  const includedIndexes = buildRecentExchangeIndexSet(
    exchangeLog,
    recentExchangeEntries,
  );
  for (const index of highSignalIndexes) {
    includedIndexes.add(index);
  }
  for (const index of chronologyCheckpointIndexes) {
    includedIndexes.add(index);
  }
  return Math.max(exchangeLog.length - includedIndexes.size, 0);
}

export function buildFullCompactionSource({
  activeBrief,
  exchangeLog,
  progressNotes = [],
  reason,
  session,
}) {
  const boundedBrief = truncateTextMiddleToUtf8Bytes(
    String(activeBrief || "").trim(),
    BOUNDED_ACTIVE_BRIEF_MAX_BYTES,
  );
  const boundedProgressNotes = buildBoundedProgressNotes(progressNotes);
  const omittedProgressNotes = Math.max(
    progressNotes.length - boundedProgressNotes.length,
    0,
  );
  const fullExchangeEntries = exchangeLog.map((entry, index) =>
    buildFullExchangeEntry(entry, index, exchangeLog.length));
  const lines = [
    "# Compaction source",
    "",
    "This source keeps the full exchange log because it is still small enough to summarize safely, while also adding pending natural-language progress notes.",
    "",
    "Session metadata:",
    `- session_key: ${session.session_key}`,
    `- topic_name: ${session.topic_name ?? "unknown"}`,
    `- cwd: ${session.workspace_binding.cwd}`,
    `- reason: ${reason}`,
    `- exchange_log_entries_total: ${exchangeLog.length}`,
    `- full_exchange_entries_included: ${fullExchangeEntries.length}`,
    `- progress_notes_total: ${progressNotes.length}`,
    `- recent_progress_notes_included: ${boundedProgressNotes.length}`,
    `- older_progress_notes_omitted: ${omittedProgressNotes}`,
    "",
    "## Previous active brief",
  ];

  if (boundedBrief) {
    lines.push(boundedBrief, "");
  } else {
    lines.push("- no previous active brief available", "");
  }

  lines.push("## Recent natural-language progress notes");
  if (boundedProgressNotes.length === 0) {
    lines.push("- no progress notes available", "");
  } else {
    lines.push(...boundedProgressNotes, "");
  }

  lines.push("## Full exchange log");
  if (fullExchangeEntries.length === 0) {
    lines.push("- no exchange log entries available");
  } else {
    lines.push(...fullExchangeEntries);
  }

  return {
    content: `${lines.join("\n")}\n`,
    recentProgressNotes: boundedProgressNotes.length,
    omittedProgressNotes,
    fullExchangeEntries: fullExchangeEntries.length,
  };
}

export function buildBoundedCompactionSource({
  activeBrief,
  exchangeLog,
  progressNotes = [],
  reason,
  session,
}) {
  const boundedRecentSelection = pushNewestBounded({
    items: exchangeLog,
    maxBytes: BOUNDED_RECENT_EXCHANGE_MAX_BYTES,
    serialize: buildBoundedExchangeEntry,
    targetCount: BOUNDED_RECENT_EXCHANGE_TARGET_ENTRIES,
  });
  const boundedEntries = boundedRecentSelection.entries;

  const boundedBrief = truncateTextMiddleToUtf8Bytes(
    String(activeBrief || "").trim(),
    BOUNDED_ACTIVE_BRIEF_MAX_BYTES,
  );
  const highSignalSelection = buildOlderHighSignalExchangeSelection(
    exchangeLog,
    boundedEntries.length,
  );
  const chronologyCheckpointSelection = buildOlderChronologyCheckpointSelection({
    activeBrief,
    excludedIndexes: new Set(highSignalSelection.indexes),
    exchangeLog,
    recentExchangeEntries: boundedEntries.length,
  });
  const highSignalEntries = highSignalSelection.entries;
  const chronologyCheckpointEntries = chronologyCheckpointSelection.entries;
  const boundedProgressNotes = buildBoundedProgressNotes(progressNotes);
  const omittedExchangeEntries = countOmittedExchangeEntries({
    exchangeLog,
    recentExchangeEntries: boundedEntries.length,
    highSignalIndexes: highSignalSelection.indexes,
    chronologyCheckpointIndexes: chronologyCheckpointSelection.indexes,
  });
  const omittedProgressNotes = Math.max(
    progressNotes.length - boundedProgressNotes.length,
    0,
  );
  const lines = [
    "# Compaction source",
    "",
    "This bounded source exists so active-brief.md can be regenerated without rereading an oversized full exchange log.",
    "",
    "Session metadata:",
    `- session_key: ${session.session_key}`,
    `- topic_name: ${session.topic_name ?? "unknown"}`,
    `- cwd: ${session.workspace_binding.cwd}`,
    `- reason: ${reason}`,
    `- exchange_log_entries_total: ${exchangeLog.length}`,
    `- recent_exchange_entries_included: ${boundedEntries.length}`,
    `- older_exchange_entries_omitted: ${omittedExchangeEntries}`,
    `- older_high_signal_exchange_entries_included: ${highSignalEntries.length}`,
    `- older_chronology_checkpoint_entries_included: ${chronologyCheckpointEntries.length}`,
    `- progress_notes_total: ${progressNotes.length}`,
    `- recent_progress_notes_included: ${boundedProgressNotes.length}`,
    `- older_progress_notes_omitted: ${omittedProgressNotes}`,
    "",
    "## Previous active brief",
  ];

  if (boundedBrief) {
    lines.push(boundedBrief, "");
  } else {
    lines.push("- no previous active brief available", "");
  }

  lines.push("## Recent natural-language progress notes");
  if (boundedProgressNotes.length === 0) {
    lines.push("- no progress notes available", "");
  } else {
    lines.push(...boundedProgressNotes, "");
  }

  lines.push("## Older high-signal continuity excerpts");
  if (highSignalEntries.length === 0) {
    lines.push("- no older high-signal exchange excerpts selected", "");
  } else {
    lines.push(
      "These older excerpts matched durable-rule/preference language. Keep them only if still current after the recent slice.",
      "",
      ...highSignalEntries,
      "",
    );
  }

  lines.push("## Older chronology checkpoints");
  if (chronologyCheckpointEntries.length === 0) {
    lines.push("- no older chronology checkpoints selected", "");
  } else {
    lines.push(
      "These sparse older checkpoints preserve first-time oversized-session chronology when no previous active brief exists. Use newer facts from the recent slice when they supersede a checkpoint.",
      "",
      ...chronologyCheckpointEntries,
      "",
    );
  }

  lines.push("## Recent exchange log slice");
  if (boundedEntries.length === 0) {
    lines.push("- no exchange log entries available");
  } else {
    lines.push(...boundedEntries);
  }

  return {
    content: `${lines.join("\n")}\n`,
    omittedExchangeEntries,
    omittedProgressNotes,
    recentExchangeEntries: boundedEntries.length,
    recentProgressNotes: boundedProgressNotes.length,
    highSignalExchangeEntries: highSignalEntries.length,
    chronologyCheckpointEntries: chronologyCheckpointEntries.length,
  };
}
