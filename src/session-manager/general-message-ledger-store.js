import fs from "node:fs/promises";
import path from "node:path";

import {
  cloneJson,
  quarantineCorruptFile,
  writeTextAtomic,
} from "../state/file-utils.js";

const GENERAL_MESSAGE_LEDGER_FILE_NAME = "general-message-ledger.json";
const MAX_TRACKED_MESSAGE_IDS = 4096;

function normalizeInteger(value) {
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    return normalizeInteger(Number(value));
  }

  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeTrackedMessageIds(values) {
  const unique = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeInteger(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    unique.push(normalized);
    seen.add(normalized);
  }

  if (unique.length <= MAX_TRACKED_MESSAGE_IDS) {
    return unique;
  }

  return unique.slice(unique.length - MAX_TRACKED_MESSAGE_IDS);
}

function buildEmptyGeneralMessageLedgerState() {
  return {
    schema_version: 1,
    updated_at: null,
    tracked_message_ids: [],
  };
}

function normalizeGeneralMessageLedgerState(payload) {
  return {
    schema_version: 1,
    updated_at: payload?.updated_at ?? null,
    tracked_message_ids: normalizeTrackedMessageIds(payload?.tracked_message_ids),
  };
}

export class GeneralMessageLedgerStore {
  constructor(settingsRoot) {
    this.filePath = path.join(settingsRoot, GENERAL_MESSAGE_LEDGER_FILE_NAME);
    this.cachedState = null;
  }

  async load({ force = false } = {}) {
    if (this.cachedState && !force) {
      return cloneJson(this.cachedState);
    }

    try {
      const payload = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.cachedState = normalizeGeneralMessageLedgerState(payload);
      return cloneJson(this.cachedState);
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.cachedState = buildEmptyGeneralMessageLedgerState();
        return cloneJson(this.cachedState);
      }

      if (error instanceof SyntaxError) {
        await quarantineCorruptFile(this.filePath);
        this.cachedState = buildEmptyGeneralMessageLedgerState();
        return cloneJson(this.cachedState);
      }

      throw error;
    }
  }

  async save(nextState) {
    const normalized = normalizeGeneralMessageLedgerState({
      ...nextState,
      updated_at: new Date().toISOString(),
    });

    await writeTextAtomic(
      this.filePath,
      `${JSON.stringify(normalized, null, 2)}\n`,
    );
    this.cachedState = normalized;
    return cloneJson(this.cachedState);
  }

  async trackMessageId(messageId) {
    const normalized = normalizeInteger(messageId);
    if (!normalized) {
      return this.load();
    }

    const current = await this.load();
    return this.save({
      ...current,
      tracked_message_ids: normalizeTrackedMessageIds([
        ...current.tracked_message_ids,
        normalized,
      ]),
    });
  }

  async forgetMessageIds(messageIds) {
    const removeIds = new Set(normalizeTrackedMessageIds(messageIds));
    if (removeIds.size === 0) {
      return this.load();
    }

    const current = await this.load();
    return this.save({
      ...current,
      tracked_message_ids: current.tracked_message_ids.filter(
        (messageId) => !removeIds.has(messageId),
      ),
    });
  }
}
