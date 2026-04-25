import fs from "node:fs/promises";
import path from "node:path";

import {
  cloneJson,
  ensurePrivateDirectory,
  quarantineCorruptFile,
  writeTextAtomic,
} from "../state/file-utils.js";

const TOPIC_CONTROL_PANEL_FILE_NAME = "topic-control-panel.json";
const SCREEN_IDS = new Set([
  "root",
  "status",
  "wait",
  "suffix",
  "language",
  "bot_settings",
  "spike_model",
  "spike_reasoning",
]);
const PENDING_INPUT_KINDS = new Set([
  "suffix_text",
  "wait_custom",
]);

function normalizeInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeScreenId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SCREEN_IDS.has(normalized) ? normalized : "root";
}

function normalizeStatusText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizePendingInput(payload) {
  const kind = String(payload?.kind ?? "").trim().toLowerCase();
  if (!PENDING_INPUT_KINDS.has(kind)) {
    return null;
  }

  return {
    kind,
    requested_at: payload?.requested_at ?? null,
    requested_by_user_id: String(payload?.requested_by_user_id ?? "").trim() || null,
    menu_message_id: normalizeInteger(payload?.menu_message_id),
    screen: normalizeScreenId(payload?.screen),
    status_message: normalizeStatusText(payload?.status_message),
  };
}

function buildEmptyTopicControlPanelState() {
  return {
    schema_version: 1,
    updated_at: null,
    menu_message_id: null,
    active_screen: "root",
    pending_input: null,
    notice: null,
  };
}

function normalizeTopicControlPanelState(payload) {
  return {
    schema_version: 1,
    updated_at: payload?.updated_at ?? null,
    menu_message_id: normalizeInteger(payload?.menu_message_id),
    active_screen: normalizeScreenId(payload?.active_screen),
    pending_input: normalizePendingInput(payload?.pending_input),
    notice: normalizeStatusText(payload?.notice),
  };
}

export class TopicControlPanelStore {
  constructor(sessionStore) {
    if (!sessionStore) {
      throw new Error("TopicControlPanelStore requires a sessionStore");
    }

    this.sessionStore = sessionStore;
    this.cachedStates = new Map();
    this.writeChains = new Map();
  }

  getCacheKey(session) {
    return String(session?.session_key ?? "");
  }

  getFilePath(session) {
    return path.join(
      this.sessionStore.getSessionDir(session.chat_id, session.topic_id),
      TOPIC_CONTROL_PANEL_FILE_NAME,
    );
  }

  async runExclusive(session, operation) {
    const cacheKey = this.getCacheKey(session);
    const previous = this.writeChains.get(cacheKey) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(operation);

    this.writeChains.set(cacheKey, current);

    try {
      return await current;
    } finally {
      if (this.writeChains.get(cacheKey) === current) {
        this.writeChains.delete(cacheKey);
      }
    }
  }

  async load(session, { force = false } = {}) {
    const cacheKey = this.getCacheKey(session);
    if (!force && this.cachedStates.has(cacheKey)) {
      return cloneJson(this.cachedStates.get(cacheKey));
    }

    try {
      const payload = JSON.parse(await fs.readFile(this.getFilePath(session), "utf8"));
      const normalized = normalizeTopicControlPanelState(payload);
      this.cachedStates.set(cacheKey, normalized);
      return cloneJson(normalized);
    } catch (error) {
      if (error?.code === "ENOENT") {
        const emptyState = buildEmptyTopicControlPanelState();
        this.cachedStates.set(cacheKey, emptyState);
        return cloneJson(emptyState);
      }

      if (error instanceof SyntaxError) {
        await quarantineCorruptFile(this.getFilePath(session));
        const emptyState = buildEmptyTopicControlPanelState();
        this.cachedStates.set(cacheKey, emptyState);
        return cloneJson(emptyState);
      }

      throw error;
    }
  }

  async saveUnlocked(session, nextState) {
    const normalized = normalizeTopicControlPanelState({
      ...nextState,
      updated_at: new Date().toISOString(),
    });
    const filePath = this.getFilePath(session);
    await ensurePrivateDirectory(path.dirname(filePath));
    await writeTextAtomic(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
    this.cachedStates.set(this.getCacheKey(session), normalized);
    return cloneJson(normalized);
  }

  async save(session, nextState) {
    return this.runExclusive(session, () => this.saveUnlocked(session, nextState));
  }

  async patch(session, patch) {
    return this.patchWithCurrent(session, patch);
  }

  async patchWithCurrent(session, patch) {
    return this.runExclusive(session, async () => {
      const current = await this.load(session, { force: true });
      const resolvedPatch =
        typeof patch === "function"
          ? await patch(current)
          : patch;
      if (resolvedPatch === null || resolvedPatch === undefined) {
        return cloneJson(current);
      }
      if (
        typeof resolvedPatch !== "object"
        || Array.isArray(resolvedPatch)
      ) {
        throw new Error("TopicControlPanelStore patch must be an object or null");
      }

      return this.saveUnlocked(session, {
        ...current,
        ...resolvedPatch,
      });
    });
  }
}
