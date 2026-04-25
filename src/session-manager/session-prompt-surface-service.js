import { normalizeUiLanguage } from "../i18n/ui-language.js";
import { normalizePromptSuffixText } from "./prompt-suffix.js";

function buildEmptyGlobalPromptSuffixState() {
  return {
    updated_at: null,
    prompt_suffix_text: null,
    prompt_suffix_enabled: false,
  };
}

export class SessionPromptSurfaceService {
  constructor({ sessionStore, globalPromptSuffixStore = null }) {
    this.sessionStore = sessionStore;
    this.globalPromptSuffixStore = globalPromptSuffixStore;
  }

  async updatePromptSuffix(
    session,
    {
      text = session.prompt_suffix_text ?? null,
      enabled = session.prompt_suffix_enabled ?? false,
    } = {},
  ) {
    return this.sessionStore.patch(session, {
      prompt_suffix_text: normalizePromptSuffixText(text),
      prompt_suffix_enabled: Boolean(enabled),
    });
  }

  async clearPromptSuffix(session) {
    return this.sessionStore.patch(session, {
      prompt_suffix_text: null,
      prompt_suffix_enabled: false,
    });
  }

  async updatePromptSuffixTopicState(
    session,
    { enabled = session.prompt_suffix_topic_enabled !== false } = {},
  ) {
    return this.sessionStore.patch(session, {
      prompt_suffix_topic_enabled: Boolean(enabled),
    });
  }

  async updateUiLanguage(session, { language = session.ui_language } = {}) {
    return this.sessionStore.patch(session, {
      ui_language: normalizeUiLanguage(language),
    });
  }

  async getGlobalPromptSuffix() {
    if (!this.globalPromptSuffixStore) {
      return {
        prompt_suffix_text: null,
        prompt_suffix_enabled: false,
      };
    }

    return this.globalPromptSuffixStore.load();
  }

  async updateGlobalPromptSuffix({
    text,
    enabled,
  } = {}) {
    const current = await this.getGlobalPromptSuffix();
    if (!this.globalPromptSuffixStore) {
      const suffixText = normalizePromptSuffixText(
        text ?? current.prompt_suffix_text ?? null,
      );

      return {
        ...buildEmptyGlobalPromptSuffixState(),
        updated_at: current.updated_at ?? null,
        prompt_suffix_text: suffixText,
        prompt_suffix_enabled: Boolean(enabled ?? current.prompt_suffix_enabled) && Boolean(suffixText),
      };
    }

    return this.globalPromptSuffixStore.patch({
      prompt_suffix_text: normalizePromptSuffixText(
        text ?? current.prompt_suffix_text ?? null,
      ),
      prompt_suffix_enabled: Boolean(enabled ?? current.prompt_suffix_enabled),
    });
  }

  async clearGlobalPromptSuffix() {
    if (!this.globalPromptSuffixStore) {
      return buildEmptyGlobalPromptSuffixState();
    }

    return this.globalPromptSuffixStore.patch({
      prompt_suffix_text: null,
      prompt_suffix_enabled: false,
    });
  }
}
