import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  cloneJson,
  ensurePrivateDirectory,
  quarantineCorruptFile,
  writeTextAtomic,
} from "../state/file-utils.js";
import { normalizeUiLanguage } from "../i18n/ui-language.js";
import { ZOO_CREATURE_KINDS } from "./creatures.js";

const TOPIC_FILE_NAME = "topic.json";
const PET_FILE_NAME = "pet.json";
const LATEST_SNAPSHOT_FILE_NAME = "latest-snapshot.json";
const HISTORY_DIR_NAME = "history";
const PETS_DIR_NAME = "pets";
const RUNS_DIR_NAME = "runs";
const VALID_SCREENS = new Set(["root", "pet", "remove_confirm"]);
const VALID_PENDING_ADD_STAGES = new Set([
  "await_description",
  "await_confirmation",
]);
const VALID_TRENDS = new Set(["up", "down", "same"]);
const DEFAULT_STATS = {
  security: 0,
  shitcode: 0,
  junk: 0,
  tests: 0,
  structure: 0,
  docs: 0,
  operability: 0,
};
function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const normalized = normalizeText(entry);
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeIntegerArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const result = [];
  for (const entry of value) {
    const normalized = normalizeInteger(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeScreenId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return VALID_SCREENS.has(normalized) ? normalized : "root";
}

function normalizePendingAdd(value) {
  const stage = String(value?.stage ?? "").trim().toLowerCase();
  if (!VALID_PENDING_ADD_STAGES.has(stage)) {
    return null;
  }

  return {
    kind: "add_project",
    stage,
    busy: Boolean(value?.busy),
    requested_at: normalizeText(value?.requested_at),
    requested_by_user_id: normalizeText(value?.requested_by_user_id),
    lookup_request_id: normalizeText(value?.lookup_request_id),
    prompt_message_id: normalizeInteger(value?.prompt_message_id),
    candidate_message_id: normalizeInteger(value?.candidate_message_id),
    description: normalizeText(value?.description),
    candidate_path: normalizeText(value?.candidate_path),
    candidate_display_name: normalizeText(value?.candidate_display_name),
    candidate_reason: normalizeText(value?.candidate_reason),
    candidate_question: normalizeText(value?.candidate_question),
    prompt_hint_text: normalizeText(value?.prompt_hint_text),
    cleanup_message_ids: normalizeIntegerArray(value?.cleanup_message_ids),
  };
}

function clampStatValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function normalizeTrendMap(value) {
  if (!value || typeof value !== "object") {
    return {
      security: "same",
      shitcode: "same",
      junk: "same",
      tests: "same",
      structure: "same",
      docs: "same",
      operability: "same",
    };
  }

  const trends = {};
  for (const key of Object.keys(DEFAULT_STATS)) {
    const normalized = String(value[key] ?? "").trim().toLowerCase();
    trends[key] = VALID_TRENDS.has(normalized) ? normalized : "same";
  }
  return trends;
}

function normalizeStats(value) {
  const next = {};
  for (const key of Object.keys(DEFAULT_STATS)) {
    next[key] = clampStatValue(value?.[key]);
  }
  return next;
}

function buildEmptyTopicState() {
  return {
    schema_version: 1,
    updated_at: null,
    chat_id: null,
    topic_id: null,
    topic_name: "Zoo",
    ui_language: "rus",
    menu_message_id: null,
    active_screen: "root",
    selected_pet_id: null,
    root_page: 0,
    pending_add: null,
    refreshing_pet_id: null,
    refresh_status_text: null,
    last_refresh_error_text: null,
  };
}

function normalizeTopicState(value) {
  return {
    schema_version: 1,
    updated_at: normalizeText(value?.updated_at),
    chat_id: normalizeText(value?.chat_id),
    topic_id: normalizeText(value?.topic_id),
    topic_name: normalizeText(value?.topic_name) || "Zoo",
    ui_language: normalizeUiLanguage(value?.ui_language),
    menu_message_id: normalizeInteger(value?.menu_message_id),
    active_screen: normalizeScreenId(value?.active_screen),
    selected_pet_id: normalizeText(value?.selected_pet_id),
    root_page: normalizeNonNegativeInteger(value?.root_page),
    pending_add: normalizePendingAdd(value?.pending_add),
    refreshing_pet_id: normalizeText(value?.refreshing_pet_id),
    refresh_status_text: normalizeText(value?.refresh_status_text),
    last_refresh_error_text: normalizeText(value?.last_refresh_error_text),
  };
}

function normalizePet(value) {
  const petId = normalizeText(value?.pet_id);
  if (!petId) {
    return null;
  }

  return {
    schema_version: 1,
    pet_id: petId,
    created_at: normalizeText(value?.created_at) || new Date().toISOString(),
    updated_at: normalizeText(value?.updated_at) || new Date().toISOString(),
    display_name: normalizeText(value?.display_name) || petId,
    resolved_path: normalizeText(value?.resolved_path),
    repo_root: normalizeText(value?.repo_root),
    cwd: normalizeText(value?.cwd),
    cwd_relative_to_workspace_root: normalizeText(value?.cwd_relative_to_workspace_root),
    creature_kind: normalizeText(value?.creature_kind) || pickCreatureKind(petId),
    character_name: normalizeText(value?.character_name),
    temperament_id: normalizeText(value?.temperament_id),
    tags: normalizeStringArray(value?.tags),
  };
}

export function normalizeSnapshot(value) {
  const petId = normalizeText(value?.pet_id);
  if (!petId) {
    return null;
  }

  return {
    schema_version: 1,
    pet_id: petId,
    created_at: normalizeText(value?.created_at) || new Date().toISOString(),
    refreshed_at: normalizeText(value?.refreshed_at) || new Date().toISOString(),
    display_name: normalizeText(value?.display_name) || petId,
    resolved_path: normalizeText(value?.resolved_path),
    creature_kind: normalizeText(value?.creature_kind) || pickCreatureKind(petId),
    mood: normalizeText(value?.mood) || "neutral",
    flavor_line: normalizeText(value?.flavor_line),
    project_summary: normalizeText(value?.project_summary),
    next_focus: normalizeText(value?.next_focus),
    findings: normalizeStringArray(value?.findings).slice(0, 5),
    stats: normalizeStats(value?.stats),
    trends: normalizeTrendMap(value?.trends),
  };
}

function buildHistoryFileName(refreshedAt = new Date().toISOString()) {
  return `${refreshedAt.replace(/[-:.TZ]/gu, "")}.json`;
}

export function buildPetIdFromPath(resolvedPath) {
  return crypto
    .createHash("sha1")
    .update(String(resolvedPath || ""))
    .digest("hex")
    .slice(0, 12);
}

function pickCreatureKind(seed) {
  const digest = crypto
    .createHash("sha1")
    .update(String(seed || ""))
    .digest();
  return ZOO_CREATURE_KINDS[digest[0] % ZOO_CREATURE_KINDS.length];
}

export class ZooStore {
  constructor(stateRoot) {
    this.root = path.join(stateRoot, "zoo");
    this.topicFilePath = path.join(this.root, TOPIC_FILE_NAME);
    this.petsDir = path.join(this.root, PETS_DIR_NAME);
    this.runsDir = path.join(this.root, RUNS_DIR_NAME);
    this.cachedTopicState = null;
  }

  getPetDir(petId) {
    return path.join(this.petsDir, String(petId || ""));
  }

  getPetFilePath(petId) {
    return path.join(this.getPetDir(petId), PET_FILE_NAME);
  }

  getLatestSnapshotPath(petId) {
    return path.join(this.getPetDir(petId), LATEST_SNAPSHOT_FILE_NAME);
  }

  getSnapshotHistoryDir(petId) {
    return path.join(this.getPetDir(petId), HISTORY_DIR_NAME);
  }

  async ensureBaseDirs() {
    await ensurePrivateDirectory(this.root);
    await ensurePrivateDirectory(this.petsDir);
    await ensurePrivateDirectory(this.runsDir);
  }

  async loadTopic({ force = false } = {}) {
    if (this.cachedTopicState && !force) {
      return cloneJson(this.cachedTopicState);
    }

    try {
      const payload = JSON.parse(await fs.readFile(this.topicFilePath, "utf8"));
      this.cachedTopicState = normalizeTopicState(payload);
      return cloneJson(this.cachedTopicState);
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.cachedTopicState = buildEmptyTopicState();
        return cloneJson(this.cachedTopicState);
      }
      if (error instanceof SyntaxError) {
        await quarantineCorruptFile(this.topicFilePath);
        this.cachedTopicState = buildEmptyTopicState();
        return cloneJson(this.cachedTopicState);
      }
      throw error;
    }
  }

  readTopicState() {
    return this.cachedTopicState ? cloneJson(this.cachedTopicState) : buildEmptyTopicState();
  }

  async saveTopic(nextState) {
    await this.ensureBaseDirs();
    const normalized = normalizeTopicState({
      ...nextState,
      updated_at: new Date().toISOString(),
    });
    await writeTextAtomic(
      this.topicFilePath,
      `${JSON.stringify(normalized, null, 2)}\n`,
    );
    this.cachedTopicState = normalized;
    return cloneJson(normalized);
  }

  async patchTopic(patch) {
    const current = await this.loadTopic();
    return this.saveTopic({
      ...current,
      ...patch,
    });
  }

  async loadPet(petId) {
    const filePath = this.getPetFilePath(petId);
    try {
      const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
      return normalizePet(payload);
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

  async savePet(value) {
    const normalized = normalizePet(value);
    if (!normalized) {
      throw new Error("savePet requires pet metadata with pet_id");
    }

    const filePath = this.getPetFilePath(normalized.pet_id);
    await ensurePrivateDirectory(path.dirname(filePath));
    await writeTextAtomic(filePath, `${JSON.stringify(normalized, null, 2)}\n`);
    return cloneJson(normalized);
  }

  async listPets() {
    await this.ensureBaseDirs();
    let entries;
    try {
      entries = await fs.readdir(this.petsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const pets = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pet = await this.loadPet(entry.name);
      if (pet) {
        pets.push(pet);
      }
    }

    return pets.sort((left, right) =>
      String(left.display_name || left.pet_id).localeCompare(
        String(right.display_name || right.pet_id),
      ));
  }

  async findPetByResolvedPath(resolvedPath) {
    const normalizedPath = normalizeText(resolvedPath);
    if (!normalizedPath) {
      return null;
    }

    const pets = await this.listPets();
    return (
      pets.find(
        (pet) =>
          pet.cwd === normalizedPath
          || pet.resolved_path === normalizedPath
          || pet.repo_root === normalizedPath,
      ) || null
    );
  }

  async deletePet(petId) {
    await fs.rm(this.getPetDir(petId), { recursive: true, force: true });
  }

  async loadLatestSnapshot(petId) {
    const filePath = this.getLatestSnapshotPath(petId);
    try {
      const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
      return normalizeSnapshot(payload);
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

  async saveLatestSnapshot(petId, snapshot) {
    const normalized = normalizeSnapshot({
      ...snapshot,
      pet_id: petId,
    });
    if (!normalized) {
      throw new Error("saveLatestSnapshot requires a valid snapshot payload");
    }

    const latestPath = this.getLatestSnapshotPath(petId);
    const historyDir = this.getSnapshotHistoryDir(petId);
    await ensurePrivateDirectory(path.dirname(latestPath));
    await ensurePrivateDirectory(historyDir);
    const text = `${JSON.stringify(normalized, null, 2)}\n`;
    await writeTextAtomic(latestPath, text);
    await writeTextAtomic(
      path.join(historyDir, buildHistoryFileName(normalized.refreshed_at)),
      text,
    );
    return cloneJson(normalized);
  }
}
