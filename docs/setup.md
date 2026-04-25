# Setup

This is the recommended first-time setup path for a single operator running the gateway on one machine.

If you want the shortest version:

```bash
npm ci
runtime_env="${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env"
state_root="${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway"
install -d -m700 "$(dirname "$runtime_env")" "$state_root"
install -m600 .env.example "$runtime_env"

# fill the required values in "$runtime_env":
# TELEGRAM_BOT_TOKEN
# TELEGRAM_ALLOWED_USER_ID or TELEGRAM_ALLOWED_USER_IDS
# TELEGRAM_FORUM_CHAT_ID
# WORKSPACE_ROOT
# optional: DEFAULT_SESSION_BINDING_PATH
$EDITOR "$runtime_env"
export ENV_FILE="$runtime_env"
make doctor
make test
make run
```

Then open Telegram, go to `General`, and send `/help`.

Native Windows quick path:

```powershell
copy .env.example .env
scripts\windows\install.cmd
scripts\windows\install-codex.cmd
scripts\windows\doctor.cmd
scripts\windows\test.cmd
scripts\windows\run.cmd
```

## Before You Start

You need:

- Node.js 20+
- the local `codex` CLI already installed and authenticated
- one Telegram account that will operate the bot
- one Telegram supergroup with topics enabled

The current public runtime is single-bot. `Spike` is the worker.

If you are on Windows, prefer the native Windows path first. Only use WSL when you already know your WSL networking and path setup are healthy.

Large-file note:

- normal setup stays on the default cloud Bot API
- oversized prompt attachments now fail cleanly with an inline reply instead of wedging the poll loop
- if you later want true Telegram-native huge-file ingestion with per-topic disk storage, plan on a Local Bot API server; that is an optional future extension, not part of the minimum install

## 1. Create The Spike Bot

1. Open `@BotFather`.
2. Run `/newbot`.
3. Copy the token into `TELEGRAM_BOT_TOKEN`.
4. Run `/setprivacy`.
5. Choose the bot.
6. Set privacy mode to `Disable`.

Without that privacy change, the bot will see commands but miss ordinary prompt text in topics.

## 2. Prepare The Telegram Chat

1. Create or reuse a Telegram supergroup.
2. Enable topics in that chat.
3. Add the bot to the chat.
4. Promote the bot to admin.

Recommended rights:

- post messages
- edit messages
- delete messages
- pin messages
- manage topics

`/new Topic Name` needs topic-management rights. The rest of the gateway still works without it if you only use existing topics.

## 3. Get The Numeric Ids

You need:

- `TELEGRAM_ALLOWED_USER_ID`
- `TELEGRAM_FORUM_CHAT_ID`

The easy path:

1. send any message in the target Telegram chat
2. call Bot API `getUpdates`

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
```

Read these values:

- `message.from.id` -> `TELEGRAM_ALLOWED_USER_ID`
- `message.chat.id` -> `TELEGRAM_FORUM_CHAT_ID`

## 4. Fill The Env File

```bash
runtime_env="${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env"
install -d -m700 "$(dirname "$runtime_env")"
install -m600 .env.example "$runtime_env"
$EDITOR "$runtime_env"
export ENV_FILE="$runtime_env"
```

Minimum required values:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID` or `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_FORUM_CHAT_ID`
- `WORKSPACE_ROOT`

Minimal practical example:

```env
TELEGRAM_BOT_TOKEN=replace-me
TELEGRAM_ALLOWED_USER_ID=123456789
TELEGRAM_FORUM_CHAT_ID=-1001234567890
WORKSPACE_ROOT=/home/you/work
DEFAULT_SESSION_BINDING_PATH=/home/you/work/main-repo
```

The first four values are the actual minimum. `DEFAULT_SESSION_BINDING_PATH` is optional and only changes where plain `/new Topic Name` starts when you do not pass `cwd=...`.

Set `WORKSPACE_ROOT` deliberately. It becomes the base path for relative topic bindings such as `/new cwd=backend/api Fix auth`.

Useful defaults:

- `DEFAULT_SESSION_BINDING_PATH`
  the path used by `/new` when you do not pass `cwd=...`
- `TELEGRAM_ALLOWED_BOT_IDS`
  optional allowlist for other trusted bots in the same forum

Optional but commonly useful:

- `TELEGRAM_EXPECTED_TOPICS`
- `STATE_ROOT`
- `CODEX_BIN_PATH`
- `CODEX_LIMITS_SESSIONS_ROOT`
- `CODEX_LIMITS_COMMAND`
- `MAX_PARALLEL_SESSIONS`

Optional trusted bot id:

- `SPIKE_BOT_ID`

Recommended path setup:

```env
WORKSPACE_ROOT=/home/you/work
DEFAULT_SESSION_BINDING_PATH=/home/you/work/main-repo
```

Windows example:

```env
WORKSPACE_ROOT=C:/Users/you/work
DEFAULT_SESSION_BINDING_PATH=C:/Users/you/work/main-repo
```

Leave `CODEX_BIN_PATH` empty unless you really need an override. The runtime defaults to `codex` on Linux and `codex.cmd` on native Windows. If you set it explicitly on Windows, prefer `codex.cmd` or an absolute `...\codex.cmd` path.

What that means in practice:

- `/new Backend Cleanup` starts in `/home/you/work/main-repo`
- `/new cwd=experiments/prototype Prototype work` resolves to `/home/you/work/experiments/prototype`
- `/new cwd="C:/Users/Example User/Source Repos" Audit topic` works too because quoted explicit paths with spaces are supported
- if `DEFAULT_SESSION_BINDING_PATH` is unset, the gateway falls back to `WORKSPACE_ROOT`
- if `WORKSPACE_ROOT` is also unset, the final fallback is your home directory, which is usually not what you want
- on Windows, use Windows paths for both env values and absolute `cwd=...` values
- if a path contains spaces, quote the explicit `cwd=...` value

## 5. Validate Before Running

```bash
export ENV_FILE="${ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env}"
make doctor
make test
```

Native Windows:

```powershell
scripts\windows\doctor.cmd
scripts\windows\test.cmd
```

`make doctor` should confirm:

- the bot token works
- the expected forum chat is reachable
- topics are enabled
- the webhook is empty unless you intentionally use a Telegram-compatible proxy

## 6. Run It

Foreground:

```bash
export ENV_FILE="${ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env}"
make run
```

Native Windows:

```powershell
scripts\windows\run.cmd
```

User service:

```bash
export ENV_FILE="${ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env}"
make service-install
make service-status
make service-rollout
```

Those `service-*` flows are Linux-only because they target `systemd --user`.
Use `make service-rollout` or `make service-restart` for the soft Spike handoff path. Reserve `make service-hard-restart` for blind restarts.

Repo-local `.env` remains convenient for native Windows and throwaway development. For Linux service operation, keep secrets in the config-root `runtime.env` above and pass it through `ENV_FILE`.

## 7. First Telegram Check

Inside Telegram:

1. open `General`
2. send `/help`
3. optionally send `/guide`
4. create a topic with `/new Backend Cleanup`
5. enter that topic and send a plain text prompt
6. confirm the reply comes back into the same topic

Emergency lane sanity check:

1. open a private chat with the bot
2. send `/status`
3. confirm the bot answers there too

That private chat is the rescue lane if the normal topic path breaks.

## Common Mistakes

- Bot privacy mode is still enabled
- the target chat is not a supergroup
- topics are not enabled
- the chat id came from the wrong conversation
- the bot is in the chat but not an admin
- `WORKSPACE_ROOT` points to a path that does not exist locally
- WSL was used for a first install even though native Windows would have been simpler

## What To Read Next

- [telegram-surface.md](./telegram-surface.md) — commands and menus
- [deployment.md](./deployment.md) — env model and service deployment
- [runbook.md](./runbook.md) — live operations and recovery
