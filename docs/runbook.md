# Runbook

## Canonical paths

- repo root: `/path/to/codex-telegram-gateway`
- state root: `${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway`
- runtime env: `${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env`

## First checks

```bash
cd /path/to/codex-telegram-gateway
runtime_env="${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env"
export ENV_FILE="$runtime_env"
make doctor
make admin ARGS='status'
make service-status
make service-logs
```

Useful live files:

- heartbeat: `${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway/logs/runtime-heartbeat.json`
- events: `${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway/logs/runtime-events.ndjson`
- doctor snapshot: `${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway/logs/doctor-last-run.json`

If state was created before private-by-default permissions, repair it once:

```bash
chmod -R go-rwx "${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway"
```

## Main operator actions

```bash
runtime_env="${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env"
export ENV_FILE="$runtime_env"
make run
make smoke
make soak
make service-install
make service-rollout
make service-restart
make service-restart-live
```

`make service-rollout` / `make service-restart` are the safe soft-rollout path.
Use `make service-restart-live` for ordinary live-bot updates.
Before repeating a restart, run `make admin ARGS='status'`; if rollout is already `requested` or `in_progress`, wait instead of chaining another rollout.

Last resort only:

```bash
make service-hard-restart
```

Use `make service-hard-restart` only when you explicitly want a blind restart that can cut active runs. Do not use raw `systemctl restart codex-telegram-gateway.service` for ordinary updates.

## Host-affinity checks

```bash
make host-bootstrap
make host-sync
make host-bootstrap-runtime ARGS='--host worker-a'
make host-doctor
make host-remote-smoke ARGS='--host worker-a'
make host-sync-install
make host-sync-status
```

Expected results:

- ready hosts appear as ready
- unavailable hosts are named explicitly
- bound-topic prompts fail closed instead of silently rebinding to `controller`
- remote `telegram-file` sends work only from the translated worktree/cwd allowed roots on the bound host unless debug system-temp delivery is explicitly enabled

## Common failures

### Topic says host unavailable

Meaning: the topic is bound to a host that is not currently ready.

Do:

1. `make host-doctor`
2. inspect the reported host failure reason
3. restore that host or create a new topic bound to a ready host

Do not silently rebind the broken topic.

### Topic lost its binding

Meaning: the session no longer has a valid saved execution host.

The runtime fails closed on purpose. Create a fresh topic from `General` with `/new ...`.

### `/diff` says unavailable

Meaning: the topic binding points at a plain directory, not a git repo.

That is not a runtime failure. Either switch to a git-backed binding or ignore `/diff` for that topic.

### `/compact` looks stuck

Check:

- active run ownership in `/status`
- `/status` context-pressure lines (`auto-compact`, context window, and latest usage) so you know whether the runtime is near a compact boundary
- `logs/runtime-events.ndjson`
- whether the topic is already in `compaction_in_progress`

Remember: `/compact` intentionally rebuilds `active-brief.md` first and only then resets continuity for the next fresh run. The gateway/operator surface has no separate synthetic report/continue reset mode; `/compact` and Codex auto-compact are the supported context-pressure paths.

### Telegram shows only neutral progress

This should stay as a neutral localized status, for example `Working` plus the spinner, until Codex emits main-run natural-language progress (`agent_message` progress notes or `reasoning`). Internal recovery labels such as `live-steer-restart` should not appear in the bubble. If it looks dead:

1. inspect `runtime-heartbeat.json`
2. inspect recent `runtime-events.ndjson`
3. check whether the run is producing visible `agent_message`/`reasoning` items or only internal plan/file/tool/subagent/command traffic

User-visible failure replies are intentionally short. Raw `codex exec stderr` tails stay in diagnostics/warnings and should not be pasted into the final Telegram error.

### `Codex ran out of room in the model's context window`

This can be caused by a genuinely oversized thread, a stale resume key, or upstream Codex pressure. The default `exec-json` worker should make one recovery attempt automatically:

1. compact the topic into `active-brief.md`
   - source selection follows `docs/state-contract.md`: full log for small logs, full `compaction-source.md` when small logs also have pending progress notes, bounded source for oversized logs
2. clear stale thread/provider continuity
3. retry once as a fresh `codex exec --json` thread with the latest user prompt

If it still fails, check `logs/runtime-events.ndjson` for `recovery_kind: context-window-compact`, then run gateway `/compact` manually or start a fresh `/new` topic if the upstream error is persistent. Do not assume sending `/compact` into `codex exec --json resume` is a stable noninteractive recovery API.

### Remote exec-json topic fails on SSH/path setup

Default remote execution is direct `ssh -T <host> codex exec --json`, not the JSON-RPC host executor. Check:

- `/status` for backend and bound host
- `make host-doctor`
- `make host-remote-smoke ARGS='--host <id>'`
- host registry fields: `ssh_target`, `workspace_root`, `worker_runtime_root`, `codex_bin_path`, `codex_config_path`, `codex_auth_path`, and `default_binding_path`
- `logs/runtime-events.ndjson`

`node src/cli/host-executor.js --stdio-jsonrpc` applies only to the fallback app-server backend.

### `codex app-server` exited with code `0`

This applies only when `CODEX_GATEWAY_BACKEND=app-server` and `CODEX_ENABLE_LEGACY_APP_SERVER=1`.

Treat graceful `app-server` exit based on timing:

- after a final answer, graceful exit is normal completion
- before a final answer, treat it as resumable transport loss instead of an automatic crash diagnosis

If a thread id exists, recovery should stay on the resume path before you assume the worker or gateway is broken.

### Exec backend follow-up did not live-steer

That is not expected for the default `exec-json` backend anymore. A busy plain follow-up should be accepted as live steer: the gateway appends it to the logical run, interrupts the active exec process, and resumes the Codex thread with the merged prompt. `/q` is still the explicit next-turn queue.

Check:

- whether Telegram replied with the live-steer accepted message or a deferred queue message
- `/status` backend line
- `logs/runtime-events.ndjson` for `backend: exec-json`
- whether the current exec process was interrupted and recovery started a same-thread retry
- for `exec-json`, a steer-triggered child exit may look like `code=1, signal=null`; that is a controlled upstream interruption when steer was requested and no fatal JSONL event arrived, not a user-visible `stream ended before turn.completed` failure

## Manual state cleanup

Use `/purge` from the topic when possible.

If you must inspect state manually, session directories live under:

```text
state/.../sessions/<chat-id>/<topic-id>/
```

Useful files there:

- `meta.json`
- `exchange-log.jsonl`
- `progress-notes.jsonl`
- `active-brief.md`
- `compaction-source.md`
- `spike-prompt-queue.json`
- `incoming/`
- `artifacts/`
- `topic-control-panel.json`

Legacy removed autonomy metadata may still exist in old state snapshots, but the runtime strips/ignores it during normalization.
