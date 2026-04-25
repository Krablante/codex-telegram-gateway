import path from "node:path";

import { normalizeSessionIds } from "./session-key.js";
import { TOPIC_CONTEXT_FILE_NAME } from "./topic-context.js";
import { META_LOCK_DIR_NAME } from "./session-store-common.js";
import {
  activateSession,
  claimSessionOwner,
  clearSessionOwner,
  ensureSession,
  parkSession,
  patchWithCurrent,
  purgeSession,
  removeLegacyMemoryFiles,
  saveUnlocked,
  touchCommand,
  withMetaLock,
} from "./session-store-lifecycle.js";
import {
  appendExchangeLogEntry,
  listSessions,
  listSessionsWithFile,
  loadActiveBrief,
  loadCompactState,
  loadExchangeLog,
  loadSessionMeta,
  readSessionText,
  writeArtifact,
  writeSessionJson,
  writeSessionText,
} from "./session-store-files.js";
import {
  appendProgressNoteEntry,
  loadProgressNotes,
} from "./session-progress-journal.js";

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

  getMetaLockPath(chatId, topicId) {
    return path.join(this.getSessionDir(chatId, topicId), META_LOCK_DIR_NAME);
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

  getProgressNotesPath(chatId, topicId) {
    return path.join(this.getSessionDir(chatId, topicId), "progress-notes.jsonl");
  }

  getExecJsonRunLogPath(chatId, topicId) {
    return path.join(this.getSessionDir(chatId, topicId), "exec-json-run.jsonl");
  }

  getTopicContextPath(chatId, topicId) {
    return path.join(
      this.getSessionDir(chatId, topicId),
      TOPIC_CONTEXT_FILE_NAME,
    );
  }

  async load(chatId, topicId) {
    return loadSessionMeta(this, chatId, topicId);
  }

  async withMetaLock(chatId, topicId, fn) {
    return withMetaLock(this, chatId, topicId, fn);
  }

  async saveUnlocked(meta) {
    return saveUnlocked(this, meta);
  }

  async save(meta) {
    return this.withMetaLock(meta.chat_id, meta.topic_id, () =>
      this.saveUnlocked(meta),
    );
  }

  async ensure(args) {
    return ensureSession(this, args);
  }

  async touchCommand(meta, commandName) {
    return touchCommand(this, meta, commandName);
  }

  async patch(meta, patch) {
    return this.patchWithCurrent(meta, patch);
  }

  async patchWithCurrent(meta, patch) {
    return patchWithCurrent(this, meta, patch);
  }

  async claimSessionOwner(meta, ownership) {
    return claimSessionOwner(this, meta, ownership);
  }

  async clearSessionOwner(meta) {
    return clearSessionOwner(this, meta);
  }

  async listSessions() {
    return listSessions(this);
  }

  async listSessionsWithFile(relativePath) {
    return listSessionsWithFile(this, relativePath);
  }

  async loadCompactState(meta) {
    return loadCompactState(this, meta);
  }

  async loadActiveBrief(meta) {
    return loadActiveBrief(this, meta);
  }

  async readSessionText(meta, relativePath) {
    return readSessionText(this, meta, relativePath);
  }

  async loadExchangeLog(meta) {
    return loadExchangeLog(this, meta);
  }

  async appendExchangeLogEntry(meta, entry) {
    return appendExchangeLogEntry(this, meta, entry);
  }

  async loadProgressNotes(meta, options = {}) {
    return loadProgressNotes(this, meta, options);
  }

  async appendProgressNoteEntry(meta, entry) {
    return appendProgressNoteEntry(this, meta, entry);
  }

  async writeSessionText(meta, relativePath, content) {
    return writeSessionText(this, meta, relativePath, content);
  }

  async writeSessionJson(meta, relativePath, value) {
    return writeSessionJson(this, meta, relativePath, value);
  }

  async writeArtifact(meta, artifact) {
    return writeArtifact(this, meta, artifact);
  }

  async park(meta, reason, extraPatch = {}) {
    return parkSession(this, meta, reason, extraPatch);
  }

  async activate(meta, reason, extraPatch = {}) {
    return activateSession(this, meta, reason, extraPatch);
  }

  async removeLegacyMemoryFiles(meta) {
    return removeLegacyMemoryFiles(this, meta);
  }

  async purge(meta, reason) {
    return purgeSession(this, meta, reason);
  }
}
