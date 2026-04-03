<p align="center">
  <img src="./assets/readme/codex-telegram-gateway-banner.svg" alt="codex-telegram-gateway banner">
</p>

<h1 align="center">codex-telegram-gateway</h1>

<p align="center">
  <strong>Turn a Telegram forum into a clean control surface for your local Codex runtime.</strong>
</p>

<p align="center">
  One topic = one session. <code>Spike</code> does the work. <code>Omni</code> optionally supervises <code>/auto</code>.
</p>

<p align="center">
  <a href="https://github.com/Krablante/codex-telegram-gateway/releases">
    <img src="https://img.shields.io/github/v/release/Krablante/codex-telegram-gateway?style=for-the-badge" alt="GitHub release">
  </a>
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License">
  </a>
  <img src="https://img.shields.io/badge/Node-20%2B-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node 20+">
  <img src="https://img.shields.io/badge/Telegram-Forum%20Topics-26A5E4?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram forum topics">
</p>

<p align="center">
  <a href="./docs/setup.md">Setup</a>
  ·
  <a href="./docs/index.md">Docs</a>
  ·
  <a href="./docs/telegram-surface.md">Telegram Surface</a>
  ·
  <a href="./docs/omni-auto.md">Auto Mode</a>
  ·
  <a href="./docs/runbook.md">Runbook</a>
  ·
  <a href="./CHANGELOG.md">Changelog</a>
</p>

`codex-telegram-gateway` is a focused bridge between Telegram forum topics and a real machine where `codex` is already installed.

It is designed for people who already like working in Telegram and want something practical:

- one task, one topic, one durable session
- clean progress instead of raw tool spam
- real local files and commands, not a fake hosted wrapper
- recovery that survives long-running work
- optional autonomy through `Omni`, without turning the project into a general agent platform

## Why People Use It

- Telegram is already open all day.
- A forum topic is a natural task lane.
- The local machine already has the real Codex CLI, repo access, and auth.
- The operator wants one small, understandable system instead of a huge orchestration stack.

## Mental Model

| Piece | Role |
| --- | --- |
| `General` topic | global controls, `/guide`, `/help`, `/global`, creating new work topics |
| work topic | the actual task lane |
| `Spike` | the live worker that reads code, edits files, runs commands, and sends progress/final replies |
| `Omni` | optional lightweight supervisor for `/auto` |
| local state root | durable memory: sessions, briefs, logs, queued prompts, artifacts |

Architecture at a glance:

```text
Telegram forum
├─ General
│  ├─ /help
│  ├─ /guide
│  └─ /global
└─ Work topics
   ├─ plain prompts -> Spike
   ├─ /q, /wait, /suffix, /compact, /purge
   └─ /auto -> Omni supervises, Spike still does the heavy work

Telegram surface -> codex-telegram-gateway -> local codex CLI -> local repos/files/state
```

## Highlights

- one Telegram topic maps to one durable local session
- live follow-ups can steer into an active run
- commentary-style progress delivery instead of raw tool noise
- attachment-aware prompts, including file-first flows
- `/new Topic Name` topic creation when the bot has Telegram rights
- `/help` visual card and `/guide` beginner PDF
- topic-local and global menus through `/menu` and `/global`
- queued prompts with `/q`
- compacted recovery memory rebuilt from the clean exchange log
- operator-only emergency private chat lane
- optional `Omni` bot with goal-locked `/auto`

## Quick Start

Requirements:

- Node.js 20+
- local `codex` CLI installed and already authenticated
- one Telegram supergroup with topics enabled
- one Telegram account that will operate the bot

Fast path:

```bash
git clone https://github.com/Krablante/codex-telegram-gateway.git
cd codex-telegram-gateway

npm install
cp .env.example .env

make doctor
make test
make run
```

Then in Telegram:

1. Open `General`.
2. Send `/help`.
3. Create a work topic with `/new Backend Cleanup`.
4. Enter that topic and send a plain text prompt.

If you want the exact setup flow, use [docs/setup.md](./docs/setup.md).

## What You Will Actually Use

In `General`:

- `/help` — quick visual help
- `/guide` — beginner PDF guide
- `/global` — global settings menu
- `/new Topic Name` — create a new work topic

Inside a work topic:

- normal text — start work with `Spike`
- `/menu` — topic-local settings menu
- `/q ...` — queue the next prompt
- `/wait ...` — buffer a prompt while you type it in parts
- `/suffix ...` — add a reusable prompt suffix
- `/diff` — send the current workspace diff
- `/compact` — rebuild the working brief from the exchange log
- `/purge` — reset local session memory for that topic

If you ever forget the command surface, use `/help` again instead of memorizing everything.

## Deployment Modes

### Spike-only

The recommended starting point.

Leave `OMNI_BOT_TOKEN` and `OMNI_BOT_ID` unset, or set `OMNI_ENABLED=false`.

Use this if:

- you want the smallest possible setup
- you mainly want direct interactive work
- your Codex access is on a capped plan and you do not want `/auto` burning extra tokens

### Spike + Omni

Add `OMNI_BOT_TOKEN` and `OMNI_BOT_ID` to enable `/auto`.

In this mode:

- `Spike` still does the heavy live work
- `Omni` evaluates completed cycles and decides whether to continue, sleep, pivot, block, or finish
- human direct prompts stop going to `Spike` while `/auto` owns that topic

## Configuration That Matters

Required:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID` or `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_FORUM_CHAT_ID`
- `WORKSPACE_ROOT`

Common optional settings:

- `DEFAULT_SESSION_BINDING_PATH`
- `TELEGRAM_ALLOWED_BOT_IDS`
- `STATE_ROOT`
- `CODEX_BIN_PATH`
- `MAX_PARALLEL_SESSIONS`
- `OMNI_ENABLED`
- `OMNI_BOT_TOKEN`
- `OMNI_BOT_ID`

Default path model:

- direct CLI usage looks for `${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env`
- `make` targets use `.env` in the repo root unless you override `ENV_FILE`
- mutable runtime state goes under `${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway`

### Workspace Binding Rules

Set `WORKSPACE_ROOT` on purpose. It is the base directory the gateway uses when it resolves topic bindings and relative `cwd=...` values.

`DEFAULT_SESSION_BINDING_PATH` is the default start path for a plain `/new Topic Name`. If you leave it unset, the gateway falls back to `WORKSPACE_ROOT`. If `WORKSPACE_ROOT` is also unset, the final fallback is your home directory, which is usually too vague for a real setup.

Example:

```env
WORKSPACE_ROOT=/home/you/work
DEFAULT_SESSION_BINDING_PATH=/home/you/work/main-repo
```

Windows example:

```env
WORKSPACE_ROOT=C:/Users/you/work
DEFAULT_SESSION_BINDING_PATH=C:/Users/you/work/main-repo
```

With that setup:

- `/new Backend Cleanup` starts in `/home/you/work/main-repo`
- `/new cwd=experiments/lab Lab thread` starts in `/home/you/work/experiments/lab`
- `/new cwd=/srv/shared/repo Hotfix` uses that absolute path directly

Path rules:

- use paths that make sense on the machine where the gateway itself is running
- Linux examples in this repo use `/home/...`, but on Windows you should use paths such as `C:/Users/you/work`
- for `/new cwd=...`, prefer paths without spaces because the slash-command parser treats spaces as argument separators

## Useful Repo Entry Points

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

## Documentation Map

| If you want to... | Read this |
| --- | --- |
| install and pair the bot correctly | [docs/setup.md](./docs/setup.md) |
| understand the runtime shape | [docs/architecture.md](./docs/architecture.md) |
| learn the Telegram commands and menus | [docs/telegram-surface.md](./docs/telegram-surface.md) |
| use `/auto` well | [docs/omni-auto.md](./docs/omni-auto.md) |
| deploy as user services | [docs/deployment.md](./docs/deployment.md) |
| validate changes locally | [docs/testing.md](./docs/testing.md) |
| operate or recover a live instance | [docs/runbook.md](./docs/runbook.md) |
| understand what is stored on disk | [docs/state-contract.md](./docs/state-contract.md) |

## Project Boundaries

This repo is intentionally not trying to be:

- a hosted SaaS
- a generic multi-provider orchestration framework
- a multi-tenant team platform
- a replacement for the Codex CLI itself

The whole point is a small, understandable, host-local bridge that feels reliable in day-to-day use.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

Main principles:

- keep runtime state out of the repo
- prefer repo entry points over ad hoc commands
- keep the system host-oriented and understandable
- run `make test` before sending changes
