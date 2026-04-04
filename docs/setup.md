# Setup

This is the recommended first-time setup path for a single operator running the gateway on one machine.

If you want the shortest version:

```bash
npm install
cp .env.example .env

# fill the required values in .env:
# TELEGRAM_BOT_TOKEN
# TELEGRAM_ALLOWED_USER_ID
# TELEGRAM_FORUM_CHAT_ID
# WORKSPACE_ROOT
# optional: DEFAULT_SESSION_BINDING_PATH
make doctor
make test
make run
```

Then open Telegram, go to `General`, and send `/help`.

## Before You Start

You need:

- Node.js 20+
- the local `codex` CLI already installed and authenticated
- one Telegram account that will operate the bot
- one Telegram supergroup with topics enabled

You do not need `Omni` to get started. Spike-only mode is the simplest and usually the best first install.

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
cp .env.example .env
```

Minimum required values:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID` or `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_FORUM_CHAT_ID`
- `WORKSPACE_ROOT`

Minimal practical example:

```env
TELEGRAM_BOT_TOKEN=123456:replace-me
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
- `MAX_PARALLEL_SESSIONS`

Optional Omni setup:

- `OMNI_ENABLED`
- `OMNI_BOT_TOKEN`
- `OMNI_BOT_ID`
- `SPIKE_BOT_ID`

If you do not need `/auto` yet, leave the Omni settings unset and start with Spike-only mode.

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

What that means in practice:

- `/new Backend Cleanup` starts in `/home/you/work/main-repo`
- `/new cwd=experiments/prototype Prototype work` resolves to `/home/you/work/experiments/prototype`
- if `DEFAULT_SESSION_BINDING_PATH` is unset, the gateway falls back to `WORKSPACE_ROOT`
- if `WORKSPACE_ROOT` is also unset, the final fallback is your home directory, which is usually not what you want
- on Windows, use Windows paths for both env values and absolute `cwd=...` values
- for `/new cwd=...`, prefer paths without spaces because the command parser splits on spaces

## 5. Validate Before Running

```bash
make doctor
make test
```

`make doctor` should confirm:

- the bot token works
- the expected forum chat is reachable
- topics are enabled
- the webhook is empty unless you intentionally use a Telegram-compatible proxy

## 6. Run It

Foreground:

```bash
make run
```

User service:

```bash
make service-install
make service-status
```

If Omni is configured:

```bash
make run-omni
```

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
- Omni was configured immediately even though Spike-only would have been enough for the first run

## What To Read Next

- [telegram-surface.md](./telegram-surface.md) — commands and menus
- [deployment.md](./deployment.md) — Spike-only vs Spike+Omni
- [runbook.md](./runbook.md) — live operations and recovery
