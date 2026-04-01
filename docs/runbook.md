# Codex Telegram Gateway Runbook

## Goal

Keep the gateway running as a long-lived host service without inventing a separate supervisor stack.

## Repo-local checks

```bash
make admin ARGS='status'
make admin ARGS='sessions --state parked'
make doctor
make test
make test-live
make soak
```

## Manual foreground run

```bash
make run
```

## Manual collection window

Inside a working topic you can enable a persistent buffered input mode:

- `/wait 60`, `wait 600`, or `/wait 1m` enables one global buffered prompt mode for the same chat/user
- the mode stays on until `/wait off` or a new `/wait <time>`
- each new part inside the current prompt resets the timer
- a standalone `Все` flushes the buffered payload immediately
- `/wait` shows current state
- `/wait off` disables the mode and drops buffered parts

## Help card

- `/help` returns the current quick-reference card with the live command set
- `/language rus` or `/language eng` switches the topic UI language; `/help` follows that language too
- if Telegram image delivery degrades, the bot falls back to a plain text cheat sheet

## Emergency lane

Use the bot's private chat as the operator-only emergency lane.

- it activates on demand when the allowed operator writes to the bot in private chat
- it bypasses normal topic/session routing and launches one isolated `codex exec` repair run
- supported commands in private chat: `/help`, `/status`, `/interrupt`
- file-first works there too: send the attachment first, then the task text in the next private message
- while the emergency run is active, normal operator prompts in topics are blocked to keep the rescue path isolated
- the lock disappears automatically when the emergency run finishes, or immediately after `/interrupt`

## Runtime visibility

Default state root:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway
```

Useful files:

- `logs/runtime-heartbeat.json`
- `logs/runtime-events.ndjson`
- `logs/doctor-last-run.json`
- `sessions/<chat-id>/<topic-id>/exchange-log.jsonl`
- `sessions/<chat-id>/<topic-id>/active-brief.md`

When the service is healthy, `runtime-heartbeat.json` should show:

- `lifecycle_state: running`
- advancing `observed_at`
- stable `bot.username`
- sensible `service_state.active_run_count`

## Transport model

- each topic run is driven through `codex app-server`, not one-shot `codex exec`
- active follow-up user messages can be injected into the same live turn through `turn/steer`
- if the websocket drops mid-run, the gateway can keep tailing the rollout file and still wait for the final answer
- progress bubbles should show only commentary text from the main run
- the emergency private-chat lane intentionally stays on the simpler `codex exec` path so it can still operate if the topic/session transport is what broke

## Local admin surface

```bash
make admin ARGS='status'
make admin ARGS='sessions --state parked'
make admin ARGS='show <chat-id> <topic-id>'
make admin ARGS='pin <chat-id> <topic-id>'
make admin ARGS='unpin <chat-id> <topic-id>'
make admin ARGS='reactivate <chat-id> <topic-id>'
make admin ARGS='purge <chat-id> <topic-id>'
```

## Host wrapper

This repo ships a minimal user `systemd` install path:

```bash
make service-install
make service-status
make service-logs
make service-restart
```

The installed user unit runs `src/cli/run.js` directly under the resolved Node binary so `systemd` tracks the real poller PID.

## Failure handling

- run `make doctor` first to verify Telegram auth, chat access, and webhook state
- use `make admin ARGS='status'` before restarting the service if you need a quick global snapshot
- inspect `runtime-heartbeat.json` and `runtime-events.ndjson` before touching session state
- if only one topic is wedged, prefer `/status`, `/interrupt`, or `/purge` inside that topic instead of restarting the whole service
- if the topic path itself is what broke, switch to the bot's private chat and use the emergency lane there instead of poking the broken topic harder
- if a stored `codex_thread_id` no longer resumes cleanly, the runtime retries resume once and only then regenerates `active-brief.md` from `exchange-log.jsonl`
- after manual `/compact`, expect the next fresh run to start from that rebuilt brief instead of a near-empty context bootstrap
