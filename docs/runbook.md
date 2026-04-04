# Codex Telegram Gateway Runbook

Use this file for live operations and recovery. Product surface details live in:

- [telegram-surface.md](./telegram-surface.md)
- [omni-auto.md](./omni-auto.md)
- [deployment.md](./deployment.md)
- [testing.md](./testing.md)

## Repo-Local Checks

```bash
make admin ARGS='status'
make admin ARGS='sessions --state parked'
make doctor
make test
```

## Manual Foreground Run

```bash
make run
```

Native Windows:

```powershell
scripts\windows\run.cmd
```

With Omni enabled:

```bash
make run-omni
```

Native Windows equivalent:

```powershell
scripts\windows\run-omni.cmd
```

## Runtime Visibility

- heartbeat: `${STATE_ROOT}/logs/runtime-heartbeat.json`
- events: `${STATE_ROOT}/logs/runtime-events.ndjson`
- doctor snapshot: `${STATE_ROOT}/logs/doctor-last-run.json`
- per-session exchange log: `${STATE_ROOT}/sessions/<chat-id>/<topic-id>/exchange-log.jsonl`
- per-session brief: `${STATE_ROOT}/sessions/<chat-id>/<topic-id>/active-brief.md`

Healthy runtime usually means:

- `lifecycle_state: running`
- fresh `observed_at`
- sensible `active_run_count`
- expected bot usernames and forum chat id

## Local Admin Surface

Use the repo-local admin CLI when a topic is already parked or deleted and Telegram commands are no longer reachable:

```bash
make admin ARGS='status'
make admin ARGS='sessions --state parked'
make admin ARGS='show -1001234567890 12345'
make admin ARGS='pin -1001234567890 12345'
make admin ARGS='unpin -1001234567890 12345'
make admin ARGS='reactivate -1001234567890 12345'
make admin ARGS='purge -1001234567890 12345'
```

## Services

```bash
make service-install
make service-status
make service-logs
make service-restart
```

With Omni enabled:

```bash
make service-install-omni
make service-status-omni
make service-logs-omni
make service-restart-omni
```

Those `service-*` flows are Linux-only because they target `systemd --user`.

## Failure Handling

- run `make doctor` first
- use `make admin ARGS='status'` before blind restarts
- if only one topic is wedged, prefer topic-level `/status`, `/interrupt`, `/purge`
- if a live run is still active, avoid blind `service-restart`
- if the topic path itself is broken, switch to the emergency private chat lane
- if the topic is already gone, use the local admin surface instead of poking Telegram harder
- correlate `runtime-events.ndjson`, `meta.json`, `exchange-log.jsonl`, and `active-brief.md` before hand-editing state
- after manual `/compact`, expect the next fresh run to bootstrap from `active-brief.md`

## Recovery Notes

- if a stored `codex_thread_id` no longer resumes cleanly, the runtime retries once before falling back to compact recovery
- if Omni is disabled globally, old topic `auto_mode` state stays on disk but becomes inert
- if Telegram reports a topic as unavailable, the session may move into `parked`
- if Telegram loses the original reply target for a topic message, topic delivery falls back to a plain send in the same topic
- expired parked sessions may be auto-purged by retention sweep
