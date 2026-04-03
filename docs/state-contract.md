# Codex Telegram Gateway State Contract

## Default State Root

```text
${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway
```

The actual path can be overridden with `STATE_ROOT`.

## Mutable Surfaces

- `runtime.env` — local runtime secrets and operator fixture, never committed
- `sessions/` — per-topic session state
- `emergency/` — operator private-chat rescue-lane scratch state
- `indexes/` — update offsets and retention metadata
- `settings/` — service-wide persistent operator settings
- `logs/` — runtime logs and doctor snapshots
- `tmp/` — transient scratch space
- `tmp/guidebook/` may hold generated beginner-guide PDFs for `/guide`

## Current Slice Contract

Current slices guarantee:

- `runtime.env` may exist and stay readable locally
- `sessions/<chat-id>/<topic-id>/meta.json` may be created for active topic sessions
- `sessions/<chat-id>/<topic-id>/meta.json:auto_mode` may carry topic-scoped Omni state including goal capture, phases, blockers, and prompt correlation ids
- `sessions/<chat-id>/<topic-id>/omni-memory.json` may carry small topic-scoped Omni supervisory memory such as the active proof line, remaining goal gap, candidate pivots, bounded side work, and do-not-regress constraints
- `sessions/<chat-id>/<topic-id>/telegram-topic-context.md` may store the current Telegram routing facts and lightweight file-delivery contract for Codex
- `sessions/<chat-id>/<topic-id>/exchange-log.jsonl` may store the append-only recovery log with only user prompts and final agent replies
- `sessions/<chat-id>/<topic-id>/spike-prompt-queue.json` may store the topic-scoped FIFO queue for `/q` prompts, including prompt text, reply target ids, and downloaded attachment descriptors
- `sessions/<chat-id>/<topic-id>/active-brief.md` may store the latest LLM-generated recovery brief derived from that exchange log
- `sessions/<chat-id>/<topic-id>/artifacts/` may store generated diff snapshots
- `emergency/attachments/<chat-id>/private/incoming/` may store private-chat attachments downloaded from Telegram
- `emergency/runs/` may store one-shot `codex exec` last-message files for the emergency lane
- `logs/doctor-last-run.json` may be refreshed by `make doctor`
- `logs/runtime-heartbeat.json` may track the latest service heartbeat, pid, counters, and poll state
- `logs/runtime-events.ndjson` may append structured service lifecycle, poll/update failure, and session lifecycle events
- `omni/logs/runtime-heartbeat.json` and `omni/logs/runtime-events.ndjson` may track the separate Omni poller
- `indexes/telegram-update-offset.json` may be refreshed by `make run` or `make smoke`
- `omni/indexes/omni-telegram-update-offset.json` may be refreshed by `make run-omni` or `make smoke-omni`
- `settings/global-prompt-suffix.json` may store the persistent service-wide prompt suffix used by `/suffix global ...`
- `settings/global-control-panel.json` may store the persistent `General` control-panel message id, active screen, UI language, and pending reply-based input state for `/global`
- each session dir may store `topic-control-panel.json` with the pinned local menu message id, active screen, and pending reply-based input state for `/menu`
- session metadata may store UI language, thread ids, rollout paths, prompt suffix state, attachment buffers, last prompt/reply, lifecycle state, exchange-log counters, progress message ids, compaction timestamps, and Omni auto-compact counters
- `omni/runs/` may store one-shot `codex exec` output files used by Omni evaluations
- transport may switch from message edits to append-only status messages when edit delivery degrades
- transport may strip fenced `telegram-file` control blocks with `action: send` from the final visible reply and use them to send local files into the current Telegram topic
- outgoing file delivery is scoped to safe local roots such as the active worktree, the per-session state dir, and `/tmp`
- when topic `auto_mode` is active, Spike may ignore direct human prompt messages in that topic and accept prompt-starts there only from trusted Omni bot principals
- if Omni is disabled globally through missing Omni credentials or `OMNI_ENABLED=false`, any persisted topic `auto_mode` state remains on disk but becomes inert for Spike routing until Omni is re-enabled
- run completion may append to `exchange-log.jsonl`, while explicit `/compact` may refresh `active-brief.md` and clear stored thread/context state so the next run bootstraps from the rebuilt brief
- an explicitly interrupted run also clears stored thread/context state, so the next run starts as a fresh continuation instead of trying to resume a killed Codex thread
- `/auto` may also trigger the same compaction path internally at a safe cycle boundary, with a short visible Telegram notice but without changing the manual `/compact` UX
- if a stored `codex_thread_id` no longer resumes cleanly after the controlled retry, the next run may clear it, regenerate `active-brief.md` from `exchange-log.jsonl`, and continue from that brief
- active follow-up user input may be buffered briefly and then live-steered into the same current Codex turn instead of starting a second run
- if the live websocket transport drops mid-run, completion may continue via rollout-file recovery instead of failing immediately
- operator private-chat prompts may bypass topic routing entirely and execute through the isolated emergency `codex exec` path
- external `forum_topic_closed` / `forum_topic_reopened` service messages may move sessions between `active` and `parked`
- transport failures like unavailable or deleted topic may also move a session into `parked`
- expired parked sessions may be auto-purged during periodic retention sweep
- new topic creation may resolve explicit workspace binding from `/new cwd=...` against the configured workspace root
- `/purge` removes compact memory files and artifacts, then leaves only a tiny `meta.json` purged stub until the topic is reused

## Rules

- state lives under the configured state root, never inside the source repo
- bot tokens and runtime credentials stay only there
- later session artifacts inherit the `chat_id/topic_id` geography
- the gateway does not keep full PTY transcripts as canonical memory; the clean exchange log is the durable raw surface, and the compact brief is a derived recovery surface
- Omni and Spike may share the same topic session state, but only topic-scoped autonomy state is shared; Omni still remains a separate Telegram bot and a separate Codex process
- Omni memory is intentionally small and topic-scoped; it is not a second transcript surface and does not replace `exchange-log.jsonl` or `active-brief.md`
- the deployment may also run without Omni entirely; in that shape `auto_mode` metadata is just dormant session state, not an active routing lock
