import fs from "node:fs/promises";
import path from "node:path";

import {
  appendTextFile,
  cloneJson,
  quarantineCorruptFile,
  writeTextAtomic,
} from "../state/file-utils.js";
import {
  buildArtifactFileName,
  CorruptSessionMetaError,
  hasCorruptSessionMetaMarker,
  isCorruptSessionMetaError,
  normalizeExchangeLogEntry,
  readMetaJson,
  readOptionalText,
  stripLegacyMetaFields,
} from "./session-store-common.js";

async function throwIfCorruptMetaMarkerExists(store, chatId, topicId) {
  const metaPath = store.getMetaPath(chatId, topicId);
  if (await hasCorruptSessionMetaMarker(metaPath)) {
    throw new CorruptSessionMetaError(metaPath);
  }
}

function toStoredRelativePath(fromPath, toPath) {
  return path.relative(fromPath, toPath).split(path.sep).join(path.posix.sep);
}

export async function loadSessionMeta(store, chatId, topicId) {
  try {
    return await readMetaJson(store.getMetaPath(chatId, topicId));
  } catch (error) {
    if (isCorruptSessionMetaError(error)) {
      return null;
    }

    throw error;
  }
}

export async function listSessions(store) {
  return listSessionsMatching(store);
}

export async function listSessionsWithFile(store, relativePath) {
  const normalizedRelativePath = typeof relativePath === "string"
    ? relativePath.trim()
    : "";
  if (!normalizedRelativePath) {
    return [];
  }

  return listSessionsMatching(store, {
    requiredRelativePath: normalizedRelativePath,
  });
}

async function listSessionsMatching(store, { requiredRelativePath = null } = {}) {
  const sessions = [];

  let chatEntries;
  try {
    chatEntries = await fs.readdir(store.sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return sessions;
    }

    throw error;
  }

  for (const chatEntry of chatEntries) {
    if (!chatEntry.isDirectory()) {
      continue;
    }

    const chatDir = path.join(store.sessionsRoot, chatEntry.name);
    const topicEntries = await fs.readdir(chatDir, { withFileTypes: true });
    for (const topicEntry of topicEntries) {
      if (!topicEntry.isDirectory()) {
        continue;
      }

      const topicDir = path.join(chatDir, topicEntry.name);
      if (requiredRelativePath) {
        try {
          const requiredStat = await fs.stat(
            path.join(topicDir, requiredRelativePath),
          );
          if (!requiredStat.isFile()) {
            continue;
          }
        } catch (error) {
          if (error?.code === "ENOENT") {
            continue;
          }

          throw error;
        }
      }

      const metaPath = path.join(topicDir, "meta.json");
      let session = null;
      try {
        session = await readMetaJson(metaPath);
      } catch (error) {
        if (!isCorruptSessionMetaError(error)) {
          throw error;
        }
      }
      if (session) {
        sessions.push(session);
      }
    }
  }

  return sessions;
}

export async function loadCompactState(store, meta) {
  const current =
    (await store.load(meta.chat_id, meta.topic_id)) || meta;

  return {
    activeBrief: await store.loadActiveBrief(current),
    exchangeLog: await store.loadExchangeLog(current),
    progressNotes: await store.loadProgressNotes(current),
  };
}

export async function loadActiveBrief(store, meta) {
  const current =
    (await store.load(meta.chat_id, meta.topic_id)) || meta;

  return (
    (await readOptionalText(
      store.getActiveBriefPath(current.chat_id, current.topic_id),
    )) || ""
  );
}

export async function readSessionText(store, meta, relativePath) {
  const current =
    (await store.load(meta.chat_id, meta.topic_id)) || meta;
  return readOptionalText(
    path.join(
      store.getSessionDir(current.chat_id, current.topic_id),
      relativePath,
    ),
  );
}

export async function loadExchangeLog(store, meta) {
  const current =
    (await store.load(meta.chat_id, meta.topic_id)) || meta;
  const filePath = store.getExchangeLogPath(current.chat_id, current.topic_id);

  try {
    const text = await fs.readFile(filePath, "utf8");
    const entries = [];
    const lines = text.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) {
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        await quarantineCorruptFile(filePath);
        throw new Error(
          `Malformed exchange log at ${filePath}:${index + 1}`,
          { cause: error },
        );
      }

      const normalized = normalizeExchangeLogEntry(parsed);
      if (!normalized) {
        await quarantineCorruptFile(filePath);
        throw new Error(
          `Malformed exchange log at ${filePath}:${index + 1}`,
        );
      }

      entries.push(normalized);
    }

    return entries;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function appendExchangeLogEntry(store, meta, entry) {
  return store.withMetaLock(meta.chat_id, meta.topic_id, async () => {
    await throwIfCorruptMetaMarkerExists(store, meta.chat_id, meta.topic_id);
    const current =
      (await readMetaJson(store.getMetaPath(meta.chat_id, meta.topic_id))) || meta;
    const normalizedEntry = normalizeExchangeLogEntry(entry);
    if (!normalizedEntry) {
      return {
        session: current,
        entry: null,
        exchangeLogEntries: current.exchange_log_entries ?? 0,
      };
    }

    const currentCount = Number.isInteger(current.exchange_log_entries)
      ? current.exchange_log_entries
      : (await store.loadExchangeLog(current)).length;
    const filePath = store.getExchangeLogPath(current.chat_id, current.topic_id);
    await appendTextFile(filePath, `${JSON.stringify(normalizedEntry)}\n`);
    const updated = {
      ...stripLegacyMetaFields(current),
      exchange_log_entries: currentCount + 1,
      updated_at: new Date().toISOString(),
    };
    await store.saveUnlocked(updated);

    return {
      session: updated,
      entry: normalizedEntry,
      exchangeLogEntries: updated.exchange_log_entries ?? currentCount + 1,
    };
  });
}

export async function writeSessionText(store, meta, relativePath, content) {
  const current =
    (await store.load(meta.chat_id, meta.topic_id)) || meta;
  const filePath = path.join(
    store.getSessionDir(current.chat_id, current.topic_id),
    relativePath,
  );
  await writeTextAtomic(filePath, content);
  return filePath;
}

export async function writeSessionJson(store, meta, relativePath, value) {
  return writeSessionText(
    store,
    meta,
    relativePath,
    `${JSON.stringify(cloneJson(value), null, 2)}\n`,
  );
}

export async function writeArtifact(
  store,
  meta,
  {
    kind,
    extension = "txt",
    content,
    contentType,
  },
) {
  const current =
    (await store.load(meta.chat_id, meta.topic_id)) || meta;
  const artifactsDir = store.getArtifactsDir(current.chat_id, current.topic_id);

  const fileName = buildArtifactFileName(kind, extension);
  const filePath = path.join(artifactsDir, fileName);
  await writeTextAtomic(filePath, content);
  const stats = await fs.stat(filePath);
  const artifact = {
    kind,
    file_name: fileName,
    relative_path: toStoredRelativePath(
      store.getSessionDir(current.chat_id, current.topic_id),
      filePath,
    ),
    created_at: new Date().toISOString(),
    size_bytes: stats.size,
    content_type: contentType || "text/plain",
  };

  const updated = await store.patchWithCurrent(current, (latest) => {
    const patch = {
      artifact_count: (latest.artifact_count ?? 0) + 1,
      last_artifact: artifact,
    };
    if (kind === "diff") {
      patch.last_diff_artifact = artifact;
    }
    return patch;
  });
  return {
    artifact,
    filePath,
    session: updated,
  };
}
