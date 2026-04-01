import fs from "node:fs/promises";
import path from "node:path";

import { normalizePromptSuffixText } from "./prompt-suffix.js";
import {
  cloneJson,
  quarantineCorruptFile,
  writeTextAtomic,
} from "../state/file-utils.js";

const GLOBAL_PROMPT_SUFFIX_FILE_NAME = "global-prompt-suffix.json";

function buildEmptyGlobalPromptSuffixState() {
  return {
    schema_version: 1,
    updated_at: null,
    prompt_suffix_text: null,
    prompt_suffix_enabled: false,
  };
}

function normalizeGlobalPromptSuffixState(payload) {
  const suffixText = normalizePromptSuffixText(payload?.prompt_suffix_text);

  return {
    schema_version: 1,
    updated_at: payload?.updated_at ?? null,
    prompt_suffix_text: suffixText,
    prompt_suffix_enabled: Boolean(payload?.prompt_suffix_enabled) && Boolean(suffixText),
  };
}

export class GlobalPromptSuffixStore {
  constructor(settingsRoot) {
    this.filePath = path.join(settingsRoot, GLOBAL_PROMPT_SUFFIX_FILE_NAME);
    this.cachedState = null;
  }

  async load({ force = false } = {}) {
    if (this.cachedState && !force) {
      return cloneJson(this.cachedState);
    }

    try {
      const payload = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.cachedState = normalizeGlobalPromptSuffixState(payload);
      return cloneJson(this.cachedState);
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.cachedState = buildEmptyGlobalPromptSuffixState();
        return cloneJson(this.cachedState);
      }

      if (error instanceof SyntaxError) {
        await quarantineCorruptFile(this.filePath);
        this.cachedState = buildEmptyGlobalPromptSuffixState();
        return cloneJson(this.cachedState);
      }

      throw error;
    }
  }

  async save(nextState) {
    const normalized = normalizeGlobalPromptSuffixState({
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
