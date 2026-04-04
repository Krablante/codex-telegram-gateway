<p align="center">
  <img src="./assets/readme/codex-telegram-gateway-banner.svg" alt="codex-telegram-gateway banner">
</p>

<h1 align="center">codex-telegram-gateway</h1>

<p align="center">
  <strong>Turn a Telegram forum into a clean control surface for your local Codex runtime.</strong>
</p>

<p align="center">
  One topic = one session. <code>Spike</code> does the work. <code>Omni</code> optionally supervises <code>/auto</code>. <code>Zoo</code> adds an experimental tamagotchi lane for your projects.
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
- one dedicated `Zoo` topic for experimental project tamagotchi cards

## Why People Use It

- Telegram is already open all day.
- A forum topic is a natural task lane.
- The local machine already has the real Codex CLI, repo access, and auth.
- The operator wants one small, understandable system instead of a huge orchestration stack.

## Mental Model

| Piece | Role |
| --- | --- |
| `General` topic | global controls, `/guide`, `/help`, `/global`, `/clear`, creating new work topics |
| `Zoo` topic | dedicated menu-only project tamagotchi lane |
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
│  ├─ /global
│  └─ /clear
├─ Zoo
│  └─ menu-only pet cards for projects
└─ Work topics
   ├─ plain prompts -> Spike
   ├─ /q, /wait, /suffix, /compact, /purge
   └─ /auto -> Omni supervises, Spike still does the heavy work

Telegram surface -> codex-telegram-gateway -> local codex CLI -> local repos/files/state
```

## What's New In v0.2.1

| Area | What changed |
| --- | --- |
| `Zoo` | experimental menu-only tamagotchi topic for project pets, with lookup, stable identities, localized cards, history, and duplicate `[priv]` / `[pub]` disambiguation |
| `General` | new `/clear` command keeps the active menu and removes tracked clutter |
| Windows | native wrapper scripts for install, doctor, test, run, and Omni run; cleaner env fallback and Windows-safe path handling |
| Public surface | repo, docs, and fixtures were cleaned up so the OSS repo no longer reads like a private Atlas dump |

## Highlights

- one Telegram topic maps to one durable local session
- live follow-ups can steer into an active run
- commentary-style progress delivery instead of raw tool noise
- attachment-aware prompts, including file-first flows
- `/new Topic Name` topic creation when the bot has Telegram rights
- `/help` help cards and `/guide` beginner PDF
- topic-local and global menus through `/menu` and `/global`
- `/clear` in `General` to keep only the active menu
- queued prompts with `/q`
- compacted recovery memory rebuilt from the clean exchange log
- dedicated menu-only `Zoo` topic for project tamagotchi cards
- duplicate repo disambiguation with `[priv]` and `[pub]` in Zoo when private/public twins exist
- native Windows wrapper scripts for install, doctor, test, and run
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

# fill the required values in .env first:
# TELEGRAM_BOT_TOKEN
# TELEGRAM_ALLOWED_USER_ID
# TELEGRAM_FORUM_CHAT_ID
# WORKSPACE_ROOT
# optional: DEFAULT_SESSION_BINDING_PATH
# then validate and run

make doctor
make test
make run
```

Then in Telegram:

1. Open `General`.
2. Send `/help`.
3. Create a work topic with `/new Backend Cleanup`.
4. Optionally send `/zoo` to open the experimental Zoo topic.
5. Enter your work topic and send a plain text prompt.

If you want the exact setup flow, use [docs/setup.md](./docs/setup.md).

## What You Will Actually Use

In `General`:

- `/help` — quick help cards
- `/guide` — beginner PDF guide
- `/clear` — clear tracked clutter and keep only the active menu
- `/global` — global settings menu
- `/new Topic Name` — create a new work topic
- `/zoo` — open the dedicated Zoo topic

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

## Native Windows

Native Windows is now a first-class path. Prefer it over WSL unless you already know your WSL networking and file-path setup are healthy.

```powershell
copy .env.example .env
scripts\windows\install.cmd
scripts\windows\install-codex.cmd
scripts\windows\doctor.cmd
scripts\windows\test.cmd
scripts\windows\run.cmd
```

If you enable `Omni`, run `scripts\windows\run-omni.cmd` in a second shell. The Windows wrappers call `npm.cmd` directly and avoid the usual PowerShell `npm` friction.

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

Minimal practical example:

```env
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_ALLOWED_USER_ID=123456789
TELEGRAM_FORUM_CHAT_ID=-1001234567890
WORKSPACE_ROOT=/home/you/work
DEFAULT_SESSION_BINDING_PATH=/home/you/work/main-repo
```

The first four values are the real minimum. `DEFAULT_SESSION_BINDING_PATH` is optional and only controls where plain `/new Topic Name` starts when you do not pass `cwd=...`.

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

- direct CLI usage prefers `${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env` on Linux/macOS and `%LOCALAPPDATA%\\codex-telegram-gateway\\runtime.env` on native Windows
- if that external env file does not exist yet, the runtime falls back to repo-local `.env`
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
| understand the experimental Zoo / tamagotchi topic | [docs/zoo-concept.md](./docs/zoo-concept.md) |
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
