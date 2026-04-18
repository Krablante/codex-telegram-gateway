# Codex Telegram Gateway State Contract

## Canonical state root

`${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway`

## Mutable surfaces

- `runtime.env` — local runtime secrets and operator fixture, never committed
- `sessions/` — per-topic session state
- `zoo/` — Zoo topic binding, pet registry, snapshots, and analysis scratch state
- `emergency/` — operator private-chat rescue-lane scratch state
- `indexes/` — sqlite indexes and retention metadata
- `settings/` — service-wide persistent operator settings
- `logs/` — runtime logs and doctor snapshots
- `tmp/` — transient scratch space
- `tmp/guidebook/` may hold generated beginner-guide PDFs for `/guide`

## Current slice contract

Current slices guarantee:

- `runtime.env` exists and is readable locally
- `sessions/<chat-id>/<topic-id>/meta.json` may be created for active topic sessions
- `sessions/<chat-id>/<topic-id>/meta.json:auto_mode` may carry topic-scoped Omni state including goal capture, locked phases, blocker state, and last Omni/Spike prompt correlation ids
- `sessions/<chat-id>/<topic-id>/omni-memory.json` may carry small topic-scoped Omni supervisory memory such as a compact goal capsule, the active proof line, remaining goal gap, candidate pivots, bounded side work, and do-not-regress constraints
- `sessions/<chat-id>/<topic-id>/omni-pending-prompt.json` may store a queued Omni-to-Spike continuation handoff waiting for the next safe prompt start
- `sessions/<chat-id>/<topic-id>/telegram-topic-context.md` may store the current Telegram routing facts, lightweight file-delivery contract, and container-backed MCP path-mapping hints for Codex
- `sessions/<chat-id>/<topic-id>/exchange-log.jsonl` may store the append-only recovery log with only user prompts and final agent replies
- `sessions/<chat-id>/<topic-id>/spike-prompt-queue.json` may store the topic-scoped FIFO queue for `/q` prompts, including prompt text, reply target ids, and downloaded attachment descriptors
- `sessions/<chat-id>/<topic-id>/incoming/` may store direct-prompt and queued-prompt attachments downloaded from Telegram for that topic session
- `sessions/<chat-id>/<topic-id>/active-brief.md` may store the latest LLM-generated recovery brief derived from that exchange log; the brief is expected to carry enough continuity for a fresh run to understand workspace context, active user-specific rules, recent state, latest exchange, and open work
- `sessions/<chat-id>/<topic-id>/artifacts/` may store generated diff snapshots
- `emergency/attachments/<chat-id>/private/incoming/` may store private-chat emergency attachments downloaded from Telegram
- `emergency/runs/` may store one-shot `codex exec` last-message files for the emergency lane
- `zoo/topic.json` may store Zoo topic/menu binding and the pending add-project flow outside normal work-topic sessions
- `zoo/pets/<pet-id>/...` may store Zoo pet metadata, current snapshot, and snapshot history
- `logs/`, `sessions/`, `indexes/`, `settings/`, and `tmp/` can be created on demand
- `logs/doctor-last-run.json` may be refreshed by `make doctor`
- `logs/runtime-heartbeat.json` may track the latest service heartbeat, pid, counters, and poll state
- `logs/runtime-events.ndjson` may append structured service lifecycle, poll/update failure, session lifecycle, and per-run `run.started` / `run.attempt` / `run.recovery` / `run.finished` events with interrupt-reason, recovery-kind, and attempt-insight metadata
- `tmp/generations/spike/*.json` may track live Spike generation heartbeats, mode, pid, per-process identity token, and advertised local IPC endpoint during session-aware rollout
- `omni/logs/runtime-heartbeat.json` and `omni/logs/runtime-events.ndjson` may track the separate Omni poller
- `indexes/telegram-update-offset.json` may be refreshed by `make run` or `make smoke`
- `indexes/spike-leader.json` may track the current Spike intake-leader lease
- `omni/indexes/omni-telegram-update-offset.json` may be refreshed by `make run-omni` or `make smoke-omni`
- `settings/global-prompt-suffix.json` may store the persistent service-wide prompt suffix used by `/suffix global ...`
- `settings/global-codex-settings.json` may store the persistent service-wide model/reasoning defaults for Spike, Omni, and the temporary `/compact` summarizer
- `settings/global-control-panel.json` may store the persistent `General`-topic control-panel message id, active screen, panel UI language, and pending reply-based input state for `/global`
- `settings/general-message-ledger.json` may store the tracked `General` message ids used by `/clear` so the bot can preserve the active menu and remove known clutter without a user-session sweep
- `settings/rollout-coordination.json` may track the most recent Spike rollout request/in-progress/completed state and the retained topic-session keys
- each session dir may store `topic-control-panel.json` with the pinned local menu message id, active screen, and pending reply-based input state for `/menu`
- session metadata may store `ui_language`, `codex_thread_id`, `provider_session_id`, `codex_rollout_path`, `last_context_snapshot`, topic-level prompt suffix settings and routing flags, separate pending attachment buffers for direct Spike prompts and queued `/q` prompts, last prompt/reply, last run status, lifecycle state, `purge_after`, artifact pointers, exchange-log counters, progress message ids, rollout ownership fields such as `session_owner_generation_id`, `session_owner_mode`, `session_owner_claimed_at`, mirrored `spike_run_owner_generation_id`, compaction timestamps, and lightweight Omni auto-compact counters such as `first_omni_prompt_at` and `continuation_count_since_compact`
- `omni/runs/` may store one-shot `codex exec` output files used by Omni evaluations
- malformed file-backed queue, handoff, panel, Omni memory, or Zoo state may be quarantined and rebuilt empty instead of being silently reused
- if `zoo/topic.json` is missing or incomplete, the next live Zoo menu callback may rebuild the stored chat/topic/menu binding from Telegram callback context
- transport may switch from message edits to append-only status messages when edit delivery degrades
- general-message ledger writes are serialized so concurrent `General` cleanup tracking does not lose message ids under overlapping updates
- final reply delivery may retry transient Telegram/network send failures and, when the send never recovers, keep the final answer visible in the already-open progress bubble
- transport may strip fenced `telegram-file` control blocks with `action: send` from the final visible reply and use them to send local files into the current Telegram topic
- outgoing file delivery is scoped to safe local roots such as the active worktree, the per-session state dir, and the system temp dir
- incoming attachment filenames may be sanitized for platform hazards such as Windows reserved names and trailing dot/space traps before they are stored in session state
- when topic `auto_mode` is active, Spike may ignore direct human prompt messages in that topic and accept prompt-starts there only from trusted Omni bot principals
- if Omni is disabled globally through missing Omni credentials or `OMNI_ENABLED=false`, any persisted topic `auto_mode` state remains on disk but becomes inert for Spike routing until Omni is re-enabled
- run completion may append to `exchange-log.jsonl`, while explicit `/compact` may refresh `active-brief.md` and clear stored thread/context state so the next run bootstraps itself from the rebuilt brief instead of the old Codex session
- an explicitly interrupted run may preserve resumable Codex continuity metadata so the next turn can follow the same native session instead of being forced into a fake fresh start
- `/auto` may also trigger the same compaction path internally at a safe cycle boundary, with a short visible Telegram notice but without changing the manual `/compact` UX
- if a stored `codex_thread_id` no longer resumes cleanly after the controlled retry, the next run may first repair continuity from `thread/list`, `provider_session_id`, rollout metadata, and `session_key`; only after those bounded repair attempts fail may it clear the thread state, regenerate `active-brief.md` from `exchange-log.jsonl`, and continue from that brief
- active follow-up user input may be buffered briefly and then live-steered into the same current Codex turn instead of starting a second run
- if the live websocket transport drops mid-run, or native Windows finalization leaves the websocket alive without a terminal event, completion may continue via rollout-file recovery instead of failing immediately
- if a Telegram attachment exceeds the current direct bot-download ceiling, the update may be acknowledged with a small inline "too large" reply instead of retry-looping the same failing poll cycle forever
- if a long final reply partially reaches Telegram before a later chunk fails, Spike final-event metadata may still record the already-delivered Telegram message ids
- run completion may hold a short grace window after primary `turn/completed` so a slightly late primary final answer still lands before the worker falls back to a generic success reply
- during service rollout, the leader generation may forward raw Telegram updates for a still-running foreign-owned topic to the retiring generation over local loopback IPC
- local loopback IPC bind may retry blocked or already-used loopback ports before failing the forwarding server
- operator private-chat prompts may bypass topic routing entirely and execute through the isolated emergency `codex exec` path
- external `forum_topic_closed` / `forum_topic_reopened` service messages may move sessions between `active` and `parked`
- transport failures like unavailable/deleted topic may also move a session into `parked`
- expired parked sessions may be auto-purged during periodic retention sweep
- new topic creation may resolve explicit workspace binding from `/new cwd=...` against the configured workspace root
- `/purge` removes compact memory files and artifacts, then leaves only a tiny `meta.json` purged stub until the topic is reused

## Rules

- state lives under the configured local state root, never inside the source repo
- bot tokens and runtime credentials stay only here
- later session artifacts inherit the `chat_id/topic_id` geography from the plan
- the gateway does not keep tool chatter or full PTY transcripts as canonical memory; the clean exchange log is the durable raw surface, and the compact brief is a derived recovery surface
- Omni and Spike may share the same topic session state, but only topic-scoped autonomy state is shared; Omni still remains a separate Telegram bot and a separate Codex process
- Omni memory is intentionally small and topic-scoped; it is not a second transcript surface, should not mirror the full locked-goal essay, and does not replace `exchange-log.jsonl` or `active-brief.md`
- the deployment may also run without Omni entirely; in that shape `auto_mode` metadata is just dormant session state, not an active routing lock
