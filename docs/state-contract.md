# Codex Telegram Gateway State Contract

## Canonical default state root

```text
${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway
```

## Mutable surfaces

- `sessions/` — per-topic session state
- `emergency/` — operator private-chat rescue-lane scratch state
- `indexes/` — polling cursor and retention metadata
- `settings/` — persistent service-wide settings
- `logs/` — heartbeat, doctor snapshots, and runtime events
- `tmp/` — transient scratch space

## Current contract

- `.env` / `ENV_FILE` contains local runtime secrets and operator fixture, never committed
- `sessions/<chat-id>/<topic-id>/meta.json` stores topic/session metadata
- `sessions/<chat-id>/<topic-id>/telegram-topic-context.md` stores the current Telegram routing facts and file-delivery contract for Codex
- `sessions/<chat-id>/<topic-id>/exchange-log.jsonl` stores the append-only recovery log with only user prompts and final agent replies
- `sessions/<chat-id>/<topic-id>/active-brief.md` stores the latest LLM-generated recovery brief derived from that exchange log; the brief is expected to carry enough continuity for a fresh run to understand workspace context, recent state, latest exchange, and open work
- `sessions/<chat-id>/<topic-id>/artifacts/` stores generated diff snapshots
- `emergency/attachments/<chat-id>/private/incoming/` may store private-chat emergency attachments downloaded from Telegram
- `emergency/runs/` may store one-shot `codex exec` last-message files for the emergency lane
- `logs/runtime-heartbeat.json` tracks the latest service heartbeat, pid, counters, and poll state
- `logs/runtime-events.ndjson` appends structured service lifecycle, poll/update failure, and session lifecycle events
- `indexes/telegram-update-offset.json` stores the next Telegram polling cursor
- `settings/global-prompt-suffix.json` stores the persistent service-wide prompt suffix used by `/suffix global ...`

## Rules

- mutable state lives outside the source repo under the configured state root
- bot tokens and runtime credentials stay only there
- the gateway does not keep tool chatter or full PTY transcripts as canonical memory
- the clean exchange log is the durable raw surface, and the compact brief is a derived recovery surface
- explicit `/compact` also clears stored Codex thread/context metadata so the next run bootstraps itself from the rebuilt brief instead of the previous thread
- operator private-chat prompts may bypass topic routing entirely and execute through the isolated emergency `codex exec` path
