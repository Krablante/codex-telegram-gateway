# Codex Telegram Gateway Setup

## Goal

Get one operator, one Telegram bot, and one forum-enabled supergroup into a state where `make doctor` passes and `make run` can start the gateway.

## Prerequisites

- Node.js 20+
- local `codex` CLI installed and already authenticated
- one Telegram account that will operate the bot
- one Telegram supergroup with topics enabled

## 1. Create the bot

1. Open `@BotFather`
2. Run `/newbot`
3. Copy the bot token into `TELEGRAM_BOT_TOKEN`
4. Run `/setprivacy`
5. Choose the bot
6. Set privacy mode to `Disable`

Without that privacy change, the bot may only see commands and misses normal prompt text in topics.

## 2. Prepare the Telegram chat

1. Create or reuse a Telegram supergroup
2. Enable topics in that chat
3. Add the bot to the chat
4. Promote the bot to admin

Recommended admin rights:

- post messages
- edit messages
- delete messages
- manage topics

`/new` depends on topic-creation rights. The rest of the gateway still works without it if you only use existing topics.

## 3. Get the numeric ids

You need:

- `TELEGRAM_ALLOWED_USER_ID`
- `TELEGRAM_FORUM_CHAT_ID`

Simple path:

1. send any message in the target Telegram chat
2. call Bot API `getUpdates` once

Example:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
```

Read these fields from the response:

- `message.from.id` -> `TELEGRAM_ALLOWED_USER_ID`
- `message.chat.id` -> `TELEGRAM_FORUM_CHAT_ID`

## 4. Fill the env file

```bash
cp .env.example .env
```

Minimum required values:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`
- `TELEGRAM_FORUM_CHAT_ID`
- `WORKSPACE_ROOT`

Useful default:

- `DEFAULT_SESSION_BINDING_PATH`
  - this is the path used by `/new` when you do not pass `cwd=...`

Optional but useful:

- `TELEGRAM_EXPECTED_TOPICS`
  - comma-separated topic names for `make doctor`
- `STATE_ROOT`
  - if you want runtime state outside the default XDG path

## 5. Validate before running

```bash
make doctor
```

You want to see:

- `doctor: ok`
- the expected forum chat title and id
- `forum_enabled: true`
- sane bot membership
- `webhook_url: (none)` unless you intentionally use a Telegram-compatible API proxy

## 6. Run the gateway

Foreground:

```bash
make run
```

User service:

```bash
make service-install
make service-status
```

## 7. First-use sanity check

Inside the Telegram chat:

1. create or open a topic
2. send `/help`
3. send a normal text prompt
4. verify the bot answers in the same topic
5. if the bot should create new topics, try `/new Test Topic`

Emergency lane sanity check:

1. open a private chat with the bot
2. send `/status`
3. verify the bot answers there without depending on any forum topic
4. remember that this private chat is the rescue lane if the normal topic path breaks

## Common setup mistakes

- Bot privacy mode is still enabled
- the configured chat is not a supergroup
- topics are not enabled in the chat
- the chat id came from the wrong conversation
- the bot is in the chat but not an admin
- `WORKSPACE_ROOT` points to a path that does not exist locally
