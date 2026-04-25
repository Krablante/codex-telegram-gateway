# Codex Telegram Gateway State Contract

## Canonical state root

`${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway`

## Mutable surfaces

- `hosts/` — host registry, doctor snapshots, host-sync state
- `codex-space/` — rendered shared/per-host multi-host outputs
- `sessions/` — per-topic session state
- `zoo/` — Zoo topic binding, pet registry, snapshots, and analysis scratch state
- `emergency/` — operator private-chat rescue-lane scratch state
- `indexes/` — sqlite indexes and retention metadata
- `settings/` — service-wide persistent operator settings
- `logs/` — runtime logs and doctor snapshots
- `tmp/` — transient scratch space
- `tmp/guidebook/` may hold generated `/guide` PDFs
- `live-user-testing/` — private live user-account test state

## Current slice contract

Current slices guarantee:

- `sessions/<chat-id>/<topic-id>/meta.json` may be created for active topic sessions
- `sessions/<chat-id>/<topic-id>/telegram-topic-context.md` may store the local control-plane copy of Telegram routing facts, MCP path mapping hints, and file-delivery guidance
- `sessions/<chat-id>/<topic-id>/exchange-log.jsonl` may store the append-only recovery log with only user prompts and final replies
- `sessions/<chat-id>/<topic-id>/progress-notes.jsonl` may store append-only main-run natural-language progress notes used as recovery hints
- `sessions/<chat-id>/<topic-id>/exec-json-run.jsonl` may store the latest raw exec-json turn mirror for stale-run recovery; it is overwritten per attempt and is not canonical conversation memory
- `sessions/<chat-id>/<topic-id>/spike-prompt-queue.json` may store the topic-scoped FIFO queue for `/q`
- `sessions/<chat-id>/<topic-id>/incoming/` may store downloaded topic attachments
- `sessions/<chat-id>/<topic-id>/active-brief.md` may store the latest compacted recovery brief
- `sessions/<chat-id>/<topic-id>/compaction-source.md` may store the latest inspectable compaction input written during compaction; small exchange logs with pending progress notes keep the full exchange log plus bounded progress notes, while oversized logs use the bounded source, and small full-log compactions keep the bounded source as the context-length fallback
- `sessions/<chat-id>/<topic-id>/artifacts/` may store generated diff snapshots
- `emergency/attachments/<chat-id>/private/incoming/` may store private-chat emergency attachments
- `emergency/runs/` may store one-shot `codex exec` last-message files for the emergency lane
- `live-user-testing/telegram-user.env` may store Telegram user-account API credentials for live user tests
- `live-user-testing/telegram-user-session.txt` may store the Telegram user session string
- `live-user-testing/telegram-user-account.json` may store the last live user-account identity snapshot
- `zoo/topic.json` may store Zoo topic/menu binding and pending add-project flow state
- `zoo/pets/<pet-id>/...` may store Zoo pet metadata and snapshot history
- `hosts/registry.json` may store the local multi-host registry
- `hosts/bootstrap-last-run.json` may store the latest remote runtime bootstrap summary
- `hosts/doctor/<host-id>.json` may store the latest per-host readiness snapshot
- `hosts/remote-smoke-last-run.json` may store the latest remote smoke summary
- `hosts/sync-last-run.json` may store the latest host-sync summary
- `codex-space/shared/rendered/` may store shared fleet outputs generated on `controller`
- `codex-space/hosts/<host-id>/rendered/` may store per-host rendered outputs generated on `controller`
- `codex-space/hosts/<host-id>/rendered/models_cache.json` may mirror the latest known per-host Codex model catalog for topic model/status surfaces
- on a remote host, `<worker_runtime_root>/codex-space/shared/rendered/` may store the synced shared prompt snippets
- on a remote host, `<worker_runtime_root>/codex-space/hosts/<host-id>/rendered/` may store the synced bound-host prompt snippets
- on a remote host, `<worker_runtime_root>/host-smoke/` may store smoke artifacts
- on a remote host, `<worker_runtime_root>/remote-inputs/<session-key>/<run-id>/` may temporarily store staged image attachments copied from `controller`; the worker removes the per-run directory after the remote exec child exits
- `logs/runtime-heartbeat.json` may track the latest service heartbeat, pid, counters, and poll state
- `logs/runtime-events.ndjson` may append structured service and per-run lifecycle events
- `indexes/telegram-update-offset.json` may be refreshed by `make run` or `make smoke`
- `indexes/spike-leader.json` may track the current intake-leader lease
- `settings/global-prompt-suffix.json` may store `/suffix global ...`
- `settings/global-codex-settings.json` may store persistent Spike defaults plus the separate `/compact` summarizer profile
- `settings/global-control-panel.json` may store `/global` menu state
- `settings/general-message-ledger.json` may store tracked `General` message ids for `/clear`
- `settings/rollout-coordination.json` may track soft-rollout state and retained sessions
- each session dir may store `topic-control-panel.json` with `/menu` state

Runtime secrets and operator config belong in the configured env file, usually
`${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env` on Linux or
repo-local `.env` for native Windows bootstrap. They are not part of the mutable
state root contract.

## Session metadata

Session metadata may store:

- `ui_language`
- `codex_backend` — the backend selected for this topic, normally `exec-json`
- `last_run_backend`
- `codex_thread_id` — the Codex thread id from `thread.started`; used as the `codex exec ... resume <thread_id> -` key
- `codex_rollout_path` — fallback app-server rollout path; ignored and cleared by default `exec-json` continuity
- `provider_session_id` — fallback app-server provider session id; ignored and cleared by default `exec-json` continuity
- `last_context_snapshot` — fallback/context-pressure snapshot; not the primary exec resume key, and default `exec-json` must not use snapshot `session_id`, `rollout_path`, or thread fallback as continuity
- execution-affinity fields such as `execution_host_id`, `execution_host_label`, `execution_host_bound_at`, `execution_host_last_ready_at`, and `execution_host_last_failure`
- topic-level prompt suffix settings and routing flags
- separate pending attachment buffers for direct Spike prompts and queued `/q` prompts
- last prompt/reply
- last run status
- lifecycle state
- `purge_after`

Purged sessions are reactivatable stubs. A same-topic real plain prompt or flushed non-empty `/q` runnable prompt creates a fresh active session with runtime continuity reset and topic identity, workspace binding, execution host binding, and UI language preserved. Blank `/q`, buffered fragments, and attachment-only `/q` collection do not reactivate the topic yet.

Session metadata may also store:

- artifact pointers
- exchange-log counters
- progress message ids
- rollout ownership fields such as `session_owner_generation_id`, `session_owner_mode`, `session_owner_claimed_at`, and mirrored `spike_run_owner_generation_id`
- compaction fields such as `compaction_in_progress`, `compaction_started_at`, `compaction_owner_generation_id`, `progress_notes_consumed_until`, and compaction timestamps

Raw Codex session files stay host-local under that host's Codex sessions root
(`CODEX_SESSIONS_ROOT` or `~/.codex/sessions`). Do not copy or share one
`.codex/sessions` tree across hosts; the gateway only stores the resumable
`codex_thread_id` and small context snapshots centrally.

## Legacy cleanup

The runtime is single-bot now.

If old on-disk state still contains removed legacy autonomy metadata, normalization strips or ignores that data instead of reactivating any removed behavior.

## Rules

- state lives under `the configured state root/...`, never inside the source repo
- state directories are private by default (`0700`); state files, append-only JSONL/log files, and downloaded attachments are private by default (`0600`) on POSIX
- expired pending attachment buffers remove their unconsumed files from the session `incoming/` directory
- bot tokens and runtime credentials stay in the configured env file, not in source control or derived state artifacts
- `codex-space/` is canonical on `controller`; remote hosts receive synced copies
- the clean exchange log is the durable raw user/final conversational surface
- `progress-notes.jsonl` is the durable append-only natural-language progress surface; it stores only Telegram-visible main-run notes, not hidden chain-of-thought or tool chatter
- malformed `progress-notes.jsonl` lines are ignored, and compaction loads all pending notes before the bounded-source selector decides what to omit; the file itself is append-only
- progress note entries use `schema_version: 1` with `created_at`, `session_key`, `run_started_at`, `thread_id`, `source`, `event_type`, and `text`
- `progress_notes_consumed_until` advances only when all pending progress notes were included in the compaction source; omitted notes stay pending for a later compaction
- `exec-json-run.jsonl` is transient latest-attempt evidence: startup recovery may use its primary `thread.started`, latest main-run `agent_message`, and `turn.completed` to complete a dead-owner run, but compaction does not treat it as durable memory
- loopback update-forwarding IPC uses a per-generation instance token; the token lives only in private generation state and forwarded update/probe payloads
- the compact brief is a derived recovery surface built from either the full exchange log, a full compaction source with pending progress notes, or a bounded compaction source containing the previous brief, recent exchange/progress slices, older high-signal continuity excerpts, and first-time oversized chronology checkpoints
- long active briefs and bounded exchange prompt/reply fields preserve head+tail with middle truncation; full compaction sources keep small-log exchange prompt/reply fields intact and use safe markdown fences around stored text
- `compaction-source.md` is the latest derived, inspectable compaction input; it may be overwritten by later compactions and is not a second canonical memory log
