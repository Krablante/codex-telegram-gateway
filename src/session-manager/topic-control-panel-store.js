import fs from "node:fs/promises";
import path from "node:path";

import {
  cloneJson,
  quarantineCorruptFile,
  writeTextAtomic,
} from "../state/file-utils.js";

const TOPIC_CONTROL_PANEL_FILE_NAME = "topic-control-panel.json";
const SCREEN_IDS = new Set([
  "root",
  "wait",
  "suffix",
  "language",
  "spike_model",
  "spike_reasoning",
  "omni_model",
  "omni_reasoning",
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
  };
}

function buildEmptyTopicControlPanelState() {
  return {
    schema_version: 1,
    updated_at: null,
    menu_message_id: null,
    active_screen: "root",
    pending_input: null,
  };
}

function normalizeTopicControlPanelState(payload) {
  return {
    schema_version: 1,
    updated_at: payload?.updated_at ?? null,
    menu_message_id: normalizeInteger(payload?.menu_message_id),
    active_screen: normalizeScreenId(payload?.active_screen),
    pending_input: normalizePendingInput(payload?.pending_input),
  };
}

export class TopicControlPanelStore {
  constructor(sessionStore) {
    if (!sessionStore) {
      throw new Error("TopicControlPanelStore requires a sessionStore");
    }

    this.sessionStore = sessionStore;
    this.cachedStates = new Map();
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

  async save(session, nextState) {
    const normalized = normalizeTopicControlPanelState({
      ...nextState,
      updated_at: new Date().toISOString(),
    });
    const filePath = this.getFilePath(session);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeTextAtomic(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
    this.cachedStates.set(this.getCacheKey(session), normalized);
    return cloneJson(normalized);
  }

  async patch(session, patch) {
    const current = await this.load(session);
    return this.save(session, {
      ...current,
      ...patch,
    });
  }
}
