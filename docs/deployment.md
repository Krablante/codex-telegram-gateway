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
- Omni-only commands disappear from the Telegram surface
- stale topic `auto_mode` state becomes inert instead of blocking normal prompts

This is the recommended starting point if you want the simplest setup or if your Codex access sits behind a strict token cap.

### Spike + Omni

- set `OMNI_BOT_TOKEN`
- set `OMNI_BOT_ID`
- leave `OMNI_ENABLED` unset or set it to `true`

Result:

- run both pollers
- `/auto` becomes available
- `Spike` stays the only heavy worker
- `Omni` evaluates completed cycles and decides whether to continue, sleep, pivot, block, or finish

## Env Files

Default direct CLI env file on Linux/macOS:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env
```

Default direct CLI env file on native Windows:

```text
%LOCALAPPDATA%\codex-telegram-gateway\runtime.env
```

Default `make` env file:

```text
.env
```

That split is intentional:

- direct `node src/cli/...` commands can use one stable runtime env outside the repo
- repo-local development stays simple with `.env`
- if that external runtime env file does not exist yet, the runtime falls back to repo-local `.env`

## Core Settings

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_FORUM_CHAT_ID`
- `TELEGRAM_ALLOWED_USER_ID` or `TELEGRAM_ALLOWED_USER_IDS`
- `WORKSPACE_ROOT`

Useful optional settings:

- `DEFAULT_SESSION_BINDING_PATH`
- `TELEGRAM_ALLOWED_BOT_IDS`
- `STATE_ROOT`
- `CODEX_CONFIG_PATH`
- `CODEX_SESSIONS_ROOT`
- `CODEX_BIN_PATH`
- `MAX_PARALLEL_SESSIONS`

Omni-specific settings:

- `OMNI_ENABLED`
- `OMNI_BOT_TOKEN`
- `OMNI_BOT_ID`
- `SPIKE_BOT_ID`

Practical workspace examples:

- with `WORKSPACE_ROOT=/home/you/work` and `DEFAULT_SESSION_BINDING_PATH=/home/you/work/main-repo`, plain `/new Backend API` starts in `/home/you/work/main-repo`
- `/new cwd=experiments/lab Prototype` still resolves relative to `WORKSPACE_ROOT`, so it starts in `/home/you/work/experiments/lab`
- if `DEFAULT_SESSION_BINDING_PATH` is unset, ordinary `/new` falls back to `WORKSPACE_ROOT`

## Services

Main:

- `codex-telegram-gateway.service`

Optional Omni:

- `codex-telegram-gateway-omni.service`

These service-install flows are Linux-only because they target `systemd --user`.

Native Windows direct path:

```powershell
copy .env.example .env
scripts\windows\install.cmd
scripts\windows\install-codex.cmd
scripts\windows\doctor.cmd
scripts\windows\run.cmd
```

With Omni:

```powershell
scripts\windows\run-omni.cmd
```

## Repo Entry Points

```bash
make service-install
make service-status
make service-logs
make service-restart
```

With Omni:

```bash
make service-install-omni
make service-status-omni
make service-logs-omni
make service-restart-omni
```

## Practical Rules

- if Omni is disabled, the Omni unit may stay stopped
- if the Omni unit is installed but `OMNI_ENABLED=false`, it may idle safely after clearing stale Omni slash commands
- if you use `make service-install`, keep `.env` accurate before installing the unit, because that path is what the unit will remember
- on native Windows, prefer the wrapper scripts over ad-hoc PowerShell commands
- on native Windows, prefer native install over WSL unless your WSL networking and path model are already known-good
