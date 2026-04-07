import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_CODEX_CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
const DEFAULT_MODELS_CACHE_FILE_NAME = "models_cache.json";

export const BUILTIN_CODEX_MODELS = [
  { slug: "gpt-5.4", displayName: "GPT-5.4" },
  { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" },
  { slug: "gpt-5.3-codex", displayName: "GPT-5.3-Codex" },
  { slug: "gpt-5.2-codex", displayName: "GPT-5.2-Codex" },
  { slug: "gpt-5.2", displayName: "GPT-5.2" },
  { slug: "gpt-5.1-codex-max", displayName: "GPT-5.1-Codex-Max" },
  { slug: "gpt-5.1-codex-mini", displayName: "GPT-5.1-Codex-Mini" },
];

export const CODEX_REASONING_EFFORTS = [
  { value: "none", label: "None" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

const DEFAULT_CODEX_REASONING_EFFORTS = CODEX_REASONING_EFFORTS.filter(
  (entry) => ["low", "medium", "high", "xhigh"].includes(entry.value),
);

const GLOBAL_RUNTIME_SETTING_TARGETS = new Set(["spike", "omni", "compact"]);
const SESSION_RUNTIME_SETTING_TARGETS = new Set(["spike", "omni"]);
const RUNTIME_SETTING_KINDS = new Set(["model", "reasoning"]);

function normalizeString(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

function normalizeDisplayName(value) {
  return normalizeString(value)
    ?.replace(/\s+/gu, " ")
    .replace(/\bmini\b/giu, "Mini")
    .replace(/\bcodex\b/giu, "Codex")
    .replace(/\bmax\b/giu, "Max")
    .replace(/\bgpt\b/giu, "GPT");
}

export function getCodexModelsCachePath(configPath = DEFAULT_CODEX_CONFIG_PATH) {
  return path.join(path.dirname(configPath || DEFAULT_CODEX_CONFIG_PATH), DEFAULT_MODELS_CACHE_FILE_NAME);
}

export async function loadAvailableCodexModels({
  configPath = DEFAULT_CODEX_CONFIG_PATH,
  modelsCachePath = getCodexModelsCachePath(configPath),
} = {}) {
  try {
    const payload = JSON.parse(await fs.readFile(modelsCachePath, "utf8"));
    const models = Array.isArray(payload?.models) ? payload.models : [];
    const seen = new Set();
    const normalized = [];

    for (const model of models) {
      const slug = normalizeString(model?.slug)?.toLowerCase();
      if (!slug || seen.has(slug)) {
        continue;
      }

      seen.add(slug);
      normalized.push({
        slug,
        displayName: normalizeDisplayName(model?.display_name) || slug,
        defaultReasoningLevel:
          normalizeReasoningEffort(model?.default_reasoning_level) ?? null,
        supportedReasoningLevels: Array.isArray(model?.supported_reasoning_levels)
          ? model.supported_reasoning_levels
            .map((entry) => ({
              effort: normalizeReasoningEffort(entry?.effort),
              description: normalizeString(entry?.description),
            }))
            .filter((entry) => entry.effort)
          : [],
      });
    }

    return normalized.length > 0 ? normalized : BUILTIN_CODEX_MODELS;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return BUILTIN_CODEX_MODELS;
    }

    throw error;
  }
}

export function normalizeRuntimeSettingTarget(target, { scope = "any" } = {}) {
  const normalized = String(target ?? "").trim().toLowerCase();
  if (scope === "session") {
    return SESSION_RUNTIME_SETTING_TARGETS.has(normalized) ? normalized : null;
  }

  if (scope === "global" || scope === "any") {
    return GLOBAL_RUNTIME_SETTING_TARGETS.has(normalized) ? normalized : null;
  }

  return null;
}

export function normalizeRuntimeSettingKind(kind) {
  const normalized = String(kind ?? "").trim().toLowerCase();
  return RUNTIME_SETTING_KINDS.has(normalized) ? normalized : null;
}

export function normalizeModelOverride(value, availableModels = BUILTIN_CODEX_MODELS) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  const lowered = normalized.toLowerCase();
  for (const model of availableModels) {
    if (lowered === model.slug.toLowerCase()) {
      return model.slug;
    }

    if (lowered === String(model.displayName || "").trim().toLowerCase()) {
      return model.slug;
    }
  }

  return null;
}

export function normalizeStoredModelOverride(value) {
  return normalizeString(value)?.toLowerCase() ?? null;
}

export function normalizeReasoningEffort(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  const lowered = normalized
    .toLowerCase()
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (lowered === "extra high") {
    return "xhigh";
  }

  return CODEX_REASONING_EFFORTS.some((entry) => entry.value === lowered)
    ? lowered
    : null;
}

export function formatReasoningEffort(value) {
  const normalized = normalizeReasoningEffort(value);
  if (!normalized) {
    return null;
  }

  const entry = CODEX_REASONING_EFFORTS.find((option) => option.value === normalized);
  return entry ? `${entry.label} (${entry.value})` : normalized;
}

export function getSupportedReasoningLevelsForModel(
  availableModels,
  modelSlug,
) {
  const normalizedModel = normalizeString(modelSlug)?.toLowerCase();
  if (!normalizedModel) {
    return DEFAULT_CODEX_REASONING_EFFORTS;
  }

  const model = (availableModels || []).find(
    (entry) => entry.slug.toLowerCase() === normalizedModel,
  );
  if (!model || !Array.isArray(model.supportedReasoningLevels) || model.supportedReasoningLevels.length === 0) {
    return DEFAULT_CODEX_REASONING_EFFORTS;
  }

  return model.supportedReasoningLevels.map((entry) => {
    const matched = CODEX_REASONING_EFFORTS.find(
      (option) => option.value === entry.effort,
    );
    return {
      value: entry.effort,
      label: matched?.label || entry.effort,
      description: entry.description ?? null,
    };
  });
}

export function buildEmptyGlobalCodexSettingsState() {
  return {
    schema_version: 1,
    updated_at: null,
    spike_model: null,
    spike_reasoning_effort: null,
    omni_model: null,
    omni_reasoning_effort: null,
    compact_model: null,
    compact_reasoning_effort: null,
  };
}

export function normalizeGlobalCodexSettingsState(payload) {
  return {
    schema_version: 1,
    updated_at: payload?.updated_at ?? null,
    spike_model: normalizeString(payload?.spike_model)?.toLowerCase() ?? null,
    spike_reasoning_effort: normalizeReasoningEffort(payload?.spike_reasoning_effort),
    omni_model: normalizeString(payload?.omni_model)?.toLowerCase() ?? null,
    omni_reasoning_effort: normalizeReasoningEffort(payload?.omni_reasoning_effort),
    compact_model: normalizeString(payload?.compact_model)?.toLowerCase() ?? null,
    compact_reasoning_effort: normalizeReasoningEffort(payload?.compact_reasoning_effort),
  };
}

export function getSessionRuntimeSettingFieldName(target, kind) {
  const normalizedTarget = normalizeRuntimeSettingTarget(target, { scope: "session" });
  const normalizedKind = normalizeRuntimeSettingKind(kind);
  if (!normalizedTarget || !normalizedKind) {
    return null;
  }

  return `${normalizedTarget}_${normalizedKind === "model" ? "model_override" : "reasoning_effort_override"}`;
}

export function getGlobalRuntimeSettingFieldName(target, kind) {
  const normalizedTarget = normalizeRuntimeSettingTarget(target, { scope: "global" });
  const normalizedKind = normalizeRuntimeSettingKind(kind);
  if (!normalizedTarget || !normalizedKind) {
    return null;
  }

  return `${normalizedTarget}_${normalizedKind === "model" ? "model" : "reasoning_effort"}`;
}

function buildResolvedValue({ sessionValue, globalValue, fallbackValue }) {
  if (sessionValue) {
    return {
      value: sessionValue,
      source: "topic",
    };
  }

  if (globalValue) {
    return {
      value: globalValue,
      source: "global",
    };
  }

  if (fallbackValue) {
    return {
      value: fallbackValue,
      source: "default",
    };
  }

  return {
    value: null,
    source: "unset",
  };
}

function findAvailableModel(availableModels, modelSlug) {
  const normalizedModel = normalizeStoredModelOverride(modelSlug);
  if (!normalizedModel) {
    return null;
  }

  return (availableModels || []).find(
    (entry) => normalizeStoredModelOverride(entry?.slug) === normalizedModel,
  ) || null;
}

function resolveCompatibleReasoningValue({
  availableModels = null,
  modelSlug = null,
  sessionValue = null,
  globalValue = null,
  fallbackValue = null,
} = {}) {
  if (!availableModels) {
    return buildResolvedValue({
      sessionValue,
      globalValue,
      fallbackValue,
    });
  }

  const supportedLevels = getSupportedReasoningLevelsForModel(
    availableModels,
    modelSlug,
  );
  const supportedValues = new Set(
    supportedLevels
      .map((entry) => normalizeReasoningEffort(entry?.value ?? entry?.effort))
      .filter(Boolean),
  );
  const isSupported = (value) => supportedValues.has(normalizeReasoningEffort(value));

  if (sessionValue && isSupported(sessionValue)) {
    return {
      value: sessionValue,
      source: "topic",
    };
  }

  if (globalValue && isSupported(globalValue)) {
    return {
      value: globalValue,
      source: "global",
    };
  }

  if (fallbackValue && isSupported(fallbackValue)) {
    return {
      value: fallbackValue,
      source: "default",
    };
  }

  const model = findAvailableModel(availableModels, modelSlug);
  const modelDefaultReasoning = normalizeReasoningEffort(
    model?.defaultReasoningLevel,
  );
  if (modelDefaultReasoning && isSupported(modelDefaultReasoning)) {
    return {
      value: modelDefaultReasoning,
      source: "default",
    };
  }

  const firstSupported = supportedLevels.find((entry) => entry?.value)?.value ?? null;
  if (firstSupported) {
    return {
      value: firstSupported,
      source: "default",
    };
  }

  return {
    value: null,
    source: "unset",
  };
}

export function resolveCodexRuntimeProfile({
  session,
  globalSettings = null,
  config,
  target = "spike",
  availableModels = null,
} = {}) {
  const fallbackReasoningEffort =
    target === "omni"
      ? normalizeReasoningEffort(config?.omniDefaultReasoningEffort) || "high"
      : normalizeReasoningEffort(config?.codexReasoningEffort);
  const modelField = getSessionRuntimeSettingFieldName(target, "model");
  const reasoningField = getSessionRuntimeSettingFieldName(target, "reasoning");
  const globalModelField = getGlobalRuntimeSettingFieldName(target, "model");
  const globalReasoningField = getGlobalRuntimeSettingFieldName(target, "reasoning");
  const model = buildResolvedValue({
    sessionValue:
      modelField
        ? normalizeString(session?.[modelField])?.toLowerCase() ?? null
        : null,
    globalValue: normalizeString(globalSettings?.[globalModelField])?.toLowerCase() ?? null,
    fallbackValue: normalizeString(config?.codexModel)?.toLowerCase() ?? null,
  });
  const reasoningEffort = resolveCompatibleReasoningValue({
    availableModels,
    modelSlug: model.value,
    sessionValue: reasoningField ? normalizeReasoningEffort(session?.[reasoningField]) : null,
    globalValue: normalizeReasoningEffort(globalSettings?.[globalReasoningField]),
    fallbackValue: fallbackReasoningEffort,
  });

  return {
    model: model.value,
    modelSource: model.source,
    reasoningEffort: reasoningEffort.value,
    reasoningSource: reasoningEffort.source,
  };
}
