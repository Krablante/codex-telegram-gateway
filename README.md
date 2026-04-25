<p align="center">
  <img src="./assets/readme/codex-telegram-gateway-banner.svg" alt="codex-telegram-gateway banner">
</p>

<h1 align="center">codex-telegram-gateway</h1>

<p align="center">
  <strong>Run Codex from Telegram without dragging a heavyweight agent stack into every prompt.</strong>
</p>

<p align="center">
  One topic = one session. <code>Spike</code> talks directly to <code>codex exec --json</code>. <code>Zoo</code> adds an optional project-status board.
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
  <a href="./docs/runbook.md">Runbook</a>
  ·
  <a href="./CHANGELOG.md">Changelog</a>
</p>

`codex-telegram-gateway` is a lean Telegram front end for the local Codex CLI. It keeps the normal path simple: Telegram forum topics, one bot, your local machine, and the repos/auth/tools that Codex already uses.

The current runtime is intentionally single-bot. `Spike` is the worker. The old second-bot autonomy stack has been removed from the public surface.

## Why People Use It

- one task, one topic, one durable session
- direct Telegram -> `Spike` -> `codex` flow for normal work
- less prompt overhead than heavier always-on agent stacks
- real local files and commands, not a fake hosted wrapper
- recovery that survives long-running work

## Mental Model

| Piece | Role |
| --- | --- |
| `General` topic | global controls, `/guide`, `/help`, `/global`, creating new work topics |
| work topic | the actual task lane |
| `Spike` | the live worker that reads code, edits files, runs commands, and sends progress/final replies |
| `Zoo` topic | optional menu-only project status lane |
| local state root | durable memory: sessions, briefs, logs, queued prompts, artifacts |

Architecture at a glance:

```text
Telegram forum
├─ General
│  ├─ /help
│  ├─ /guide
│  └─ /global
├─ Work topics
│  ├─ plain prompts -> Spike
│  ├─ /q, /wait, /suffix, /compact, /purge
└─ Zoo
   └─ optional menu-only project cards

Telegram surface -> codex-telegram-gateway -> codex exec --json -> local repos/files/state
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
- optional `Zoo` topic for project snapshots

## Code Direction

The repo has now moved to an explicit modular handler system and should stay that way.

- keep central shells such as `command-router.js` thin
- add new Telegram behavior in domain handlers under `src/telegram/command-handlers/`
- split tests by the same ownership instead of regrowing giant central suites
- prefer small shared helper modules only when multiple handlers truly share one contract

## Canonical paths

- repo root: wherever you cloned the repo, for example `/path/to/codex-telegram-gateway`
- state root: `${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway`
- runtime env: `${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env`

## Read This Next

- [docs/index.md](./docs/index.md) — doc map
- [docs/architecture.md](./docs/architecture.md) — runtime shape and flow
- [docs/telegram-surface.md](./docs/telegram-surface.md) — commands, waits, suffixes, rendering, file delivery
- [docs/deployment.md](./docs/deployment.md) — env, services, host bootstrap
- [docs/testing.md](./docs/testing.md) — doctor, smoke, soak, live-user testing
- [docs/runbook.md](./docs/runbook.md) and [docs/runbook-rus.md](./docs/runbook-rus.md) — operator troubleshooting and recovery
- [docs/state-contract.md](./docs/state-contract.md) — mutable state surfaces

## Quick Start

Linux/operator path:

```bash
cd /path/to/codex-telegram-gateway
npm ci
install -d -m700 "${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway"
install -m600 .env.example "${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env"
$EDITOR "${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env"
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env" make doctor
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env" make run
```

First-time minimum in the runtime env:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID` or `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_FORUM_CHAT_ID`
- `WORKSPACE_ROOT`
- optional `DEFAULT_SESSION_BINDING_PATH`
- optional `CODEX_CONFIG_PATH`
- optional `CODEX_LIMITS_COMMAND` or `CODEX_LIMITS_SESSIONS_ROOT` when limits should come from another Codex host
- optional `CURRENT_HOST_ID` and `HOST_REGISTRY_PATH` for multi-host setups

`DEFAULT_SESSION_BINDING_PATH` only changes where plain `/new Topic Name` starts when no explicit `cwd=...` is provided. If it is unset, ordinary `/new` falls back to `WORKSPACE_ROOT`.
If the explicit binding path contains spaces, quote it, for example `/new cwd="C:/Users/Example/Source Repos" Audit topic`.
Limits snapshot lookup precedence is `CODEX_LIMITS_SESSIONS_ROOT` -> `CODEX_SESSIONS_ROOT` -> `~/.codex/sessions`.

`/limits` is available as a direct command, is folded into `/status`, and is shown on the root `/global` and `/menu` panels. Capped accounts show the current `5h` and `7d` windows; unlimited accounts are rendered explicitly as unlimited.
`CODEX_LIMITS_COMMAND` now runs without an implicit shell. Prefer a JSON argv array such as `["python3","/opt/read-limits.py"]`; simple argv-only strings like `python3 /opt/read-limits.py` still work for compatibility. If you need pipes, redirection, or inline env assignments, use a wrapper script or make the shell explicit in argv.
When `CODEX_LIMITS_COMMAND` is used, set the optional JSON `source` field to the short label you want surfaced in Telegram; otherwise the bot falls back to the generic `command` label instead of echoing the raw shell command.

The bot should be an admin in the forum chat. Topic creation and cleanup flows work best when it can post, edit, delete, pin, and manage topics.

`/menu` also accepts the Telegram-style `/<command>@YourBot` form, shows an in-menu `Status` screen, and recreates the pinned topic panel cleanly when you reopen it so old menu messages do not pile up. Telegram may still keep its own pin service notice, but the gateway no longer guesses and deletes neighboring message ids.
If a topic already has a live Spike run, plain follow-up text is steered into that same run as many times as needed. If live steer hits a short transient failure, the gateway retries briefly before falling back to the next prompt queue; use `/q` only when you explicitly mean "run this next after the current one". If upstream aborts a turn, the gateway now retries that same top-level run on the stored `codex_thread_id` before it falls back to a fresh-thread rebuild; accepted live-steer images are replayed into the recovery attempt, ordinary upstream-interrupted turns still use a bounded two-retry budget, and an already completed `turn.completed` answer is kept as `completed` instead of being thrown away. Fallback app-server debugging may inspect older provider, rollout, and `thread/list` hints, but default `exec-json` continuity stays on the Codex thread id.

Native Windows:

```powershell
cd O:\workspace\codex-telegram-gateway
copy .env.example .env
scripts\windows\install.cmd
scripts\windows\install-codex.cmd
scripts\windows\doctor.cmd
scripts\windows\run.cmd
```

Use `WORKSPACE_ROOT` and `DEFAULT_SESSION_BINDING_PATH` with Windows paths such as `O:/workspace`.

On native Windows, when `ENV_FILE` is unset the repo first uses repo-local `.env`, then falls back to `%LOCALAPPDATA%\codex-telegram-gateway\runtime.env`. Runtime state also lives under `%LOCALAPPDATA%\codex-telegram-gateway` by default. If you want a specific env file, run commands as `set ENV_FILE=C:\path\to\runtime.env && ...` (or PowerShell `$env:ENV_FILE='C:\path\to\runtime.env'`). The `scripts\windows\*.cmd` wrappers avoid the common PowerShell `npm.ps1` execution-policy trap, change into the repo root before launching Node, and keep installs on the reproducible `npm ci --ignore-scripts` path.
The repo now ships a real `.env.example`, so the `copy .env.example .env` bootstrap path is not a doc-only placeholder anymore. `CODEX_BIN_PATH` is intentionally left empty there so native Windows can fall through to `codex.cmd`; if you override it manually, prefer `codex.cmd` or an absolute `...\codex.cmd` path.

Install the Codex CLI once before the first run:

```powershell
scripts\windows\install-codex.cmd
```

`make`, `systemd`, and `service-install` remain Linux-only.

## Baseline Commands

Linux/operator path:

```bash
runtime_env="${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env"
export ENV_FILE="$runtime_env"
make doctor
make check-syntax
make lint
make typecheck
make test
make test-exec
make hygiene
make test-live
make run
make user-e2e
make user-spike-audit
make service-install
make service-status
make service-rollout
make service-restart
make service-restart-live
make service-hard-restart
make admin ARGS='status'
```

Windows-native path:

```powershell
scripts\windows\doctor.cmd
scripts\windows\test.cmd
scripts\windows\test-live.cmd
scripts\windows\run.cmd
scripts\windows\admin.cmd status
```

Live user-account bootstrap:

```bash
make user-login
make user-status
make user-e2e
make user-spike-audit
```

Windows-native equivalent:

```powershell
scripts\windows\user-login.cmd
scripts\windows\user-status.cmd
scripts\windows\user-e2e.cmd
scripts\windows\user-spike-audit.cmd
```

## Notes

- `Spike` is the only live worker
- default worker turns use `codex exec --json`; `CODEX_GATEWAY_BACKEND=app-server` is legacy fallback/debug only and requires `CODEX_ENABLE_LEGACY_APP_SERVER=1`
- native Windows now supports direct `.env`-based startup without host-specific Linux paths or WSL-only assumptions; use `WORKSPACE_ROOT` when you want to pin the workspace explicitly
- Windows wrappers intentionally use `npm ci --ignore-scripts`; this repo does not need package install scripts, and skipping them avoids flaky transitive `postinstall` failures on some Windows setups
- `make user-login` and `scripts\windows\user-login.cmd` now use a small built-in Node terminal prompt layer; the old `input`/`inquirer`/`lodash` stack is no longer in the production dependency graph
- `service-install` is intentionally Linux-only here because it targets `systemd --user`; it resolves `CODEX_BIN_PATH` without invoking a shell, pins `CODEX_CONFIG_PATH` into the user unit, preserves the installing shell `PATH` inside the user unit so repo-local helpers and user shims stay reachable, and Spike requires `systemd >= 250` for `ExitType=cgroup`
- on Linux, `make service-rollout` and `make service-restart` are the soft rollout path for Spike: the command waits until the replacement generation has actually taken leader traffic, while already active run topics keep finishing on the retiring generation; use `make service-hard-restart` only when you really want a blind restart
- `make service-restart` and `make service-restart-live` use the same safe session-aware rollout flow
- while `/compact` is rebuilding the brief, direct prompt starts for that topic are blocked instead of racing a second Spike run against the fresh-start handoff
- `make test-live` and `make user-spike-audit` are the quickest deep validations for real Codex continuity and heavy user-account scenarios; native Windows now ships matching wrapper scripts for both
- `make admin ARGS='status'` now also shows heartbeat freshness, pid liveness, the configured and resolved `CODEX_BIN_PATH`, `CODEX_CONFIG_PATH`, and parsed MCP server names, so operators can confirm the live Codex profile before assuming tool loss
- `/status` now separates configured limits from the live effective rollout window when they differ, so operators can see both the intended config and the current in-flight session reality
- fallback `codex app-server` launches are still available for debugging the legacy transport, but they are no longer the default runtime path
- native resume/interrupt recovery now follows the stored `codex_thread_id` first instead of treating every transient interruption like a forced fresh start; legacy app-server fallback may still inspect provider, rollout, and `thread/list` hints while debugging that transport
- Windows process-tree shutdown now uses `taskkill /t` fallback instead of assuming POSIX-only negative-pid signaling, so interrupted Codex runs are less likely to leave orphaned child processes behind
- local loopback IPC now retries blocked or reserved loopback ports on native Windows instead of failing the forwarding server on the first bind error
- Windows runtime helpers now also normalize case-insensitive `PATH` / `PATHEXT`, reject unsafe `%` shell-routed `.cmd` arguments, sanitize reserved attachment names, and retry transient atomic-replace filesystem failures instead of surfacing brittle host-specific edge cases
- if native Windows leaves the websocket alive but the rollout already wrote `task_complete`, Spike can still finish that run from the rollout signal instead of staying stuck in `running`
- stalled disconnect recovery and early-start failures now reap orphaned live-run state instead of leaving a fake forever-running topic behind
- upstream interrupted Codex turns now surface as interrupted instead of being misreported as ordinary failures
- container-backed MCP tools such as `pitlane` and `large_file` often see the workspace through a `/workspace/...` mirror; host workspace paths need to be translated before calling those tools
- Telegram replies are rendered through a Telegram-safe HTML normalizer; headings, standard and expandable quotes, code, links, and readable nested lists are preserved
- final Spike replies now retry transient Telegram/network send failures beyond plain `retry after`, and if the final send still never comes back the gateway keeps the answer visible in the existing progress bubble instead of dropping it completely
- temporary Telegram `retry_after` throttles during ordinary reply sends are now retried inline, so the same update is not replayed just because Telegram briefly rate-limited one response
- local file refs stay human-readable in chat instead of leaking long host paths
- non-git workspace bindings stay valid for normal runs, and `/diff` now answers inline that the binding is not a git repo instead of poisoning the poll cycle
- `General` now has `/clear`, which is bot-triggered and bot-tracked: it preserves the active global menu and removes the tracked General clutter without needing a user-session backend
- `General -> Bot Settings` also carries a separate global model/reasoning pair for the temporary `/compact` summarizer, so brief rebuilds do not have to reuse the live worker profile; manual `/compact` first rebuilds `active-brief.md` with current workspace state plus still-active user rules and delivery instructions, and only then clears continuity for an intentional fresh start
- the root `/global` menu in `General` now stacks `Bot Settings` / `Language` first, then `Guide` / `Help`, with `Wait` / `Suffix` and `Zoo` / `Clear` below
- Zoo is menu-only in normal operation, keeps buttons in English, localizes the card text to the topic language, assigns each new pet a stable random identity from the unused creature and temperament pools when possible, shows a creature-role header above the card, keeps the pet card gently animating while that pet screen stays open, paginates the root list, shifts refresh text from a generic first-frame status into temperament-driven ASCII pose swaps, shows previous-vs-current trend arrows in the stat block, keeps lower detail text inside an expandable quote, and normalizes duplicate repo names to path-derived labels with `[priv]` or `[pub]` suffixes when private/public twins exist
- if `zoo/topic.json` is lost, incomplete, or quarantined, the next live Zoo menu callback now rebuilds the stored chat/topic/menu binding instead of degrading into silent `zoo:` button no-ops
