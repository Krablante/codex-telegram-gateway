import fs from "node:fs/promises";
import path from "node:path";

import { getSessionKey, normalizeSessionIds } from "./session-key.js";
import { normalizeUiLanguage } from "../i18n/ui-language.js";
import {
  cloneJson,
  writeTextAtomic,
} from "../state/file-utils.js";
import { buildTopicContextFileText } from "./topic-context.js";
import {
  buildPurgedStub,
  buildRuntimeStateFields,
  CorruptSessionMetaError,
  getCorruptSessionMetaMarkerPath,
  hasCorruptSessionMetaMarker,
  META_LOCK_RETRY_MS,
  META_LOCK_STALE_MS,
  META_LOCK_TIMEOUT_MS,
  normalizeOwnershipPatch,
  normalizeStoredSessionMeta,
  readMetaJson,
  sleep,
  stripLegacyMetaFields,
} from "./session-store-common.js";

async function throwIfCorruptMetaMarkerExists(metaPath) {
  if (await hasCorruptSessionMetaMarker(metaPath)) {
    throw new CorruptSessionMetaError(metaPath);
  }
}

async function loadCurrentMetaOrFallback(store, meta) {
  const metaPath = store.getMetaPath(meta.chat_id, meta.topic_id);
  await throwIfCorruptMetaMarkerExists(metaPath);
  return (await readMetaJson(metaPath)) || meta;
}

export async function withMetaLock(store, chatId, topicId, fn) {
  const sessionDir = store.getSessionDir(chatId, topicId);
  const lockPath = store.getMetaLockPath(chatId, topicId);
  await fs.mkdir(sessionDir, { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      if (Date.now() - startedAt >= META_LOCK_TIMEOUT_MS) {
        try {
          const stats = await fs.stat(lockPath);
          if (Date.now() - stats.mtimeMs >= META_LOCK_STALE_MS) {
            await fs.rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError?.code !== "ENOENT") {
            throw statError;
          }
        }

        throw new Error(
          `Timed out acquiring session meta lock for ${getSessionKey(chatId, topicId)}`,
        );
      }

      await sleep(META_LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

export async function saveUnlocked(store, meta) {
  const sessionDir = store.getSessionDir(meta.chat_id, meta.topic_id);
  const normalizedMeta = normalizeStoredSessionMeta(meta);
  await fs.mkdir(sessionDir, { recursive: true });
  await writeTextAtomic(
    path.join(sessionDir, "meta.json"),
    `${JSON.stringify(stripLegacyMetaFields(normalizedMeta), null, 2)}\n`,
  );
  await writeTextAtomic(
    store.getTopicContextPath(normalizedMeta.chat_id, normalizedMeta.topic_id),
    buildTopicContextFileText(normalizedMeta, {
      topicContextPath: store.getTopicContextPath(
        normalizedMeta.chat_id,
        normalizedMeta.topic_id,
      ),
    }),
  );
  await fs.rm(
    getCorruptSessionMetaMarkerPath(
      store.getMetaPath(normalizedMeta.chat_id, normalizedMeta.topic_id),
    ),
    { force: true },
  ).catch(() => {});
}

export async function ensureSession(
  store,
  {
    chatId,
    topicId,
    topicName = null,
    uiLanguage = null,
    workspaceBinding,
    createdVia,
    inheritedFromSessionKey = null,
    reactivate = false,
  },
) {
  const ids = normalizeSessionIds(chatId, topicId);
  return withMetaLock(store, ids.chatId, ids.topicId, async () => {
    const metaPath = store.getMetaPath(ids.chatId, ids.topicId);
    await throwIfCorruptMetaMarkerExists(metaPath);
    const existing = await readMetaJson(metaPath);
    const now = new Date().toISOString();

    if (existing) {
      let updated = {
        ...existing,
        topic_name: topicName || existing.topic_name || null,
        updated_at: now,
      };

      if (reactivate && existing.lifecycle_state === "parked") {
        updated = {
          ...updated,
          lifecycle_state: "active",
          purge_after: null,
          workspace_binding: cloneJson(
            existing.workspace_binding || workspaceBinding,
          ),
          reactivated_at: now,
          lifecycle_reactivated_reason: createdVia,
        };
      }

      await saveUnlocked(store, updated);
      return updated;
    }

    const meta = {
      schema_version: 1,
      session_key: getSessionKey(ids.chatId, ids.topicId),
      chat_id: ids.chatId,
      topic_id: ids.topicId,
      topic_name: topicName,
      lifecycle_state: "active",
      created_at: now,
      updated_at: now,
      created_via: createdVia,
      inherited_from_session_key: inheritedFromSessionKey,
      workspace_binding: cloneJson(workspaceBinding),
      ...buildRuntimeStateFields(),
      ui_language: normalizeUiLanguage(uiLanguage),
    };

    await saveUnlocked(store, meta);
    return meta;
  });
}

export async function touchCommand(store, meta, commandName) {
  return withMetaLock(store, meta.chat_id, meta.topic_id, async () => {
    const commandAt = new Date().toISOString();
    const current = await loadCurrentMetaOrFallback(store, meta);
    const updated = {
      ...current,
      updated_at: commandAt,
      last_command_name: commandName,
      last_command_at: commandAt,
    };
    await saveUnlocked(store, updated);
    return updated;
  });
}

export async function patchWithCurrent(store, meta, patch) {
  return withMetaLock(store, meta.chat_id, meta.topic_id, async () => {
    const current = await loadCurrentMetaOrFallback(store, meta);
    const resolvedPatch =
      typeof patch === "function"
        ? await patch(current)
        : patch;
    if (resolvedPatch === null || resolvedPatch === undefined) {
      return current;
    }
    if (
      typeof resolvedPatch !== "object"
      || Array.isArray(resolvedPatch)
    ) {
      throw new Error("SessionStore patch must be an object or null");
    }
    const normalizedPatch = normalizeOwnershipPatch(current, resolvedPatch);
    const updated = {
      ...stripLegacyMetaFields(current),
      ...cloneJson(stripLegacyMetaFields(normalizedPatch)),
      updated_at: new Date().toISOString(),
    };
    await saveUnlocked(store, updated);
    return updated;
  });
}

export async function claimSessionOwner(
  store,
  meta,
  {
    generationId,
    mode = "active",
    claimedAt = null,
  },
) {
  return patchWithCurrent(store, meta, {
    session_owner_generation_id: generationId,
    session_owner_mode: mode,
    session_owner_claimed_at: claimedAt,
  });
}

export async function clearSessionOwner(store, meta) {
  return patchWithCurrent(store, meta, {
    session_owner_generation_id: null,
    session_owner_mode: null,
    session_owner_claimed_at: null,
    spike_run_owner_generation_id: null,
  });
}

export async function parkSession(store, meta, reason, extraPatch = {}) {
  const extra = cloneJson(extraPatch);
  return patchWithCurrent(store, meta, (current) => {
    const alreadyParkedForReason =
      current.lifecycle_state === "parked" && current.parked_reason === reason;
    const parkedAt =
      alreadyParkedForReason && current.parked_at
        ? current.parked_at
        : new Date().toISOString();

    return {
      lifecycle_state: "parked",
      parked_at: parkedAt,
      parked_reason: reason,
      ...extra,
      ...(alreadyParkedForReason && current.purge_after
        ? { purge_after: current.purge_after }
        : {}),
    };
  });
}

export async function activateSession(store, meta, reason, extraPatch = {}) {
  return patchWithCurrent(store, meta, {
    lifecycle_state: "active",
    parked_at: null,
    parked_reason: null,
    purged_at: null,
    purged_reason: null,
    purge_after: null,
    reactivated_at: new Date().toISOString(),
    lifecycle_reactivated_reason: reason,
    ...cloneJson(extraPatch),
  });
}

export async function removeLegacyMemoryFiles(store, meta) {
  const current =
    (await store.load(meta.chat_id, meta.topic_id)) || meta;
  const legacyPaths = [
    path.join(store.getSessionDir(current.chat_id, current.topic_id), "raw-log.ndjson"),
    path.join(store.getSessionDir(current.chat_id, current.topic_id), "recent-window.json"),
    path.join(store.getSessionDir(current.chat_id, current.topic_id), "artifact-store.json"),
    path.join(store.getSessionDir(current.chat_id, current.topic_id), "task-ledger.json"),
    path.join(store.getSessionDir(current.chat_id, current.topic_id), "pinned-facts.json"),
  ];

  await Promise.all(
    legacyPaths.map((filePath) =>
      fs.rm(filePath, {
        force: true,
      }).catch((error) => {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }),
    ),
  );
}

export async function purgeSession(store, meta, reason) {
  return withMetaLock(store, meta.chat_id, meta.topic_id, async () => {
    const current =
      (await readMetaJson(store.getMetaPath(meta.chat_id, meta.topic_id))) || meta;
    if (current.lifecycle_state === "purged") {
      return current;
    }
    if (current.retention_pin) {
      throw new Error(`Session ${current.session_key} is pinned and not purge-eligible.`);
    }
    if (
      current.last_run_status === "running" ||
      current.session_owner_generation_id
    ) {
      throw new Error(`Session ${current.session_key} is still active and not purge-eligible.`);
    }

    const purgeTarget =
      current.lifecycle_state === "parked"
        ? current
        : {
          ...current,
          lifecycle_state: "parked",
          parked_at: current.parked_at ?? new Date().toISOString(),
          parked_reason: current.parked_reason ?? reason,
        };

    const sessionDir = store.getSessionDir(current.chat_id, current.topic_id);
    const lockDirName = path.basename(
      store.getMetaLockPath(current.chat_id, current.topic_id),
    );
    const entries = await fs.readdir(sessionDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.name !== lockDirName)
        .map((entry) =>
          fs.rm(path.join(sessionDir, entry.name), {
            recursive: true,
            force: true,
          }),
        ),
    );

    const purgedStub = buildPurgedStub(purgeTarget, reason);
    await saveUnlocked(store, purgedStub);
    return purgedStub;
  });
}
