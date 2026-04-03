# codex-telegram-gateway

![codex-telegram-gateway banner](./assets/readme/codex-telegram-gateway-banner.svg)

`codex-telegram-gateway` is a practical Telegram control surface for the real local `codex` CLI.

The model stays intentionally small:

- one Telegram topic = one working session
- `Spike` = the live worker that reads code, edits files, runs commands, and sends progress/final replies
- optional `Omni` = the lightweight supervisor that owns `/auto`
- local disk state = the durable memory surface

This repo is not a hosted SaaS, not a generic multi-agent platform, and not a replacement for Codex itself. It is a focused bridge between Telegram forum topics and a real machine where Codex is already installed.

## What 0.2.0 Adds

- optional `Omni` bot with goal-locked `/auto`
- topic-local and `General` menus via `/menu` and `/global`
- beginner `/guide` PDF
- queued prompts with `/q`
- richer docs split into focused guides
- better rendering, safer file delivery, and more durable recovery state

## Main Capabilities

- one topic maps to one durable local session
- live follow-ups can steer into an active run
- commentary-style progress delivery instead of raw tool spam
- attachment-aware prompts, including file-first flows
- `/new Topic Name` topic creation when the bot has Telegram rights
- `/help`, `/guide`, `/status`, `/language`, `/wait`, `/suffix`, `/model`, `/reasoning`, `/interrupt`, `/diff`, `/compact`, `/purge`
- optional `/auto`, `/omni`, `/omni_model`, `/omni_reasoning`
- emergency operator-only private chat lane
- generated recovery briefs rebuilt from the clean exchange log

## Deployment Shapes

### Spike-only

The simplest setup. Leave `OMNI_BOT_TOKEN` and `OMNI_BOT_ID` unset, or set `OMNI_ENABLED=false`.

This is a good default if you only want one working bot or if your Codex access is on a tight token cap. `/auto` can consume noticeably more tokens because it wakes `Omni` for each supervisory cycle.

### Spike + Omni

Add `OMNI_BOT_TOKEN` and `OMNI_BOT_ID` to enable `/auto`.

In this shape:

- `Spike` still does the heavy live work
- `Omni` stays small and topic-scoped
- normal direct prompts stop going to `Spike` while `/auto` owns that topic

## Quick Start

1. Create a Telegram bot in `@BotFather`.
2. Disable privacy mode for it.
3. Add it to a forum-enabled supergroup and make it an admin.
4. Copy `.env.example` to `.env`.
5. Fill in your Telegram ids and local paths.
6. Run checks and start the poller.

```bash
cp .env.example .env
make doctor
make test
make run
```

If you want `/auto`, configure the Omni variables too and run:

```bash
make run-omni
```

## The Few Env Values That Matter

Required:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID` or `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_FORUM_CHAT_ID`
- `WORKSPACE_ROOT`

Common optional values:

- `DEFAULT_SESSION_BINDING_PATH`
- `TELEGRAM_ALLOWED_BOT_IDS`
- `CODEX_BIN_PATH`
- `MAX_PARALLEL_SESSIONS`
- `OMNI_ENABLED`
- `OMNI_BOT_TOKEN`
- `OMNI_BOT_ID`

By default:

- direct CLI usage looks for `${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env`
- `make` targets use `.env` in the repo root unless you override `ENV_FILE`
- mutable runtime state goes under `${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway`

## First Sanity Check

Inside Telegram:

1. open `General`
2. send `/help`
3. create a work topic with `/new Backend Cleanup` or use an existing topic
4. send a normal text prompt in that work topic
5. confirm the reply comes back into the same topic

Then check the rescue lane:

1. open a private chat with the bot
2. send `/status`
3. confirm it replies there too

## Repo Entry Points

```bash
make doctor
make run
make run-omni
make smoke
make smoke-omni
make soak
make admin ARGS='status'
make service-install
make service-install-omni
make test
make test-live
```

## Docs

- [docs/index.md](./docs/index.md) — docs entrypoint
- [docs/architecture.md](./docs/architecture.md) — runtime flow and boundaries
- [docs/telegram-surface.md](./docs/telegram-surface.md) — commands, menus, buffering, queueing, rendering
- [docs/omni-auto.md](./docs/omni-auto.md) — `/auto`, `Omni`, memory, handoffs
- [docs/deployment.md](./docs/deployment.md) — env model and service shapes
- [docs/testing.md](./docs/testing.md) — doctor, smoke, soak, live-user validation
- [docs/runbook.md](./docs/runbook.md) — live operations and recovery
- [docs/state-contract.md](./docs/state-contract.md) — durable state surfaces
- [docs/setup.md](./docs/setup.md) — compact setup walkthrough
