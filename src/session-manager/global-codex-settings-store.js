import fs from "node:fs/promises";
import path from "node:path";

import {
  buildEmptyGlobalCodexSettingsState,
  normalizeGlobalCodexSettingsState,
} from "./codex-runtime-settings.js";
import {
  cloneJson,
  quarantineCorruptFile,
  writeTextAtomic,
} from "../state/file-utils.js";

const GLOBAL_CODEX_SETTINGS_FILE_NAME = "global-codex-settings.json";

export class GlobalCodexSettingsStore {
  constructor(settingsRoot) {
    this.filePath = path.join(settingsRoot, GLOBAL_CODEX_SETTINGS_FILE_NAME);
    this.cachedState = null;
    this.writeChain = null;
  }

  async runExclusive(operation) {
    const previous = this.writeChain || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(operation);

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
      this.cachedState = normalizeGlobalCodexSettingsState(payload);
      return cloneJson(this.cachedState);
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.cachedState = buildEmptyGlobalCodexSettingsState();
        return cloneJson(this.cachedState);
      }

      if (error instanceof SyntaxError) {
        await quarantineCorruptFile(this.filePath);
        this.cachedState = buildEmptyGlobalCodexSettingsState();
        return cloneJson(this.cachedState);
      }

      throw error;
    }
  }

  async saveUnlocked(nextState) {
    const normalized = normalizeGlobalCodexSettingsState({
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

  async save(nextState) {
    return this.runExclusive(() => this.saveUnlocked(nextState));
  }

  async patch(patch) {
    return this.patchWithCurrent(patch);
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
        throw new Error("GlobalCodexSettingsStore patch must be an object or null");
      }

      return this.saveUnlocked({
        ...current,
        ...resolvedPatch,
      });
    });
  }
}
