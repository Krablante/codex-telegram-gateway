<p align="center">
  <img src="./assets/readme/codex-telegram-gateway-banner.svg" alt="codex-telegram-gateway banner">
</p>

<h1 align="center">codex-telegram-gateway</h1>

<p align="center">
  <strong>Turn a Telegram forum into a durable control surface for the real Codex CLI on your own machine.</strong>
</p>

<p align="center">
  One topic = one session. <code>Spike</code> does the live work. <code>Omni</code> optionally supervises <code>/auto</code>. <code>Zoo</code> adds an experimental project-card lane.
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

`codex-telegram-gateway` is a practical bridge between Telegram forum topics and a machine where `codex` is already installed, authenticated, and allowed to touch real repos, files, and tools.

This repo is for people who want something direct:

- one work topic maps to one durable local session
- the real Codex CLI does the work, not a hosted proxy
- follow-up prompts can steer into a still-running task
- progress stays readable instead of turning chat into tool spam
- recovery, compaction, queues, waits, and suffixes are built in
- Linux and native Windows are both first-class paths

## Why this exists

Telegram is already open all day. A forum topic is a natural task lane. Codex already lives on the operator machine. The missing piece is a small, durable gateway that turns those three facts into one usable system.

This project deliberately stays focused:

- it is not a hosted Codex wrapper
- it is not a generic Telegram bot framework
- it is not a multi-tenant orchestration platform
- it is a tight operator-facing bridge for personal or small-team use

## What you get

| Piece | Role |
| --- | --- |
| `General` topic | global controls, `/help`, `/guide`, `/global`, `/clear`, and new-topic creation |
| work topic | the actual task lane |
| `Spike` | the main worker bot that reads code, edits files, runs commands, and streams progress |
| `Omni` | optional second bot for goal-locked `/auto` supervision |
| `Zoo` | optional menu-only topic with experimental project cards |
| local state root | durable sessions, briefs, exchange logs, artifacts, queue state, and rollout metadata |

Core capabilities:

- plain prompts start durable local sessions
- live follow-ups steer into active runs, with a short retry before queue fallback
- `/q` queues prompts when you want batching instead of interruption
- `/wait` buffers fragmented Telegram input into one prompt
- `/suffix` adds persistent prompt tails per topic or globally
- `/menu` and `/global` expose control panels instead of command memorization
- the root `/global` menu in `General` now stacks `Bot Settings` / `Language` first, then `Guide` / `Help`, with `Wait` / `Suffix` and `Zoo` / `Clear` below
- `/compact` rebuilds concise continuity from clean state
- `/limits` surfaces Codex limits in chat
- session-aware `Spike` rollout avoids blind restarts by default

## Recent public wave

| Area | What changed |
| --- | --- |
| Live follow-ups | Active-topic follow-up prompts now retry short transient `steer` failures before falling back to the next prompt queue. |
| Runtime shell | The Spike poll/runtime shell is split into focused slices for bootstrap, update processing, background jobs, run-once maintenance, and rollout control. |
| Session storage | `SessionStore` now keeps a thin public facade while lifecycle, file IO, meta shaping, and raw reads stay in separate modules. |
| Cross-platform behavior | `RUN_ONCE` / smoke paths no longer start background timers, keeping one-shot maintenance deterministic on Linux and Windows. |
| Public parity | The public tree stays aligned with the current private implementation wave while preserving public-safe paths, docs, and GitHub release metadata. |

## How it works

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

The important mental model is simple: Telegram is only the surface. The actual work happens locally, against your real filesystem, your real repos, and your real `codex` runtime.

## Quick start

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
```

Fill at least:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID` or `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_FORUM_CHAT_ID`
- `WORKSPACE_ROOT`
- optional: `DEFAULT_SESSION_BINDING_PATH`

Then run:

```bash
make doctor
make test
make run
```

Make the bot an admin in the forum chat. The smooth path is with rights to post, edit, delete, pin, and manage topics.

In Telegram:

1. Open `General`.
2. Send `/help`.
3. Create a work topic with `/new Backend Cleanup`.
4. Enter that topic and send a plain text prompt.
5. Optionally open `/zoo` or enable `Omni` later.

If you want the exact first-time setup path, start with [docs/setup.md](./docs/setup.md).

## Deployment lanes

### Spike-only

The recommended default.

Leave `OMNI_BOT_TOKEN` and `OMNI_BOT_ID` unset, or set `OMNI_ENABLED=false`.

Use this if:

- you want the smallest possible setup
- you mainly want direct interactive work
- you do not want `/auto` consuming extra tokens

### Spike + Omni

Add `OMNI_BOT_TOKEN` and `OMNI_BOT_ID` to enable `/auto`.

In this mode:

- `Spike` still does the heavy live work
- `Omni` evaluates finished cycles and decides whether to continue, sleep, pivot, block, or finish
- direct human prompts stop going to `Spike` while `/auto` owns that topic

### Native Windows

Native Windows is supported directly.

```powershell
copy .env.example .env
scripts\windows\install.cmd
scripts\windows\install-codex.cmd
scripts\windows\doctor.cmd
scripts\windows\test.cmd
scripts\windows\run.cmd
```

If `Omni` is enabled, run `scripts\windows\run-omni.cmd` in a second shell.

Notes:

- Windows wrappers call `npm.cmd` directly and avoid common PowerShell execution-policy traps
- repo-local `.env` works out of the box; leave `CODEX_BIN_PATH` empty to use `codex` on Linux and `codex.cmd` on native Windows
- if you override `CODEX_BIN_PATH` on Windows, prefer `codex.cmd` or an absolute `...\codex.cmd` path
- runtime state defaults to `%LOCALAPPDATA%\codex-telegram-gateway`
- Linux-only `systemd --user` service install is intentionally replaced with Windows-native wrapper scripts

## Operator commands

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
make service-restart-omni
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

Operational notes:

- `make service-rollout` and `make service-restart` are the soft default path for `Spike`
- `make service-hard-restart` is the explicit blind restart path
- `make service-restart-omni` is the direct restart path for `Omni`
- `service-install` is Linux-only because it targets `systemd --user`

## Good fit if...

- you already use Telegram as your lightweight operator console
- you want one topic per task instead of one giant agent thread
- you care about readable progress, durable state, and clean restart behavior
- you want the real Codex CLI working against local repos, not a separate hosted abstraction

## Docs map

| Doc | Why you care |
| --- | --- |
| [docs/setup.md](./docs/setup.md) | first-time installation and onboarding |
| [docs/index.md](./docs/index.md) | full doc map |
| [docs/architecture.md](./docs/architecture.md) | runtime shape, module boundaries, and flow |
| [docs/telegram-surface.md](./docs/telegram-surface.md) | commands, waits, suffixes, menus, rendering, file delivery |
| [docs/omni-auto.md](./docs/omni-auto.md) | `/auto`, `Omni`, phases, sleep, blockers, direct questions |
| [docs/deployment.md](./docs/deployment.md) | env model, services, Spike-only vs Spike+Omni deployment |
| [docs/testing.md](./docs/testing.md) | automated, smoke, and live-user validation |
| [docs/runbook.md](./docs/runbook.md) | operator troubleshooting and recovery |
| [docs/runbook-rus.md](./docs/runbook-rus.md) | Russian runbook |
| [docs/state-contract.md](./docs/state-contract.md) | mutable state surfaces under the configured state root |

## Validation

The public repo is validated with:

- `npm test`
- guidebook PDF smoke build
- runbook PDF smoke build
- GitHub Actions on `ubuntu-latest`
- GitHub Actions on `windows-latest`

## License

MIT. See [LICENSE](./LICENSE).
