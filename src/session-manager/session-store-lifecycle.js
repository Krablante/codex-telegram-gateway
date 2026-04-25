import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { getSessionKey, normalizeSessionIds } from "./session-key.js";
import { normalizeUiLanguage } from "../i18n/ui-language.js";
import {
  cloneJson,
  ensurePrivateDirectory,
  PRIVATE_DIRECTORY_MODE,
  writeTextAtomic,
  writeTextAtomicIfChanged,
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

function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function preservePendingAttachmentFields(existing) {
  return {
    pending_prompt_attachments: Array.isArray(existing?.pending_prompt_attachments)
      ? cloneJson(existing.pending_prompt_attachments)
      : [],
    pending_prompt_attachments_expires_at:
      normalizeOptionalText(existing?.pending_prompt_attachments_expires_at),
    pending_queue_attachments: Array.isArray(existing?.pending_queue_attachments)
      ? cloneJson(existing.pending_queue_attachments)
      : [],
    pending_queue_attachments_expires_at:
      normalizeOptionalText(existing?.pending_queue_attachments_expires_at),
  };
}

const META_LOCK_OWNER_FILE = "owner.json";
const META_LOCK_HEARTBEAT_MS = Math.max(
  1000,
  Math.min(10_000, Math.floor(META_LOCK_STALE_MS / 3)),
);

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function writeMetaLockOwner(lockPath) {
  await writeTextAtomic(
    path.join(lockPath, META_LOCK_OWNER_FILE),
    `${JSON.stringify({
      pid: process.pid,
      created_at: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}

async function readMetaLockOwner(lockPath) {
  try {
    return JSON.parse(
      await fs.readFile(path.join(lockPath, META_LOCK_OWNER_FILE), "utf8"),
    );
  } catch {
    return null;
  }
}

async function isMetaLockReapable(lockPath) {
  const stats = await fs.stat(lockPath);
  if (Date.now() - stats.mtimeMs < META_LOCK_STALE_MS) {
    return false;
  }

  const owner = await readMetaLockOwner(lockPath);
  if (isProcessAlive(Number(owner?.pid))) {
    return false;
  }

  return true;
}

function startMetaLockHeartbeat(lockPath) {
  const heartbeat = setInterval(() => {
    const now = new Date();
    void fs.utimes(lockPath, now, now).catch(() => {});
  }, META_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();
  return heartbeat;
}

export async function withMetaLock(store, chatId, topicId, fn) {
  const sessionDir = store.getSessionDir(chatId, topicId);
  const lockPath = store.getMetaLockPath(chatId, topicId);
  await ensurePrivateDirectory(sessionDir);
  const startedAt = Date.now();
  let heartbeat;

  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
      try {
        await writeMetaLockOwner(lockPath);
        heartbeat = startMetaLockHeartbeat(lockPath);
      } catch (ownerError) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
        throw ownerError;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      if (Date.now() - startedAt >= META_LOCK_TIMEOUT_MS) {
        try {
          if (await isMetaLockReapable(lockPath)) {
            await fs.rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") {
            continue;
          }
          throw statError;
        }

        throw new Error(
          `Timed out acquiring session meta lock for ${getSessionKey(chatId, topicId)}`,
          { cause: error },
        );
      }

      await sleep(META_LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

export async function saveUnlocked(store, meta) {
  const sessionDir = store.getSessionDir(meta.chat_id, meta.topic_id);
  const normalizedMeta = normalizeStoredSessionMeta(meta);
  await ensurePrivateDirectory(sessionDir);
  await writeTextAtomic(
    path.join(sessionDir, "meta.json"),
    `${JSON.stringify(stripLegacyMetaFields(normalizedMeta), null, 2)}\n`,
  );
  await writeTextAtomicIfChanged(
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
    executionHostId = null,
    executionHostLabel = null,
    executionHostBoundAt = null,
    executionHostLastReadyAt = null,
    executionHostLastFailure = null,
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

      if (reactivate && existing.lifecycle_state === "purged") {
        updated = {
          schema_version: existing.schema_version ?? 1,
          session_key: getSessionKey(ids.chatId, ids.topicId),
          chat_id: ids.chatId,
          topic_id: ids.topicId,
          topic_name: topicName || existing.topic_name || null,
          lifecycle_state: "active",
          created_at: now,
          updated_at: now,
          created_via: createdVia,
          inherited_from_session_key: existing.inherited_from_session_key ?? null,
          workspace_binding: cloneJson(
            existing.workspace_binding || workspaceBinding,
          ),
          ...buildRuntimeStateFields(),
          ...preservePendingAttachmentFields(existing),
          execution_host_id: executionHostId ?? existing.execution_host_id ?? null,
          execution_host_label:
            executionHostLabel
            ?? existing.execution_host_label
            ?? executionHostId
            ?? null,
          execution_host_bound_at:
            executionHostBoundAt
            ?? existing.execution_host_bound_at
            ?? now,
          execution_host_last_ready_at:
            executionHostLastReadyAt ?? existing.execution_host_last_ready_at ?? null,
          execution_host_last_failure:
            executionHostLastFailure ?? existing.execution_host_last_failure ?? null,
          ui_language: normalizeUiLanguage(existing.ui_language ?? uiLanguage),
          reactivated_at: now,
          lifecycle_reactivated_reason: createdVia,
        };
        await saveUnlocked(store, updated);
        return updated;
      }

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

      const hasExecutionHostId = Boolean(normalizeOptionalText(existing.execution_host_id));
      const hasExecutionHostLabel = Boolean(normalizeOptionalText(existing.execution_host_label));
      const hasExecutionHostBoundAt = Boolean(normalizeOptionalText(existing.execution_host_bound_at));
      const hasExecutionHostLastReadyAt = Boolean(
        normalizeOptionalText(existing.execution_host_last_ready_at),
      );
      const hasExecutionHostLastFailure = Boolean(
        normalizeOptionalText(existing.execution_host_last_failure),
      );

      if (
        executionHostId
        && (
          !hasExecutionHostId
          || !hasExecutionHostLabel
          || !hasExecutionHostBoundAt
          || (!hasExecutionHostLastReadyAt && executionHostLastReadyAt)
          || (!hasExecutionHostLastFailure && executionHostLastFailure)
        )
      ) {
        updated = {
          ...updated,
          execution_host_id: hasExecutionHostId
            ? updated.execution_host_id
            : executionHostId,
          execution_host_label: hasExecutionHostLabel
            ? updated.execution_host_label
            : executionHostLabel ?? executionHostId,
          execution_host_bound_at: hasExecutionHostBoundAt
            ? updated.execution_host_bound_at
            : executionHostBoundAt ?? now,
          execution_host_last_ready_at: hasExecutionHostLastReadyAt
            ? updated.execution_host_last_ready_at
            : executionHostLastReadyAt,
          execution_host_last_failure: hasExecutionHostLastFailure
            ? updated.execution_host_last_failure
            : executionHostLastFailure,
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
      execution_host_id: executionHostId,
      execution_host_label: executionHostLabel,
      execution_host_bound_at: executionHostBoundAt ?? now,
      execution_host_last_ready_at: executionHostLastReadyAt,
      execution_host_last_failure: executionHostLastFailure,
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
