import fs from "node:fs/promises";
import path from "node:path";

import {
  cloneJson,
  quarantineCorruptFile,
  writeTextAtomic,
} from "../state/file-utils.js";
import { normalizeUiLanguage } from "../i18n/ui-language.js";

const GLOBAL_CONTROL_PANEL_FILE_NAME = "global-control-panel.json";
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

function buildEmptyGlobalControlPanelState() {
  return {
    schema_version: 1,
    updated_at: null,
    menu_message_id: null,
    active_screen: "root",
    ui_language: "rus",
    pending_input: null,
  };
}

function normalizeGlobalControlPanelState(payload) {
  return {
    schema_version: 1,
    updated_at: payload?.updated_at ?? null,
    menu_message_id: normalizeInteger(payload?.menu_message_id),
    active_screen: normalizeScreenId(payload?.active_screen),
    ui_language: normalizeUiLanguage(payload?.ui_language),
    pending_input: normalizePendingInput(payload?.pending_input),
  };
}

export class GlobalControlPanelStore {
  constructor(settingsRoot) {
    this.filePath = path.join(settingsRoot, GLOBAL_CONTROL_PANEL_FILE_NAME);
    this.cachedState = null;
  }

  async load({ force = false } = {}) {
    if (this.cachedState && !force) {
      return cloneJson(this.cachedState);
    }

    try {
      const payload = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.cachedState = normalizeGlobalControlPanelState(payload);
      return cloneJson(this.cachedState);
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.cachedState = buildEmptyGlobalControlPanelState();
        return cloneJson(this.cachedState);
      }

      if (error instanceof SyntaxError) {
        await quarantineCorruptFile(this.filePath);
        this.cachedState = buildEmptyGlobalControlPanelState();
        return cloneJson(this.cachedState);
      }

      throw error;
    }
  }

  async save(nextState) {
    const normalized = normalizeGlobalControlPanelState({
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

  async patch(patch) {
    const current = await this.load();
    return this.save({
      ...current,
      ...patch,
    });
  }
}
