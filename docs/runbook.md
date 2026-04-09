# Codex Telegram Gateway Runbook

Use this file for live operations and recovery. Product surface details now live in focused docs:

- [telegram-surface.md](./telegram-surface.md)
- [omni-auto.md](./omni-auto.md)
- [deployment.md](./deployment.md)
- [testing.md](./testing.md)

## Repo-Local Checks

```bash
cd /home/bloob/atlas/homelab/infra/automation/codex-telegram-gateway
make admin ARGS='status'
make admin ARGS='sessions --state parked'
make doctor
make test
```

## Manual Foreground Run

```bash
cd /home/bloob/atlas/homelab/infra/automation/codex-telegram-gateway
make run
```

With Omni enabled:

```bash
cd /home/bloob/atlas/homelab/infra/automation/codex-telegram-gateway
make run-omni
```

Native Windows:

```powershell
cd O:\workspace\codex-telegram-gateway
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

- heartbeat: `/home/bloob/atlas/state/homelab/infra/automation/codex-telegram-gateway/logs/runtime-heartbeat.json`
- events: `/home/bloob/atlas/state/homelab/infra/automation/codex-telegram-gateway/logs/runtime-events.ndjson`
- doctor snapshot: `/home/bloob/atlas/state/homelab/infra/automation/codex-telegram-gateway/logs/doctor-last-run.json`
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
cd /home/bloob/atlas/homelab/infra/automation/codex-telegram-gateway
make admin ARGS='status'
make admin ARGS='sessions --state parked'
make admin ARGS='show -1003577434463 12345'
make admin ARGS='pin -1003577434463 12345'
make admin ARGS='unpin -1003577434463 12345'
make admin ARGS='reactivate -1003577434463 12345'
make admin ARGS='purge -1003577434463 12345'
```

Native Windows equivalent:

```powershell
scripts\windows\admin.cmd status
scripts\windows\admin.cmd sessions --state parked
scripts\windows\admin.cmd show -1003577434463 12345
scripts\windows\admin.cmd pin -1003577434463 12345
scripts\windows\admin.cmd unpin -1003577434463 12345
scripts\windows\admin.cmd reactivate -1003577434463 12345
scripts\windows\admin.cmd purge -1003577434463 12345
```

## Services

```bash
cd /home/bloob/atlas/homelab/infra/automation/codex-telegram-gateway
make service-install
make service-status
make service-logs
make service-rollout
make service-restart
make service-restart-private
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
make service-restart-private
```

`make service-restart-private` is the canonical private-runtime restart: it restarts `Omni` and then rolls `Spike` through the soft session-aware path. Avoid raw `systemctl restart codex-telegram-gateway.service` unless you explicitly want the blind hard-restart behavior.

## Failure Handling

- run `make doctor` first
- use `make admin ARGS='status'` before blind restarts
- if only one topic is wedged, prefer topic-level `/status`, `/interrupt`, `/purge`
- if a live run is still active, start with the soft `service-restart`; move to `service-hard-restart` only when you explicitly want to cut the whole cgroup
- if soft rollout times out because one retained topic is still active, finish or interrupt that topic and rerun `make service-restart-private` instead of falling back to raw `systemctl restart`
- if the topic path itself is broken, switch to the emergency private chat lane
- if the topic is already gone, use the local admin surface instead of poking Telegram harder
- on native Windows, use `scripts\windows\admin.cmd ...` instead of trying Linux-only `make admin`
- correlate `runtime-events.ndjson`, `meta.json`, `exchange-log.jsonl`, and `active-brief.md` before hand-editing state
- after manual `/compact`, expect the next fresh run to bootstrap from `active-brief.md`

## Recovery Notes

- if a stored `codex_thread_id` no longer resumes cleanly, the runtime retries once before falling back to compact recovery
- if Omni is disabled globally, old topic `auto_mode` state stays on disk but becomes inert
- if `zoo/topic.json` is missing, incomplete, or quarantined, a live Zoo menu callback now rebuilds the stored chat/topic/menu binding; before this fix the symptom was silent Zoo button no-ops or the Zoo topic falling back into ordinary session routing
- if Telegram reports a topic as unavailable, the session may move into `parked`
- if Telegram loses the original reply target for a topic message, topic delivery falls back to a plain send in the same topic
- if a prompt attachment is larger than the current direct bot-download ceiling, the gateway now sends a small inline "too large" reply and acknowledges the update instead of retry-looping the same failed poll cycle forever
- if the final Spike reply hits a transient Telegram/network send failure, the gateway now retries that final delivery; if the send still never comes back, it keeps the final answer visible in the existing progress bubble instead of silently dropping the run result
- if a long final reply already delivered some chunks before a later chunk failed, Spike final-event metadata now keeps the delivered Telegram message ids instead of pretending that nothing reached Telegram
- if `turn/completed` wins the race against the real final `agent_message`, the runner now keeps a short grace window for that late primary final answer before falling back to a generic completion text
- if native Windows leaves the websocket alive but the rollout already wrote `task_complete`, the runner can now still finish from that rollout signal instead of staying stuck in `running`
- if local rollout-forwarding IPC hits a blocked or reserved loopback port, the server now retries the next candidate loopback port instead of failing on the first bind error
- expired parked sessions may be auto-purged by retention sweep
- the heartbeat now also exposes generation id, leader/retiring state, and rollout status for service-level handoff visibility
