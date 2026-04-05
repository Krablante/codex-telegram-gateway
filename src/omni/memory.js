import fs from "node:fs/promises";
import path from "node:path";

import { quarantineCorruptFile } from "../state/file-utils.js";

export const OMNI_MEMORY_FILE_NAME = "omni-memory.json";
const MAX_LIST_ITEMS = 12;

function normalizeText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeCounter(value) {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }

  return Math.trunc(value);
}

function normalizeStringList(value) {
  const source = Array.isArray(value)
    ? value
    : normalizeText(value)
      ? [value]
      : [];

  const seen = new Set();
  const items = [];

  for (const entry of source) {
    const normalized = normalizeText(entry);
    if (!normalized) {
      continue;
    }

    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    items.push(normalized);
    if (items.length >= MAX_LIST_ITEMS) {
      break;
    }
  }

  return items;
}

export function buildDefaultOmniMemory() {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    created_at: now,
    updated_at: now,
    goal_constraints: [],
    current_proof_line: null,
    proof_line_status: null,
    last_spike_summary: null,
    last_decision_mode: null,
    known_bottlenecks: [],
    candidate_pivots: [],
    side_work_queue: [],
    supervisor_notes: [],
    why_this_matters_to_goal: null,
    goal_unsatisfied: null,
    remaining_goal_gap: null,
    what_changed_since_last_cycle: null,
    last_what_changed: null,
    primary_next_action: null,
    bounded_side_work: [],
    do_not_regress: [],
    first_omni_prompt_at: null,
    last_prompt_dispatched_at: null,
    last_auto_compact_at: null,
    continuation_count_since_compact: 0,
    last_auto_compact_reason: null,
    last_auto_compact_exchange_log_entries: 0,
  };
}

export function normalizeOmniMemory(value) {
  const defaults = buildDefaultOmniMemory();

  return {
    ...defaults,
    schema_version: 1,
    created_at: normalizeText(value?.created_at) || defaults.created_at,
    updated_at: normalizeText(value?.updated_at) || defaults.updated_at,
    goal_constraints: normalizeStringList(value?.goal_constraints),
    current_proof_line: normalizeText(value?.current_proof_line),
    proof_line_status: normalizeText(value?.proof_line_status),
    last_spike_summary: normalizeText(value?.last_spike_summary),
    last_decision_mode: normalizeText(value?.last_decision_mode),
    known_bottlenecks: normalizeStringList(value?.known_bottlenecks),
    candidate_pivots: normalizeStringList(value?.candidate_pivots),
    side_work_queue: normalizeStringList(value?.side_work_queue),
    supervisor_notes: normalizeStringList(value?.supervisor_notes),
    why_this_matters_to_goal: normalizeText(value?.why_this_matters_to_goal),
    goal_unsatisfied:
      normalizeText(value?.goal_unsatisfied)
      || normalizeText(value?.remaining_goal_gap),
    remaining_goal_gap:
      normalizeText(value?.remaining_goal_gap)
      || normalizeText(value?.goal_unsatisfied),
    what_changed_since_last_cycle:
      normalizeText(value?.what_changed_since_last_cycle)
      || normalizeText(value?.last_what_changed),
    last_what_changed:
      normalizeText(value?.last_what_changed)
      || normalizeText(value?.what_changed_since_last_cycle),
    primary_next_action: normalizeText(value?.primary_next_action),
    bounded_side_work: normalizeStringList(value?.bounded_side_work),
    do_not_regress: normalizeStringList(value?.do_not_regress),
    first_omni_prompt_at: normalizeText(value?.first_omni_prompt_at),
    last_prompt_dispatched_at: normalizeText(value?.last_prompt_dispatched_at),
    last_auto_compact_at: normalizeText(value?.last_auto_compact_at),
    continuation_count_since_compact: normalizeCounter(
      value?.continuation_count_since_compact,
    ),
    last_auto_compact_reason: normalizeText(value?.last_auto_compact_reason),
    last_auto_compact_exchange_log_entries: normalizeCounter(
      value?.last_auto_compact_exchange_log_entries,
    ),
  };
}

export class OmniMemoryStore {
  constructor(sessionStore) {
    this.sessionStore = sessionStore;
  }

  getPath(session) {
    return path.join(
      this.sessionStore.getSessionDir(session.chat_id, session.topic_id),
      OMNI_MEMORY_FILE_NAME,
    );
  }

  async load(session) {
    const filePath = this.getPath(session);
    const text = await this.sessionStore.readSessionText(
      session,
      OMNI_MEMORY_FILE_NAME,
    );
    if (!text) {
      return buildDefaultOmniMemory();
    }

    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") {
        await quarantineCorruptFile(filePath);
        return buildDefaultOmniMemory();
      }

      return normalizeOmniMemory(parsed);
    } catch (error) {
      if (error instanceof SyntaxError) {
        await quarantineCorruptFile(filePath);
      }
      return buildDefaultOmniMemory();
    }
  }

  async save(session, value) {
    const normalized = normalizeOmniMemory(value);
    await this.sessionStore.writeSessionJson(
      session,
      OMNI_MEMORY_FILE_NAME,
      normalized,
    );
    return normalized;
  }

  async write(session, value) {
    return this.save(session, value);
  }

  async patch(session, patch = {}) {
    return this.sessionStore.withMetaLock(
      session.chat_id,
      session.topic_id,
      async () => {
        const current = await this.load(session);
        const resolvedPatch =
          typeof patch === "function"
            ? await patch(current)
            : patch;
        if (resolvedPatch === null || resolvedPatch === undefined) {
          return current;
        }

        const next = normalizeOmniMemory({
          ...current,
          ...resolvedPatch,
          created_at: current.created_at,
          updated_at: new Date().toISOString(),
        });
        await this.sessionStore.writeSessionJson(
          session,
          OMNI_MEMORY_FILE_NAME,
          next,
        );
        return next;
      },
    );
  }

  async clear(session) {
    await fs.rm(this.getPath(session), { force: true });
  }
}
