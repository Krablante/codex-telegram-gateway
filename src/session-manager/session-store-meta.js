import {
  normalizeStoredModelOverride,
  normalizeReasoningEffort,
} from "./codex-runtime-settings.js";
import {
  normalizeHostId,
  normalizeHostLabel,
} from "../hosts/topic-host.js";
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

function deleteMetaFields(target, keys) {
  for (const key of keys) {
    delete target[key];
  }
  return target;
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
  const executionHostId = normalizeHostId(
    meta?.execution_host_id ?? meta?.executionHostId,
    null,
  );
  const executionHostLabel = normalizeHostLabel(
    meta?.execution_host_label ?? meta?.executionHostLabel,
    executionHostId,
  );

  const normalized = {
    ...meta,
    ...normalizedOwnership,
    execution_host_id: executionHostId,
    execution_host_label: executionHostLabel,
    execution_host_bound_at: normalizeOptionalText(
      meta?.execution_host_bound_at ?? meta?.executionHostBoundAt,
    ),
    execution_host_last_ready_at: normalizeOptionalText(
      meta?.execution_host_last_ready_at ?? meta?.executionHostLastReadyAt,
    ),
    execution_host_last_failure: normalizeOptionalText(
      meta?.execution_host_last_failure ?? meta?.executionHostLastFailure,
    ),
    spike_model_override: normalizeStoredModelOverride(meta.spike_model_override),
    spike_reasoning_effort_override: normalizeReasoningEffort(
      meta.spike_reasoning_effort_override,
    ),
    codex_thread_model: normalizeStoredModelOverride(meta.codex_thread_model),
    codex_thread_reasoning_effort: normalizeReasoningEffort(
      meta.codex_thread_reasoning_effort,
    ),
    last_run_model: normalizeStoredModelOverride(meta.last_run_model),
    last_run_reasoning_effort: normalizeReasoningEffort(
      meta.last_run_reasoning_effort,
    ),
  };

  return normalized;
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
    compaction_in_progress: false,
    compaction_owner_generation_id: null,
    compaction_started_at: null,
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
    codex_backend: null,
    provider_session_id: null,
    codex_thread_id: null,
    codex_thread_model: null,
    codex_thread_reasoning_effort: null,
    codex_rollout_path: null,
    execution_host_id: null,
    execution_host_label: null,
    execution_host_bound_at: null,
    execution_host_last_ready_at: null,
    execution_host_last_failure: null,
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
    last_run_backend: null,
    session_owner_generation_id: null,
    session_owner_mode: null,
    session_owner_claimed_at: null,
    spike_run_owner_generation_id: null,
    last_run_started_at: null,
    last_run_finished_at: null,
    last_run_model: null,
    last_run_reasoning_effort: null,
    last_token_usage: null,
    last_context_snapshot: null,
    last_progress_message_id: null,
    progress_notes_consumed_until: null,
    spike_model_override: null,
    spike_reasoning_effort_override: null,
    artifact_count: 0,
    last_artifact: null,
    last_diff_artifact: null,
  };
}

export function stripLegacyMetaFields(value) {
  const cloned = cloneJson(value);
  deleteMetaFields(cloned, [
    "recent_window_entries",
    "last_log_artifact",
    "task_ledger_entries",
    "pinned_fact_count",
  ]);
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
    execution_host_id: current.execution_host_id ?? null,
    execution_host_label: current.execution_host_label ?? null,
    execution_host_bound_at: current.execution_host_bound_at ?? null,
    execution_host_last_ready_at: current.execution_host_last_ready_at ?? null,
    execution_host_last_failure: current.execution_host_last_failure ?? null,
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
