import fs from "node:fs/promises";
import path from "node:path";

import {
  cloneJson,
  quarantineCorruptFile,
  writeTextAtomic,
} from "../state/file-utils.js";

const ROLLOUT_COORDINATION_FILE_NAME = "rollout-coordination.json";
const ROLLOUT_COORDINATION_STATUSES = new Set([
  "idle",
  "requested",
  "in_progress",
  "completed",
  "failed",
]);

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeStatus(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ROLLOUT_COORDINATION_STATUSES.has(normalized)
    ? normalized
    : "idle";
}

function normalizeSessionKeys(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))].sort();
}

export function buildEmptyRolloutCoordinationState() {
  return {
    schema_version: 1,
    updated_at: null,
    status: "idle",
    current_generation_id: null,
    target_generation_id: null,
    retiring_generation_id: null,
    requested_at: null,
    requested_by: null,
    started_at: null,
    finished_at: null,
    retained_session_keys: [],
    last_error: null,
  };
}

export function normalizeRolloutCoordinationState(payload = null) {
  const normalized = {
    ...buildEmptyRolloutCoordinationState(),
    schema_version: 1,
    updated_at: normalizeText(payload?.updated_at),
    status: normalizeStatus(payload?.status),
    current_generation_id: normalizeText(payload?.current_generation_id),
    target_generation_id: normalizeText(payload?.target_generation_id),
    retiring_generation_id: normalizeText(payload?.retiring_generation_id),
    requested_at: normalizeText(payload?.requested_at),
    requested_by: normalizeText(payload?.requested_by),
    started_at: normalizeText(payload?.started_at),
    finished_at: normalizeText(payload?.finished_at),
    retained_session_keys: normalizeSessionKeys(payload?.retained_session_keys),
    last_error: normalizeText(payload?.last_error),
  };

  if (normalized.status === "idle") {
    normalized.last_error = normalized.last_error ?? null;
  }

  return normalized;
}

export class RolloutCoordinationStore {
  constructor(settingsRoot) {
    this.settingsRoot = settingsRoot;
    this.filePath = path.join(
      settingsRoot,
      ROLLOUT_COORDINATION_FILE_NAME,
    );
    this.cachedState = null;
    this.writeChain = null;
  }

  getFilePath() {
    return this.filePath;
  }

  async runExclusive(operation) {
    const previous = this.writeChain || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.writeChain = current;

    try {
      return await current;
    } finally {
      if (this.writeChain === current) {
        this.writeChain = null;
      }
    }
  }

  async load({ force = false } = {}) {
    if (this.cachedState && !force) {
      return cloneJson(this.cachedState);
    }

    try {
      const payload = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.cachedState = normalizeRolloutCoordinationState(payload);
      return cloneJson(this.cachedState);
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.cachedState = buildEmptyRolloutCoordinationState();
        return cloneJson(this.cachedState);
      }

      if (error instanceof SyntaxError) {
        await quarantineCorruptFile(this.filePath);
        this.cachedState = buildEmptyRolloutCoordinationState();
        return cloneJson(this.cachedState);
      }

      throw error;
    }
  }

  async saveUnlocked(nextState) {
    const normalized = normalizeRolloutCoordinationState({
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

  async patchWithCurrent(patch) {
    return this.runExclusive(async () => {
      const current = await this.load({ force: true });
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
        throw new Error(
          "RolloutCoordinationStore patch must be an object or null",
        );
      }

      return this.saveUnlocked({
        ...current,
        ...resolvedPatch,
      });
    });
  }

  async requestRollout({
    currentGenerationId = null,
    targetGenerationId = null,
    requestedBy = "admin",
  } = {}) {
    return this.patchWithCurrent({
      status: "requested",
      current_generation_id: currentGenerationId,
      target_generation_id: targetGenerationId,
      requested_at: new Date().toISOString(),
      requested_by: requestedBy,
      started_at: null,
      finished_at: null,
      retained_session_keys: [],
      last_error: null,
    });
  }

  async startRollout({
    currentGenerationId,
    targetGenerationId,
    retiringGenerationId = null,
    retainedSessionKeys = [],
  }) {
    return this.patchWithCurrent({
      status: "in_progress",
      current_generation_id: currentGenerationId,
      target_generation_id: targetGenerationId,
      retiring_generation_id: retiringGenerationId,
      started_at: new Date().toISOString(),
      finished_at: null,
      retained_session_keys: retainedSessionKeys,
      last_error: null,
    });
  }

  async completeRollout({
    currentGenerationId,
    targetGenerationId = null,
  }) {
    return this.patchWithCurrent({
      status: "completed",
      current_generation_id: currentGenerationId,
      target_generation_id: targetGenerationId,
      retiring_generation_id: null,
      finished_at: new Date().toISOString(),
      retained_session_keys: [],
      last_error: null,
    });
  }

  async failRollout(errorMessage, details = {}) {
    return this.patchWithCurrent({
      status: "failed",
      current_generation_id: details.currentGenerationId ?? null,
      target_generation_id: details.targetGenerationId ?? null,
      retiring_generation_id: details.retiringGenerationId ?? null,
      finished_at: new Date().toISOString(),
      last_error: normalizeText(errorMessage),
    });
  }

  async clear() {
    return this.saveUnlocked(buildEmptyRolloutCoordinationState());
  }
}
