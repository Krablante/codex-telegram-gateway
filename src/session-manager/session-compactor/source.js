import fs from "node:fs/promises";
import path from "node:path";

import {
  COMPACTION_SOURCE_FILENAME,
  LARGE_EXCHANGE_LOG_THRESHOLD_BYTES,
  LARGE_EXCHANGE_LOG_THRESHOLD_ENTRIES,
} from "./source/limits.js";
import {
  buildBoundedCompactionSource,
  buildFullCompactionSource,
} from "./source/builders.js";

async function getExchangeLogBytes(exchangeLogPath) {
  try {
    const stats = await fs.stat(exchangeLogPath);
    return stats.size;
  } catch {
    return 0;
  }
}

function isLargeExchangeLog({ exchangeLog, exchangeLogBytes }) {
  return exchangeLog.length > LARGE_EXCHANGE_LOG_THRESHOLD_ENTRIES
    || exchangeLogBytes > LARGE_EXCHANGE_LOG_THRESHOLD_BYTES;
}

function buildBoundedSourceDescriptor({
  bounded,
  boundedSourcePath,
  exchangeLog,
  progressNotes,
}) {
  return {
    kind: "bounded-compaction-source",
    path: boundedSourcePath,
    exchangeLogEntries: exchangeLog.length,
    recentExchangeEntries: bounded.recentExchangeEntries,
    omittedExchangeEntries: bounded.omittedExchangeEntries,
    highSignalExchangeEntries: bounded.highSignalExchangeEntries,
    chronologyCheckpointEntries: bounded.chronologyCheckpointEntries,
    progressNotes: progressNotes.length,
    recentProgressNotes: bounded.recentProgressNotes,
    omittedProgressNotes: bounded.omittedProgressNotes,
  };
}

function buildFullCompactionSourceDescriptor({
  fullCompactionSource,
  boundedSourcePath,
  exchangeLog,
  progressNotes,
}) {
  return {
    kind: "full-compaction-source",
    path: boundedSourcePath,
    exchangeLogEntries: exchangeLog.length,
    fullExchangeEntries: fullCompactionSource.fullExchangeEntries,
    progressNotes: progressNotes.length,
    recentProgressNotes: fullCompactionSource.recentProgressNotes,
    omittedProgressNotes: fullCompactionSource.omittedProgressNotes,
  };
}

async function writeCompactionSource(sessionStore, session, content) {
  await sessionStore.writeSessionText(
    session,
    COMPACTION_SOURCE_FILENAME,
    content,
  );
}

export async function buildCompactionSourceSelection({
  activeBrief,
  exchangeLog,
  exchangeLogPath,
  progressNotes = [],
  reason,
  session,
  sessionStore,
}) {
  const boundedSourcePath = path.join(
    sessionStore.getSessionDir(session.chat_id, session.topic_id),
    COMPACTION_SOURCE_FILENAME,
  );
  const fullSource = {
    kind: "full-exchange-log",
    path: exchangeLogPath,
    exchangeLogEntries: exchangeLog.length,
  };

  const largeExchangeLog = isLargeExchangeLog({
    exchangeLog,
    exchangeLogBytes: await getExchangeLogBytes(exchangeLogPath),
  });

  if (!largeExchangeLog && progressNotes.length > 0) {
    const fullCompactionSource = buildFullCompactionSource({
      activeBrief,
      exchangeLog,
      progressNotes,
      reason,
      session,
    });
    await writeCompactionSource(
      sessionStore,
      session,
      fullCompactionSource.content,
    );
    return {
      primarySource: buildFullCompactionSourceDescriptor({
        fullCompactionSource,
        boundedSourcePath,
        exchangeLog,
        progressNotes,
      }),
      fallbackSource: null,
    };
  }

  const bounded = buildBoundedCompactionSource({
    activeBrief,
    exchangeLog,
    progressNotes,
    reason,
    session,
  });
  await writeCompactionSource(
    sessionStore,
    session,
    bounded.content,
  );
  const boundedSource = buildBoundedSourceDescriptor({
    bounded,
    boundedSourcePath,
    exchangeLog,
    progressNotes,
  });

  if (largeExchangeLog) {
    return {
      primarySource: boundedSource,
      fallbackSource: null,
    };
  }

  return {
    primarySource: fullSource,
    fallbackSource: boundedSource,
  };
}
