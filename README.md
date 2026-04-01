# codex-telegram-gateway

![codex-telegram-gateway banner](./assets/readme/codex-telegram-gateway-banner.svg)

`codex-telegram-gateway` is a small personal project that lets me work with the real local `codex` CLI from inside Telegram topics.

The model is simple:

- one Telegram topic = one working session
- one bot = one operator-facing gateway
- local files on disk = the durable memory surface

I wanted something practical, not a “platform”. It should feel like a reliable remote control for the machine where Codex is already installed, with just enough session memory and recovery logic to survive real day-to-day use.

The Telegram-side interface is bilingual today: `RUS` and `ENG` are both supported, and you can switch a topic with `/language rus` or `/language eng`.

## What It Actually Does

Inside a forum-enabled Telegram supergroup, each topic becomes its own lane:

- prompts stay inside that topic
- replies come back into that same topic
- follow-up messages can be steered into a live run
- the session keeps local memory in `meta.json`, `exchange-log.jsonl`, and `active-brief.md`

There is also an operator-only emergency lane in the bot's private chat. That path bypasses the normal topic/session transport and uses isolated `codex exec`, so you still have a repair path if the main topic flow breaks.

## Why This Exists

This repo is for people who already like working in Telegram and already trust their local Codex runtime.

It is not trying to be:

- a hosted SaaS
- a generic multi-agent orchestration framework
- a provider-agnostic chat abstraction layer
- a replacement for the Codex CLI itself

It is a focused bridge between Telegram topics and a real local Codex install.

## Main Capabilities

- one topic maps to one session
- live `turn/steer` into an active run
- commentary-style progress bubbles instead of raw tool spam
- topic-level `/help`, `/status`, `/language`, `/wait`, `/suffix`, `/interrupt`, `/diff`, `/compact`, and `/purge`
- topic creation through `/new` when the bot has the needed Telegram rights
- attachment-aware prompts, including file-first flows
- emergency private-chat rescue lane
- durable session state on disk
- resume-to-compact fallback when old thread continuity is gone
- manual `/compact` resets stored thread-backed context so the next run starts from rebuilt brief continuity
- bilingual topic UI with `ENG` and `RUS` modes via `/language`

## What You Need

- Node.js 20+
- local `codex` CLI installed and authenticated
- a Telegram bot token
- a Telegram supergroup with topics enabled
- one Telegram user id allowed to operate the bot
- BotFather privacy mode disabled

If you want `/new` to create topics, the bot also needs topic-management rights in that chat.

## Quick Start

1. Create a bot in `@BotFather`.
2. Disable privacy mode for it.
3. Add it to a Telegram supergroup with topics enabled.
4. Make it an admin.
5. Copy `.env.example` to `.env`.
6. Fill in the Telegram ids and local paths.
7. Run the checks.

```bash
cp .env.example .env
make doctor
make test
make run
```

If you want the exact setup flow, use [docs/setup.md](./docs/setup.md).

## The Few Env Values That Matter

At minimum, fill these:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`
- `TELEGRAM_FORUM_CHAT_ID`
- `WORKSPACE_ROOT`

Usually you also want:

- `DEFAULT_SESSION_BINDING_PATH`
- `CODEX_BIN_PATH`
- `MAX_PARALLEL_SESSIONS`

The default local env file is `.env` in the repo root. You can override it with `ENV_FILE=/path/to/runtime.env`.

## First Sanity Check

After `make run`, go into the Telegram chat and try this:

1. open or create a topic
2. send `/help`
3. send a normal text prompt
4. make sure the reply comes back into the same topic

Then check the emergency lane too:

1. open a private chat with the bot
2. send `/status`
3. make sure it replies there

If the main topic path ever breaks, that private chat is your rescue lane.

## Repo Entry Points

```bash
make doctor
make run
make smoke
make soak
make admin ARGS='status'
make service-install
make service-status
make service-logs
make service-restart
make test
make test-live
```

## State and Memory

Mutable runtime data stays outside the repo.

By default:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway
```

That state root holds:

- session metadata
- exchange logs
- active briefs
- runtime logs
- temporary incoming files

The important distinction is:

- `exchange-log.jsonl` = raw durable prompt/reply history
- `active-brief.md` = derived recovery summary
- explicit `/compact` = rebuild `active-brief.md` and drop stored thread/context continuity for the next run

## Architecture in One Screen

- `src/cli/run.js` runs the Telegram poller
- `src/telegram/` owns command intake and topic-facing behavior
- `src/session-manager/` owns session state, memory, lifecycle, and compaction
- `src/pty-worker/` owns live Codex runs, steer, recovery, and final delivery
- `src/emergency/` owns the private-chat rescue lane
- `src/transport/` owns Telegram delivery helpers

If you want the deeper version:

- [docs/setup.md](./docs/setup.md)
- [docs/architecture.md](./docs/architecture.md)
- [docs/runbook.md](./docs/runbook.md)
- [docs/state-contract.md](./docs/state-contract.md)
