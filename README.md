<p align="center">
  <img src="./assets/readme/codex-telegram-gateway-banner.svg" alt="codex-telegram-gateway banner">
</p>

<h1 align="center">codex-telegram-gateway</h1>

<p align="center">
  <strong>Turn a Telegram forum into a practical control surface for your local Codex runtime.</strong>
</p>

<p align="center">
  One topic = one session. <code>Spike</code> does the live work. <code>Omni</code> optionally supervises <code>/auto</code>. <code>Zoo</code> adds an experimental project-tamagotchi lane.
</p>

<p align="center">
  <a href="https://github.com/Krablante/codex-telegram-gateway/releases">
    <img src="https://img.shields.io/github/v/release/Krablante/codex-telegram-gateway?style=for-the-badge" alt="GitHub release">
  </a>
  <a href="https://github.com/Krablante/codex-telegram-gateway/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/Krablante/codex-telegram-gateway/ci.yml?branch=main&style=for-the-badge" alt="CI status">
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

It is designed for operators who want something small, understandable, and durable:

- one task, one topic, one durable local session
- commentary-style progress instead of raw tool spam
- real local files and commands, not a hosted wrapper
- recovery that survives long-running work
- optional autonomy through `Omni`, without turning the project into a general agent platform
- one dedicated `Zoo` topic for experimental project cards

## Why People Use It

- Telegram is already open all day.
- A forum topic is a natural task lane.
- The local machine already has the real Codex CLI, repo access, and auth.
- The operator wants one practical system instead of a large orchestration stack.

## What's New In v0.3.0

| Area | What changed |
| --- | --- |
| Service rollout | `Spike` now supports soft, session-aware rollout and restart. Active work can finish on the retiring generation while new traffic moves only after the replacement is proven live. |
| Runtime hardening | Generation identity checks, update-forwarding IPC, PATH resolution, `.cmd` shim behavior, and Windows process-tree shutdown were tightened for real cross-platform operation. |
| Architecture | Telegram command handling, worker-pool logic, Omni coordination, and Zoo flows were split into thinner modules with matching test ownership. |
| Operator tooling | Public repo now ships `runbook:build`, `scripts/windows/admin.cmd`, `scripts/windows/user-e2e.cmd`, and refreshed runbook coverage. |
| Public release surface | Docs, changelog, tests, and CI are now aligned with the current private implementation instead of the older `0.2.2.2` snapshot. |

## Highlights

- one Telegram topic maps to one durable local session
- live follow-ups can steer into an active run
- queued prompts with `/q` and buffered prompts with `/wait`
- topic-local and global prompt suffixes with `/suffix`
- topic-local and global menus through `/menu` and `/global`
- `/limits` plus limits summaries in status and menus
- compacted recovery memory rebuilt from the clean exchange log
- optional `Omni` bot with goal-locked `/auto`
- native Windows wrapper scripts for install, doctor, test, run, admin, and live-user helpers
- GitHub Actions CI for Ubuntu and native Windows runners
- dedicated menu-only `Zoo` topic for project cards with duplicate private/public repo disambiguation

## Mental Model

| Piece | Role |
| --- | --- |
| `General` topic | global controls, `/guide`, `/help`, `/global`, `/clear`, creating new work topics |
| `Zoo` topic | dedicated menu-only project lane |
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
│  └─ menu-only project cards
└─ Work topics
   ├─ plain prompts -> Spike
   ├─ /q, /wait, /suffix, /compact, /purge
   └─ /auto -> Omni supervises, Spike still does the heavy work

Telegram surface -> codex-telegram-gateway -> local codex CLI -> local repos/files/state
```

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
# TELEGRAM_ALLOWED_USER_ID or TELEGRAM_ALLOWED_USER_IDS
# TELEGRAM_FORUM_CHAT_ID
# WORKSPACE_ROOT
# optional: DEFAULT_SESSION_BINDING_PATH

make doctor
make test
make run
```

The actual minimum is `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID` or `TELEGRAM_ALLOWED_USER_IDS`, `TELEGRAM_FORUM_CHAT_ID`, and `WORKSPACE_ROOT`.

Make the bot an admin in the forum chat. The cleanest experience is with rights to post, edit, delete, pin, and manage topics.

Then in Telegram:

1. Open `General`.
2. Send `/help`.
3. Create a work topic with `/new Backend Cleanup`.
4. Optionally send `/zoo` to open the experimental Zoo topic.
5. Enter your work topic and send a plain text prompt.

If you want the exact first-time setup flow, use [docs/setup.md](./docs/setup.md).

## Native Windows

Native Windows is a first-class path.

```powershell
copy .env.example .env
scripts\windows\install.cmd
scripts\windows\install-codex.cmd
scripts\windows\doctor.cmd
scripts\windows\test.cmd
scripts\windows\run.cmd
```

If you enable `Omni`, run `scripts\windows\run-omni.cmd` in a second shell.

When `ENV_FILE` is unset, the repo first uses `%LOCALAPPDATA%\codex-telegram-gateway\runtime.env` if it already exists, then falls back to repo-local `.env`, and otherwise uses that default config path. Runtime state lives under `%LOCALAPPDATA%\codex-telegram-gateway` by default.

The Windows wrappers intentionally call `npm.cmd` directly, avoid the common PowerShell execution-policy trap, and stay on the reproducible `npm ci --ignore-scripts` path.

## Deployment Modes

### Spike-only

The recommended starting point.

Leave `OMNI_BOT_TOKEN` and `OMNI_BOT_ID` unset, or set `OMNI_ENABLED=false`.

Use this if:

- you want the smallest possible setup
- you mainly want direct interactive work
- you do not want `/auto` consuming extra tokens

### Spike + Omni

Add `OMNI_BOT_TOKEN` and `OMNI_BOT_ID` to enable `/auto`.

In this mode:

- `Spike` still does the heavy live work
- `Omni` evaluates completed cycles and decides whether to continue, sleep, pivot, block, or finish
- human direct prompts stop going to `Spike` while `/auto` owns that topic

## Operator Commands

Linux/operator path:

```bash
make doctor
make test
make run
make run-omni
make service-install
make service-install-omni
make service-rollout
make service-restart
make service-hard-restart
make admin ARGS='status'
```

Windows-native path:

```powershell
scripts\windows\doctor.cmd
scripts\windows\test.cmd
scripts\windows\run.cmd
scripts\windows\run-omni.cmd
scripts\windows\admin.cmd status
```

## Notes

- `Spike` stays the only heavy live worker; `Omni` uses short one-shot `codex exec` passes
- `service-install` is intentionally Linux-only because it targets `systemd --user`
- `make service-rollout` and `make service-restart` are the soft rollout path for `Spike`; use `make service-hard-restart` only when you want a blind restart
- native Windows now supports direct `.env`-based startup without Linux-only assumptions; `WORKSPACE_ROOT` is preferred and `ATLAS_WORKSPACE_ROOT` remains a compatibility alias
- `make user-login` and `scripts\windows\user-login.cmd` now use a small built-in Node terminal prompt layer instead of the older `input` stack
- local file refs stay human-readable in chat instead of leaking long host paths

## Docs

- [docs/setup.md](./docs/setup.md) — first-time setup
- [docs/index.md](./docs/index.md) — doc map
- [docs/architecture.md](./docs/architecture.md) — runtime shape and flow
- [docs/telegram-surface.md](./docs/telegram-surface.md) — commands, waits, suffixes, rendering, file delivery
- [docs/omni-auto.md](./docs/omni-auto.md) — `/auto`, `Omni`, phases, sleep, blockers
- [docs/deployment.md](./docs/deployment.md) — env, services, Spike-only vs Spike+Omni deployment
- [docs/testing.md](./docs/testing.md) — automated, smoke, and live-user validation
- [docs/runbook.md](./docs/runbook.md) and [docs/runbook-rus.md](./docs/runbook-rus.md) — operator troubleshooting and recovery
- [docs/state-contract.md](./docs/state-contract.md) — mutable state surfaces
