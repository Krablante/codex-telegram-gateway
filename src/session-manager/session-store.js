import fs from "node:fs/promises";
import path from "node:path";

import { getSessionKey, normalizeSessionIds } from "./session-key.js";
import { normalizeUiLanguage } from "../i18n/ui-language.js";
import {
  cloneJson,
  quarantineCorruptFile,
  writeTextAtomic,
} from "../state/file-utils.js";
import {
  buildTopicContextFileText,
  TOPIC_CONTEXT_FILE_NAME,
} from "./topic-context.js";

async function readMetaJson(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
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

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function buildRuntimeStateFields() {
  return {
    last_command_name: null,
    last_command_at: null,
    last_compacted_at: null,
    last_compaction_reason: null,
    exchange_log_entries: 0,
    purge_after: null,
    retention_pin: false,
    parked_at: null,
    parked_reason: null,
    purged_at: null,
    purged_reason: null,
    reactivated_at: null,
    lifecycle_reactivated_reason: null,
    ui_language: "rus",
    codex_thread_id: null,
    codex_rollout_path: null,
    prompt_suffix_topic_enabled: true,
    prompt_suffix_text: null,
    prompt_suffix_enabled: false,
    pending_prompt_attachments: [],
    pending_prompt_attachments_expires_at: null,
    last_user_prompt: null,
    last_agent_reply: null,
    last_run_status: null,
    last_run_started_at: null,
    last_run_finished_at: null,
    last_token_usage: null,
    last_context_snapshot: null,
    last_progress_message_id: null,
    artifact_count: 0,
    last_artifact: null,
    last_diff_artifact: null,
  };
}

function stripLegacyMetaFields(value) {
  const cloned = cloneJson(value);
  delete cloned.recent_window_entries;
  delete cloned.last_log_artifact;
  delete cloned.task_ledger_entries;
  delete cloned.pinned_fact_count;
  return cloned;
}

function buildPurgedStub(current, reason) {
  const now = new Date().toISOString();

  return {
    schema_version: current.schema_version ?? 1,
    session_key: current.session_key,
    chat_id: current.chat_id,
    topic_id: current.topic_id,
    topic_name: current.topic_name ?? null,
    lifecycle_state: "purged",
    created_at: current.created_at ?? now,
    updated_at: now,
    created_via: current.created_via ?? "unknown",
    inherited_from_session_key: current.inherited_from_session_key ?? null,
    workspace_binding: cloneJson(current.workspace_binding ?? {}),
    ui_language: normalizeUiLanguage(current.ui_language),
    last_command_name: "purge",
    last_command_at: now,
    last_compacted_at: null,
    last_compaction_reason: null,
    exchange_log_entries: 0,
    purge_after: null,
    retention_pin: current.retention_pin ?? false,
    purged_at: now,
    purged_reason: reason,
    artifact_count: 0,
    last_artifact: null,
    last_diff_artifact: null,
  };
}

function buildArtifactFileName(kind, extension) {
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "");
  const safeKind = kind.replace(/[^a-z0-9-]+/giu, "-");
  return `${stamp}-${safeKind}.${extension}`;
}

function normalizeExchangeLogEntry(entry) {
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

export class SessionStore {
  constructor(sessionsRoot) {
    this.sessionsRoot = sessionsRoot;
  }

  getSessionDir(chatId, topicId) {
    const ids = normalizeSessionIds(chatId, topicId);
    return path.join(this.sessionsRoot, ids.chatId, ids.topicId);
  }

  getMetaPath(chatId, topicId) {
    return path.join(this.getSessionDir(chatId, topicId), "meta.json");
  }

  getArtifactsDir(chatId, topicId) {
    return path.join(this.getSessionDir(chatId, topicId), "artifacts");
  }

  getActiveBriefPath(chatId, topicId) {
    return path.join(this.getSessionDir(chatId, topicId), "active-brief.md");
  }

  getExchangeLogPath(chatId, topicId) {
    return path.join(this.getSessionDir(chatId, topicId), "exchange-log.jsonl");
  }

  getTopicContextPath(chatId, topicId) {
    return path.join(
      this.getSessionDir(chatId, topicId),
      TOPIC_CONTEXT_FILE_NAME,
    );
  }

  async load(chatId, topicId) {
    return readMetaJson(this.getMetaPath(chatId, topicId));
  }

  async save(meta) {
    const sessionDir = this.getSessionDir(meta.chat_id, meta.topic_id);
    await fs.mkdir(sessionDir, { recursive: true });
    await writeTextAtomic(
      path.join(sessionDir, "meta.json"),
      `${JSON.stringify(stripLegacyMetaFields(meta), null, 2)}\n`,
    );
    await writeTextAtomic(
      this.getTopicContextPath(meta.chat_id, meta.topic_id),
      buildTopicContextFileText(meta, {
        topicContextPath: this.getTopicContextPath(meta.chat_id, meta.topic_id),
      }),
    );
  }

  async ensure({
    chatId,
    topicId,
    topicName = null,
    workspaceBinding,
    createdVia,
    inheritedFromSessionKey = null,
    reactivate = false,
  }) {
    const ids = normalizeSessionIds(chatId, topicId);
    const existing = await this.load(ids.chatId, ids.topicId);
    const now = new Date().toISOString();

    if (existing) {
      let updated = {
        ...existing,
        topic_name: topicName || existing.topic_name || null,
        updated_at: now,
      };

      if (reactivate && existing.lifecycle_state !== "active") {
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

        if (existing.lifecycle_state === "purged") {
          updated = {
            ...updated,
            ...buildRuntimeStateFields(),
            lifecycle_state: "active",
            retention_pin: existing.retention_pin ?? false,
            workspace_binding: cloneJson(
              existing.workspace_binding || workspaceBinding,
            ),
            ui_language: normalizeUiLanguage(existing.ui_language),
            reactivated_at: now,
            lifecycle_reactivated_reason: createdVia,
          };
        }
      }

      await this.save(updated);
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
    };

    await this.save(meta);
    return meta;
  }

  async touchCommand(meta, commandName) {
    const commandAt = new Date().toISOString();
    const current =
      (await this.load(meta.chat_id, meta.topic_id)) || meta;
    const updated = {
      ...current,
      updated_at: commandAt,
      last_command_name: commandName,
      last_command_at: commandAt,
    };
    await this.save(updated);
    return updated;
  }

  async patch(meta, patch) {
    const current =
      (await this.load(meta.chat_id, meta.topic_id)) || meta;
    const updated = {
      ...stripLegacyMetaFields(current),
      ...cloneJson(stripLegacyMetaFields(patch)),
      updated_at: new Date().toISOString(),
    };
    await this.save(updated);
    return updated;
  }

  async listSessions() {
    const sessions = [];

    let chatEntries = [];
    try {
      chatEntries = await fs.readdir(this.sessionsRoot, { withFileTypes: true });
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

      const chatDir = path.join(this.sessionsRoot, chatEntry.name);
      const topicEntries = await fs.readdir(chatDir, { withFileTypes: true });
      for (const topicEntry of topicEntries) {
        if (!topicEntry.isDirectory()) {
          continue;
        }

        const topicDir = path.join(chatDir, topicEntry.name);
        const metaPath = path.join(topicDir, "meta.json");
        const session = await readMetaJson(metaPath);
        if (session) {
          sessions.push(session);
        }
      }
    }

    return sessions;
  }

  async loadCompactState(meta) {
    const current =
      (await this.load(meta.chat_id, meta.topic_id)) || meta;

    return {
      activeBrief: await this.loadActiveBrief(current),
      exchangeLog: await this.loadExchangeLog(current),
    };
  }

  async loadActiveBrief(meta) {
    const current =
      (await this.load(meta.chat_id, meta.topic_id)) || meta;

    return (
      (await readOptionalText(
        this.getActiveBriefPath(current.chat_id, current.topic_id),
      )) || ""
    );
  }

  async loadExchangeLog(meta) {
    const current =
      (await this.load(meta.chat_id, meta.topic_id)) || meta;
    const filePath = this.getExchangeLogPath(current.chat_id, current.topic_id);

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

  async appendExchangeLogEntry(meta, entry) {
    const current =
      (await this.load(meta.chat_id, meta.topic_id)) || meta;
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
      : (await this.loadExchangeLog(current)).length;
    const filePath = this.getExchangeLogPath(current.chat_id, current.topic_id);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(normalizedEntry)}\n`, "utf8");
    const updated = await this.patch(current, {
      exchange_log_entries: currentCount + 1,
    });

    return {
      session: updated,
      entry: normalizedEntry,
      exchangeLogEntries: updated.exchange_log_entries ?? currentCount + 1,
    };
  }

  async writeSessionText(meta, relativePath, content) {
    const current =
      (await this.load(meta.chat_id, meta.topic_id)) || meta;
    const filePath = path.join(
      this.getSessionDir(current.chat_id, current.topic_id),
      relativePath,
    );
    await writeTextAtomic(filePath, content);
    return filePath;
  }

  async writeSessionJson(meta, relativePath, value) {
    return this.writeSessionText(
      meta,
      relativePath,
      `${JSON.stringify(cloneJson(value), null, 2)}\n`,
    );
  }

  async writeArtifact(meta, { kind, extension = "txt", content, contentType }) {
    const current =
      (await this.load(meta.chat_id, meta.topic_id)) || meta;
    const artifactsDir = this.getArtifactsDir(current.chat_id, current.topic_id);
    await fs.mkdir(artifactsDir, { recursive: true });

    const fileName = buildArtifactFileName(kind, extension);
    const filePath = path.join(artifactsDir, fileName);
    await fs.writeFile(filePath, content, "utf8");
    const stats = await fs.stat(filePath);
    const artifact = {
      kind,
      file_name: fileName,
      relative_path: path.relative(
        this.getSessionDir(current.chat_id, current.topic_id),
        filePath,
      ),
      created_at: new Date().toISOString(),
      size_bytes: stats.size,
      content_type: contentType || "text/plain",
    };

    const patch = {
      artifact_count: (current.artifact_count ?? 0) + 1,
      last_artifact: artifact,
    };
    if (kind === "diff") {
      patch.last_diff_artifact = artifact;
    }

    const updated = await this.patch(current, patch);
    return {
      artifact,
      filePath,
      session: updated,
    };
  }

  async park(meta, reason, extraPatch = {}) {
    return this.patch(meta, {
      lifecycle_state: "parked",
      parked_at: new Date().toISOString(),
      parked_reason: reason,
      ...cloneJson(extraPatch),
    });
  }

  async activate(meta, reason, extraPatch = {}) {
    return this.patch(meta, {
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

  async removeLegacyMemoryFiles(meta) {
    const current =
      (await this.load(meta.chat_id, meta.topic_id)) || meta;
    const legacyPaths = [
      path.join(this.getSessionDir(current.chat_id, current.topic_id), "raw-log.ndjson"),
      path.join(this.getSessionDir(current.chat_id, current.topic_id), "recent-window.json"),
      path.join(this.getSessionDir(current.chat_id, current.topic_id), "artifact-store.json"),
      path.join(this.getSessionDir(current.chat_id, current.topic_id), "task-ledger.json"),
      path.join(this.getSessionDir(current.chat_id, current.topic_id), "pinned-facts.json"),
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

  async purge(meta, reason) {
    const current =
      (await this.load(meta.chat_id, meta.topic_id)) || meta;
    const sessionDir = this.getSessionDir(current.chat_id, current.topic_id);
    const purgedStub = buildPurgedStub(current, reason);
    await fs.rm(sessionDir, { recursive: true, force: true });
    await fs.mkdir(sessionDir, { recursive: true });
    await this.save(purgedStub);
    return purgedStub;
  }
}
