# Codex Telegram Gateway Runbook

Use this file for live operations and recovery. Product surface details now live in focused docs:

- [telegram-surface.md](./telegram-surface.md)
- [omni-auto.md](./omni-auto.md)
- [deployment.md](./deployment.md)
- [testing.md](./testing.md)

## Repo-Local Checks

```bash
cd /path/to/codex-telegram-gateway
make admin ARGS='status'
make admin ARGS='sessions --state parked'
make doctor
make test
```

## Manual Foreground Run

```bash
cd /path/to/codex-telegram-gateway
make run
```

With Omni enabled:

```bash
cd /path/to/codex-telegram-gateway
make run-omni
```

Native Windows:

```powershell
cd C:\path\to\codex-telegram-gateway
copy .env.example .env
scripts\windows\install.cmd
scripts\windows\install-codex.cmd
scripts\windows\doctor.cmd
scripts\windows\admin.cmd status
scripts\windows\run.cmd
scripts\windows\run-omni.cmd
```

On native Windows, use the wrapper scripts instead of bare `npm` inside PowerShell.

## Runtime Visibility

- heartbeat: `${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway/logs/runtime-heartbeat.json`
- events: `${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway/logs/runtime-events.ndjson`
- doctor snapshot: `${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway/logs/doctor-last-run.json`
- per-session exchange log: `.../sessions/<chat-id>/<topic-id>/exchange-log.jsonl`
- per-session brief: `.../sessions/<chat-id>/<topic-id>/active-brief.md`

Healthy runtime means:

- `lifecycle_state: running`
- fresh `observed_at`
- sensible `active_run_count`
- expected bot usernames and forum chat id

## Local Admin Surface

Use the repo-local admin CLI when a topic is already parked/deleted and Telegram commands are no longer reachable:

```bash
cd /path/to/codex-telegram-gateway
make admin ARGS='status'
make admin ARGS='sessions --state parked'
make admin ARGS='show <chat-id> <topic-id>'
make admin ARGS='pin <chat-id> <topic-id>'
make admin ARGS='unpin <chat-id> <topic-id>'
make admin ARGS='reactivate <chat-id> <topic-id>'
make admin ARGS='purge <chat-id> <topic-id>'
```

Native Windows equivalent:

```powershell
scripts\windows\admin.cmd status
scripts\windows\admin.cmd sessions --state parked
scripts\windows\admin.cmd show <chat-id> <topic-id>
scripts\windows\admin.cmd pin <chat-id> <topic-id>
scripts\windows\admin.cmd unpin <chat-id> <topic-id>
scripts\windows\admin.cmd reactivate <chat-id> <topic-id>
scripts\windows\admin.cmd purge <chat-id> <topic-id>
```

## Services

```bash
cd /path/to/codex-telegram-gateway
make service-install
make service-status
make service-logs
make service-rollout
make service-restart
make service-hard-restart
```

If `service-install` cannot resolve `CODEX_BIN_PATH`, set it to an absolute binary path and rerun the install. On native Windows, the practical default is to leave `CODEX_BIN_PATH` empty so the runtime uses `codex.cmd`; if you override it, prefer `codex.cmd` or an absolute `...\codex.cmd` path.

For `Spike`, `make service-rollout` and `make service-restart` now use the session-aware soft rollout path: the repo-local rollout command waits until the replacement generation has taken leader traffic, while already active run topics stay on the retiring generation until they finish. `make service-hard-restart` remains the blind hard restart path. `service-install` for Spike now requires `systemd >= 250` because the unit depends on `ExitType=cgroup`.

With Omni enabled:

```bash
make service-install-omni
make service-status-omni
make service-logs-omni
make service-restart-omni
```

## Failure Handling

- run `make doctor` first
- use `make admin ARGS='status'` before blind restarts
- if only one topic is wedged, prefer topic-level `/status`, `/interrupt`, `/purge`
- if a live run is still active, start with the soft `service-restart`; move to `service-hard-restart` only when you explicitly want to cut the whole cgroup
- if the topic path itself is broken, switch to the emergency private chat lane
- if the topic is already gone, use the local admin surface instead of poking Telegram harder
- on native Windows, use `scripts\windows\admin.cmd ...` instead of trying Linux-only `make admin`
- correlate `runtime-events.ndjson`, `meta.json`, `exchange-log.jsonl`, and `active-brief.md` before hand-editing state
- after manual `/compact`, expect the next fresh run to bootstrap from `active-brief.md`

## Recovery Notes

- if a stored `codex_thread_id` no longer resumes cleanly, the runtime retries once before falling back to compact recovery
- if Omni is disabled globally, old topic `auto_mode` state stays on disk but becomes inert
- if Telegram reports a topic as unavailable, the session may move into `parked`
- if Telegram loses the original reply target for a topic message, topic delivery falls back to a plain send in the same topic
- expired parked sessions may be auto-purged by retention sweep
- the heartbeat now also exposes generation id, leader/retiring state, and rollout status for service-level handoff visibility
