import {
  buildDefaultAutoModeState,
  normalizeAutoModeState,
} from "./auto-mode.js";
import {
  normalizeStoredModelOverride,
  normalizeReasoningEffort,
} from "./codex-runtime-settings.js";
import { normalizeUiLanguage } from "../i18n/ui-language.js";
import { cloneJson } from "../state/file-utils.js";
import { normalizeSessionOwnerMode } from "../rollout/session-ownership.js";

function normalizeOptionalText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function buildNormalizedSessionOwnership(
  payload = null,
  {
    defaultMode = null,
    fallbackGenerationId = null,
    fallbackMode = null,
    fallbackClaimedAt = null,
  } = {},
) {
  const ownerGenerationId =
    normalizeOptionalText(payload?.session_owner_generation_id)
    ?? normalizeOptionalText(payload?.spike_run_owner_generation_id)
    ?? normalizeOptionalText(fallbackGenerationId);

  if (!ownerGenerationId) {
    return {
      session_owner_generation_id: null,
      session_owner_mode: null,
      session_owner_claimed_at: null,
      spike_run_owner_generation_id: null,
    };
  }

  return {
    session_owner_generation_id: ownerGenerationId,
    session_owner_mode:
      normalizeSessionOwnerMode(payload?.session_owner_mode)
      ?? normalizeSessionOwnerMode(defaultMode)
      ?? normalizeSessionOwnerMode(fallbackMode)
      ?? "active",
    session_owner_claimed_at:
      normalizeOptionalText(payload?.session_owner_claimed_at)
      ?? normalizeOptionalText(fallbackClaimedAt),
    spike_run_owner_generation_id: ownerGenerationId,
  };
}

export function normalizeStoredSessionMeta(meta) {
  const normalizedOwnership = buildNormalizedSessionOwnership(meta, {
    defaultMode: meta?.last_run_status === "running" ? "active" : null,
  });

  return {
    ...meta,
    ...normalizedOwnership,
    auto_mode: normalizeAutoModeState(meta.auto_mode),
    spike_model_override: normalizeStoredModelOverride(meta.spike_model_override),
    spike_reasoning_effort_override: normalizeReasoningEffort(
      meta.spike_reasoning_effort_override,
    ),
    omni_model_override: normalizeStoredModelOverride(meta.omni_model_override),
    omni_reasoning_effort_override: normalizeReasoningEffort(
      meta.omni_reasoning_effort_override,
    ),
  };
}

export function normalizeOwnershipPatch(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }

  const hasSessionOwnerGenerationId = hasOwn(patch, "session_owner_generation_id");
  const hasSessionOwnerMode = hasOwn(patch, "session_owner_mode");
  const hasSessionOwnerClaimedAt = hasOwn(patch, "session_owner_claimed_at");
  const hasLegacySpikeOwnerGenerationId = hasOwn(
    patch,
    "spike_run_owner_generation_id",
  );

  if (
    !hasSessionOwnerGenerationId
    && !hasSessionOwnerMode
    && !hasSessionOwnerClaimedAt
    && !hasLegacySpikeOwnerGenerationId
  ) {
    return patch;
  }

  const currentOwnership = buildNormalizedSessionOwnership(current, {
    defaultMode: current?.last_run_status === "running" ? "active" : null,
  });
  const claimedAtNow = new Date().toISOString();

  let ownerGenerationId = currentOwnership.session_owner_generation_id;
  if (hasSessionOwnerGenerationId) {
    ownerGenerationId = normalizeOptionalText(patch.session_owner_generation_id);
  } else if (hasLegacySpikeOwnerGenerationId) {
    ownerGenerationId = normalizeOptionalText(patch.spike_run_owner_generation_id);
  }

  let ownerMode = currentOwnership.session_owner_mode;
  if (hasSessionOwnerMode) {
    ownerMode = normalizeSessionOwnerMode(patch.session_owner_mode);
  }

  let ownerClaimedAt = currentOwnership.session_owner_claimed_at;
  if (hasSessionOwnerClaimedAt) {
    ownerClaimedAt = normalizeOptionalText(patch.session_owner_claimed_at);
  }

  const ownerGenerationChanged =
    ownerGenerationId !== currentOwnership.session_owner_generation_id;
  if (!ownerGenerationId) {
    ownerMode = null;
    ownerClaimedAt = null;
  } else {
    ownerMode = ownerMode ?? "active";
    if (!ownerClaimedAt || (ownerGenerationChanged && !hasSessionOwnerClaimedAt)) {
      ownerClaimedAt = claimedAtNow;
    }
  }

  return {
    ...patch,
    ...buildNormalizedSessionOwnership(
      {
        session_owner_generation_id: ownerGenerationId,
        session_owner_mode: ownerMode,
        session_owner_claimed_at: ownerClaimedAt,
      },
      {
        defaultMode: ownerGenerationId ? "active" : null,
      },
    ),
  };
}

export function buildRuntimeStateFields() {
  return {
    last_command_name: null,
    last_command_at: null,
    last_compacted_at: null,
    last_compaction_reason: null,
    exchange_log_entries: 0,
    purge_after: null,
    retention_pin: false,
    parked_at: null,
    parked_reason: null,
    purged_at: null,
    purged_reason: null,
    reactivated_at: null,
    lifecycle_reactivated_reason: null,
    ui_language: "rus",
    runtime_provider: null,
    provider_session_id: null,
    codex_thread_id: null,
    codex_rollout_path: null,
    prompt_suffix_topic_enabled: true,
    prompt_suffix_text: null,
    prompt_suffix_enabled: false,
    pending_prompt_attachments: [],
    pending_prompt_attachments_expires_at: null,
    pending_queue_attachments: [],
    pending_queue_attachments_expires_at: null,
    last_user_prompt: null,
    last_agent_reply: null,
    last_run_status: null,
    session_owner_generation_id: null,
    session_owner_mode: null,
    session_owner_claimed_at: null,
    spike_run_owner_generation_id: null,
    last_run_started_at: null,
    last_run_finished_at: null,
    last_token_usage: null,
    last_context_snapshot: null,
    last_progress_message_id: null,
    spike_model_override: null,
    spike_reasoning_effort_override: null,
    omni_model_override: null,
    omni_reasoning_effort_override: null,
    artifact_count: 0,
    last_artifact: null,
    last_diff_artifact: null,
    auto_mode: buildDefaultAutoModeState(),
  };
}

export function stripLegacyMetaFields(value) {
  const cloned = cloneJson(value);
  delete cloned.recent_window_entries;
  delete cloned.last_log_artifact;
  delete cloned.task_ledger_entries;
  delete cloned.pinned_fact_count;
  return cloned;
}

export function buildPurgedStub(current, reason) {
  const now = new Date().toISOString();

  return {
    schema_version: current.schema_version ?? 1,
    session_key: current.session_key,
    chat_id: current.chat_id,
    topic_id: current.topic_id,
    topic_name: current.topic_name ?? null,
    lifecycle_state: "purged",
    created_at: current.created_at ?? now,
    updated_at: now,
    created_via: current.created_via ?? "unknown",
    inherited_from_session_key: current.inherited_from_session_key ?? null,
    workspace_binding: cloneJson(current.workspace_binding ?? {}),
    ui_language: normalizeUiLanguage(current.ui_language),
    last_command_name: "purge",
    last_command_at: now,
    last_compacted_at: null,
    last_compaction_reason: null,
    exchange_log_entries: 0,
    purge_after: null,
    retention_pin: current.retention_pin ?? false,
    purged_at: now,
    purged_reason: reason,
    session_owner_generation_id: null,
    session_owner_mode: null,
    session_owner_claimed_at: null,
    spike_run_owner_generation_id: null,
    artifact_count: 0,
    last_artifact: null,
    last_diff_artifact: null,
  };
}
