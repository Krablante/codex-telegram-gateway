# Deployment

## First Install Minimum

Required runtime settings:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID` or `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_FORUM_CHAT_ID`
- `WORKSPACE_ROOT`

Optional but commonly useful:

- `DEFAULT_SESSION_BINDING_PATH`
- `TELEGRAM_EXPECTED_TOPICS`
- `TELEGRAM_ALLOWED_BOT_IDS`
- `STATE_ROOT`
- `CODEX_BIN_PATH`
- `CODEX_LIMITS_SESSIONS_ROOT`
- `CODEX_LIMITS_COMMAND`
- `MAX_PARALLEL_SESSIONS`

Telegram-side baseline:

- use a forum-enabled supergroup
- disable privacy mode for the Spike bot
- make the bot an admin in that forum chat
- topic creation and cleanup flows work best when the bot can post, edit, delete, pin, and manage topics

## Supported Shapes

### Spike-only

- omit `OMNI_BOT_TOKEN` and `OMNI_BOT_ID`
- or set `OMNI_ENABLED=false`

Result:

- only `Spike` is operator-facing
- Omni-only commands disappear from the surface
- stale `auto_mode` state becomes inert instead of blocking prompts

### Spike + Omni

- set `OMNI_BOT_TOKEN`
- set `OMNI_BOT_ID`
- leave `OMNI_ENABLED` unset or set it to `true`

Result:

- run both pollers
- `/auto` becomes available

## Canonical Runtime Env

`${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env`

Linux/operator path keeps that canonical runtime env path.

On native Windows, the practical default is repo-local `.env`. If `ENV_FILE` is unset, the runtime now prefers:

1. the canonical runtime env file when it already exists
2. repo-local `.env`
3. the platform default runtime env path under the local state root

Core settings:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_FORUM_CHAT_ID`
- `TELEGRAM_ALLOWED_USER_ID` or `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_ALLOWED_BOT_IDS`

Optional Omni settings:

- `OMNI_ENABLED`
- `OMNI_BOT_TOKEN`
- `OMNI_BOT_ID`

Workspace settings:

- `WORKSPACE_ROOT` — preferred workspace root for new installs
- `ATLAS_WORKSPACE_ROOT` — compatibility alias for older installs
- `DEFAULT_SESSION_BINDING_PATH` — optional default landing path for plain `/new` without `cwd=...`

Codex limits settings:

- `CODEX_LIMITS_SESSIONS_ROOT` — optional override for where `/limits` scans Codex `.jsonl` session snapshots
- `CODEX_LIMITS_COMMAND` — optional external command spec that prints one JSON object with `source`, `captured_at`, and `snapshot`
- `CODEX_LIMITS_CACHE_TTL_SECS` — cache TTL for `/limits`, `/status`, and menu refreshes; default `30`
- `CODEX_LIMITS_COMMAND_TIMEOUT_SECS` — timeout for the external limits command; default `15`

Practical workspace examples:

- with `WORKSPACE_ROOT=/home/you/work` and `DEFAULT_SESSION_BINDING_PATH=/home/you/work`, plain `/new Backend API` starts in `/home/you/work`
- `/new cwd=homelab/infra Automation` still resolves relative to `WORKSPACE_ROOT`, so it starts in `/home/you/work/homelab/infra`
- quoted explicit binding paths are supported too, so Windows paths with spaces work cleanly, for example `/new cwd="C:/Users/Example User/Source Repos" Audit topic`
- if `DEFAULT_SESSION_BINDING_PATH` is unset, ordinary `/new` falls back to `WORKSPACE_ROOT`

## Codex Limits Source

By default, the gateway reads the newest Codex rate-limit snapshot from `CODEX_SESSIONS_ROOT`.

If limits should come from another machine, set `CODEX_LIMITS_COMMAND` instead. The gateway runs it without an implicit shell.

Preferred format in `.env`:

```bash
CODEX_LIMITS_COMMAND='["python3","/opt/read-limits.py"]'
```

Simple argv-only strings like `python3 /opt/read-limits.py` still work for compatibility, but shell features such as pipes, redirection, and inline env assignments do not. Use a wrapper script or make the shell explicit in argv when you really need that.

The command should print exactly one JSON object like this:

```json
{
  "source": "windows_rtx",
  "captured_at": "2026-04-04T13:10:00.000Z",
  "snapshot": {
    "limit_id": "codex",
    "primary": { "used_percent": 11, "window_minutes": 300, "resets_at": 1775277000 },
    "secondary": { "used_percent": 33, "window_minutes": 10080, "resets_at": 1775881800 }
  }
}
```

`source` is optional, but recommended. It is the short label shown in Telegram. If you omit it, the gateway uses the generic `command` label and never echoes the raw shell command back into chat.

Unlimited accounts are valid too. If the snapshot carries `credits.unlimited=true` or `unlimited=true`, the bot renders `limits: unlimited` instead of pretending the data is missing.

This is the practical path when the Linux gateway host is effectively unlimited but the real capped Codex account lives on another machine, such as a Windows workstation.

## Services

Main:

- `codex-telegram-gateway.service`

Optional Omni:

- `codex-telegram-gateway-omni.service`

These user-service flows are Linux-only because they target `systemd --user`.
`make service-install` now resolves `CODEX_BIN_PATH` without a shell. Absolute paths, repo-relative paths such as `./vendor/bin/codex`, and ordinary PATH-visible names such as `codex` are supported. If resolution still fails, set an absolute `CODEX_BIN_PATH`.

On native Windows, run the gateway directly with:

```powershell
cd O:\workspace\codex-telegram-gateway
copy .env.example .env
scripts\windows\install.cmd
scripts\windows\install-codex.cmd
scripts\windows\doctor.cmd
scripts\windows\admin.cmd status
scripts\windows\run.cmd
```

That bootstrap now matches the repo as-is because `.env.example` is committed and intended for the first native Windows copy-to-`.env` flow.

With Omni:

```powershell
scripts\windows\run-omni.cmd
```

If you prefer manual commands, use `npm.cmd`, not bare `npm`, inside PowerShell.
For repo-local admin recovery on Windows, use `scripts\windows\admin.cmd status` and the same subcommands you would normally pass through `make admin ARGS='...'`.

## Repo Entry Points

```bash
make service-install
make service-status
make service-logs
make service-rollout
make service-restart
make service-hard-restart
```

With Omni:

```bash
make service-install-omni
make service-status-omni
make service-logs-omni
make service-restart-omni
```

## Practical Rule

- if Omni is disabled, the Omni unit may stay stopped
- if the Omni unit is installed but `OMNI_ENABLED=false`, it may idle safely after clearing stale Omni slash commands
- for Spike on Linux, `make service-rollout` and `make service-restart` use the repo-local session-aware rollout command and return only after the replacement generation has taken leader traffic; `make service-hard-restart` is the explicit blind restart path
- Spike `service-install` requires `systemd >= 250` because the user unit depends on `ExitType=cgroup`
- on native Windows, do not use WSL just to get the bot online unless you already know your WSL networking and file-path setup is healthy
- on native Windows, the practical install path is `scripts\windows\install.cmd`, which keeps dependency install reproducible and skips non-essential transitive package scripts
- on native Windows, interrupt/shutdown flows now use a process-tree-aware `taskkill` fallback so nested Codex child processes are less likely to survive a stop
