# Deployment

## First-install minimum

Required runtime settings:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID` or `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_FORUM_CHAT_ID`

Recommended on multi-host installs:

- `WORKSPACE_ROOT`
- `CURRENT_HOST_ID` (treat as required on Linux service)

Optional but commonly useful:

- `DEFAULT_SESSION_BINDING_PATH`
- `TELEGRAM_EXPECTED_TOPICS`
- `TELEGRAM_ALLOWED_BOT_IDS`
- `STATE_ROOT`
- `CODEX_GATEWAY_ALLOW_REPO_ENV`
- `HOST_REGISTRY_PATH`
- `CODEX_BIN_PATH`
- `CODEX_GATEWAY_BACKEND`
- `CODEX_ENABLE_LEGACY_APP_SERVER`
- `CODEX_CONFIG_PATH`
- `CODEX_SESSIONS_ROOT`
- `CODEX_LIMITS_SESSIONS_ROOT`
- `CODEX_LIMITS_COMMAND`
- `HOST_SYNC_INTERVAL_MINUTES`
- `HOST_SSH_CONNECT_TIMEOUT_SECS`
- `MAX_PARALLEL_SESSIONS`

## Telegram-side baseline

- use a forum-enabled supergroup
- disable privacy mode for the bot
- make the bot an admin in that forum chat
- topic creation and cleanup work best when the bot can post, edit, delete, pin, and manage topics

## Canonical runtime env

`${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env`

Practical Linux service bootstrap:

```bash
cd /path/to/codex-telegram-gateway
npm ci
install -d -m700 ${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway
install -m600 .env.example ${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env
$EDITOR ${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env
ENV_FILE=${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env make doctor
```

On native Windows, the practical default is repo-local `.env`, and it is preferred even if a config `runtime.env` also exists. Explicit `ENV_FILE` still wins. On Linux service, repo-local `.env` fallback is disabled unless `CODEX_GATEWAY_ALLOW_REPO_ENV=1`; use the canonical config `runtime.env`.

## Workspace and host settings

- `WORKSPACE_ROOT` — preferred workspace root
- `CURRENT_HOST_ID` — canonical host id such as `controller`, `worker-a`, `worker-b`, or `worker-c`
- `CODEX_GATEWAY_ALLOW_REPO_ENV` — Linux service pre-load escape hatch; set in the shell only when you intentionally want repo-local `.env` fallback
- `CODEX_ALLOW_SYSTEM_TEMP_DELIVERY` — runtime debug-only; set `1` only if `telegram-file` delivery must accept broad system temp roots
- `DEFAULT_SESSION_BINDING_PATH` — optional default landing path for plain `/new`
- `HOST_SYNC_INTERVAL_MINUTES` — host-sync timer interval on `controller`; default `15`
- `HOST_SSH_CONNECT_TIMEOUT_SECS` — SSH timeout for sync and doctor; default `8`
- `HOST_REGISTRY_PATH` — optional override for the host registry JSON; defaults under `STATE_ROOT/hosts/registry.json`

## Codex runtime and limits settings

- `CODEX_GATEWAY_BACKEND` — `exec-json` by default; set `app-server` only as a temporary fallback/debug switch
- `CODEX_ENABLE_LEGACY_APP_SERVER` — must be `1` before `CODEX_GATEWAY_BACKEND=app-server` is accepted; leave unset for normal exec-json operation
- `CODEX_BIN_PATH` — optional Codex executable path; defaults to `codex` on Linux/POSIX and `codex.cmd` on native Windows. On Windows, prefer `codex.cmd` or an absolute `...\codex.cmd` path.
- `CODEX_CONFIG_PATH` — explicit path to the Codex config when you want the runtime pinned to a known profile
- `CODEX_SESSIONS_ROOT` — optional raw Codex sessions root for snapshot/context resolution on the gateway host; defaults to host-local `~/.codex/sessions`. Remote Codex processes keep their own host-local sessions roots; the gateway does not share one raw `.codex/sessions` tree across hosts.
- `CODEX_MODEL` — optional runtime override for the live Spike model
- `CODEX_REASONING_EFFORT` — optional runtime override for reasoning effort
- `CODEX_CONTEXT_WINDOW` — optional runtime override for the configured context window shown in `/status` and passed to Codex
- `CODEX_AUTO_COMPACT_TOKEN_LIMIT` — optional runtime override for the auto-compact threshold shown in `/status` and passed to Codex
- `CODEX_LIMITS_SESSIONS_ROOT` — highest-priority snapshot scan root for `/limits`; defaults to `CODEX_SESSIONS_ROOT` when unset
- `CODEX_LIMITS_COMMAND` — optional external command that prints one JSON limits object
- `CODEX_LIMITS_CACHE_TTL_SECS` — limits cache TTL; default `30`
- `CODEX_LIMITS_COMMAND_TIMEOUT_SECS` — limits command timeout; default `15`

If these env overrides are unset, the gateway falls back to the values from `CODEX_CONFIG_PATH` and `/status` shows the effective live settings from that runtime config snapshot. Spike launches pass the resolved model, reasoning, context window, and auto-compact values to Codex as runtime `-c` overrides. Compaction launches use the separate compact model/reasoning profile, pass the context window, and raise native auto-compact just above that window so gateway bounded-source fallback remains deterministic.

The default Spike backend runs one `codex exec --json` process per turn. The child process receives an allowlisted runtime environment for OS basics, Codex/OpenAI auth/config, proxy, cert, and temp settings; gateway secrets such as Telegram tokens, `ENV_FILE`, `STATE_ROOT`, and host-registry paths are not inherited.

```bash
printf '%s' "$prompt" | codex exec --json --dangerously-bypass-approvals-and-sandbox -C "$cwd" -
printf '%s' "$prompt" | codex exec --json --dangerously-bypass-approvals-and-sandbox -C "$cwd" resume "$thread_id" -
```

Remote topics use the same command through direct `ssh -T`; the SSH connection stays open for that turn. The gateway resolves the bound host cwd/bin path first, stages remote images under a per-run `<worker_runtime_root>/remote-inputs/...` directory, removes that staging directory after the child exits, and still passes runtime `-c` overrides. Mid-turn spool/detach is intentionally not part of the current deployment.

If `codex exec` reports context-window exhaustion, the worker makes one recovery attempt: compact the topic into `active-brief.md` using the source selector in `docs/state-contract.md`, clear stale thread/provider continuity, and retry once as a fresh exec-json thread. If that also fails, the original failure plus recovery warning remain visible in runtime diagnostics. The worker does not depend on sending `/compact` into noninteractive `codex exec --json resume`.

Use `CODEX_GATEWAY_BACKEND=app-server` only when intentionally debugging the old WebSocket transport, and set `CODEX_ENABLE_LEGACY_APP_SERVER=1` for that debug run.


## Multi-host on `controller`

The shipped multi-host slice is intentionally narrow but practical:

- `controller` owns the canonical host registry and rendered `codex-space`
- `controller` can sync rendered host outputs to workers over SSH
- `controller` can bootstrap a helper-capable remote runtime on `worker-a` / `worker-b` / `worker-c`
- ordinary Spike prompt dispatch can run on a bound remote host while `controller` stays the Telegram/session control plane
- remote image staging, file delivery, `/diff`, queued `/q` prompts, and busy follow-up live steer stay on that same bound host path
- remote exec-json live steer is recovery-based: the control plane interrupts the active remote exec process, tolerates the controlled interrupted-child exit when no fatal JSONL event arrived, and resumes the bound Codex thread with the merged prompt
- local-MCP hosts are `ready` only when Docker is actually available there

Practical operator sequence on `controller`:

```bash
cd /path/to/codex-telegram-gateway
ENV_FILE=${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env make host-bootstrap
ENV_FILE=${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env make host-sync
ENV_FILE=${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env make host-bootstrap-runtime ARGS='--host worker-a'
ENV_FILE=${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env make host-doctor
ENV_FILE=${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env make host-remote-smoke ARGS='--host worker-a'
ENV_FILE=${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env make host-sync-install
ENV_FILE=${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env make host-sync-status
```

Host registry `ssh_target` values are intentionally constrained to safe SSH aliases or `user@host` names. Values with whitespace, leading `-`, shell metacharacters, or `:` are rejected before SSH/rsync calls. Rsync calls use protected-args mode so valid remote paths with spaces stay single operands after the SSH hop.

Remote runtime bootstrap will not install an unpinned Codex package. Provide a copied `CODEX_BIN_PATH`/`sourceBinPath` or an explicit pinned package spec such as `@openai/codex@0.124.0`.

## Services

Main Linux user service:

- `codex-telegram-gateway.service`

These flows are Linux-only because they target `systemd --user`.

Generated user units set `UMask=0077`; runtime state writers also create private files/directories by default. If old state predates this hardening, run the chmod repair noted in the runbook or reinstall/restart through the normal service entrypoints.

Useful entrypoints:

```bash
make service-install
make service-status
make service-logs
make service-rollout
make service-restart
make service-restart-live
```

`make service-rollout` / `make service-restart` are the safe soft-rollout path.
`make service-restart-live` is the usual live-bot restart entrypoint.
Before repeating a restart, run `make admin ARGS='status'`; if rollout is already `requested` or `in_progress`, wait instead of chaining another soft rollout.

Last resort only:

```bash
make service-hard-restart
```

`make service-hard-restart` is the blind restart path and can cut active runs. Do not use raw `systemctl restart codex-telegram-gateway.service` for ordinary updates.

If you intentionally pin a local Codex fork, prefer an absolute binary path outside the repo build tree and keep `CODEX_CONFIG_PATH` pointed at the intended config.

## Native Windows

```powershell
cd O:\workspace\codex-telegram-gateway
copy .env.example .env
scripts\windows\install.cmd
scripts\windows\install-codex.cmd
scripts\windows\doctor.cmd
scripts\windows\admin.cmd status
scripts\windows\run.cmd
```

If you prefer manual commands in PowerShell, use `npm.cmd`, not bare `npm`.
