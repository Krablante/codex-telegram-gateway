# codex-telegram-gateway

Personal Telegram gateway for the real local `codex` runtime.

This repo keeps the surface small:

- one Telegram topic = one session
- `Spike` is the main worker bot
- optional `Omni` is the second bot for `/auto`
- `Zoo` is a dedicated control-only topic for per-project tamagotchi snapshots
- state lives under `atlas/state/...`, not in the repo
- code shape is modular-first: thin routers, domain handlers, focused test ownership

## Code Direction

The repo has now moved to an explicit modular handler system and should stay that way.

- keep central shells such as `command-router.js` thin
- add new Telegram behavior in domain handlers under `src/telegram/command-handlers/`
- split tests by the same ownership instead of regrowing giant central suites
- prefer small shared helper modules only when multiple handlers truly share one contract

## Canonical paths

- repo root: `/home/bloob/atlas/homelab/infra/automation/codex-telegram-gateway`
- state root: `/home/bloob/atlas/state/homelab/infra/automation/codex-telegram-gateway`
- runtime env: `/home/bloob/atlas/state/homelab/infra/automation/codex-telegram-gateway/runtime.env`

## Read This Next

- [docs/index.md](./docs/index.md) — doc map
- [docs/architecture.md](./docs/architecture.md) — runtime shape and flow
- [docs/telegram-surface.md](./docs/telegram-surface.md) — commands, waits, suffixes, rendering, file delivery
- [docs/omni-auto.md](./docs/omni-auto.md) — `/auto`, `Omni`, phases, sleep, blockers
- [docs/deployment.md](./docs/deployment.md) — env, services, Spike-only vs Spike+Omni deployment
- [docs/testing.md](./docs/testing.md) — doctor, smoke, soak, live-user testing
- [docs/runbook.md](./docs/runbook.md) and [docs/runbook-rus.md](./docs/runbook-rus.md) — operator troubleshooting and recovery
- [docs/state-contract.md](./docs/state-contract.md) — mutable state surfaces

## Quick Start

Atlas/Linux:

```bash
cd /home/bloob/atlas/homelab/infra/automation/codex-telegram-gateway
make config
make doctor
make run
```

First-time minimum in the runtime env:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID` or `TELEGRAM_ALLOWED_USER_IDS`
- `TELEGRAM_FORUM_CHAT_ID`
- `WORKSPACE_ROOT`
- optional `DEFAULT_SESSION_BINDING_PATH`
- optional `CODEX_LIMITS_COMMAND` or `CODEX_LIMITS_SESSIONS_ROOT` when limits should come from another Codex host

`DEFAULT_SESSION_BINDING_PATH` only changes where plain `/new Topic Name` starts when no explicit `cwd=...` is provided. If it is unset, ordinary `/new` falls back to `WORKSPACE_ROOT`.
If the explicit binding path contains spaces, quote it, for example `/new cwd="C:/Users/Konstantin/Source Repos" Audit topic`.

`/limits` is available as a direct command, is folded into `/status`, and is shown on the root `/global` and `/menu` panels. Capped accounts show the current `5h` and `7d` windows; unlimited accounts are rendered explicitly as unlimited.
`CODEX_LIMITS_COMMAND` now runs without an implicit shell. Prefer a JSON argv array such as `["python3","/opt/read-limits.py"]`; simple argv-only strings like `python3 /opt/read-limits.py` still work for compatibility. If you need pipes, redirection, or inline env assignments, use a wrapper script or make the shell explicit in argv.
When `CODEX_LIMITS_COMMAND` is used, set the optional JSON `source` field to the short label you want surfaced in Telegram; otherwise the bot falls back to the generic `command` label instead of echoing the raw shell command.

The bot should be an admin in the forum chat. Topic creation and cleanup flows work best when it can post, edit, delete, pin, and manage topics.

`/menu` also accepts the Telegram-style `/<command>@YourBot` form, shows an in-menu `Status` screen, and recreates the pinned topic panel cleanly when you reopen it so old menu messages and transient pin notices do not pile up.
If a topic already has a live Spike run, plain follow-up text is steered into that same run as many times as needed. If live steer hits a short transient failure, the gateway retries briefly before falling back to the next prompt queue; use `/q` only when you explicitly mean "run this next after the current one".

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

On native Windows, when `ENV_FILE` is unset the repo first uses `%LOCALAPPDATA%\codex-telegram-gateway\runtime.env` if it already exists, then falls back to repo-local `.env`, and otherwise uses that default state path. Runtime state lives under `%LOCALAPPDATA%\codex-telegram-gateway` by default. The `scripts\windows\*.cmd` wrappers avoid the common PowerShell `npm.ps1` execution-policy trap and keep installs on the reproducible `npm ci --ignore-scripts` path.
The repo now ships a real `.env.example`, so the `copy .env.example .env` bootstrap path is not a doc-only placeholder anymore. `CODEX_BIN_PATH` is intentionally left empty there so native Windows can fall through to `codex.cmd`; if you override it manually, prefer `codex.cmd` or an absolute `...\codex.cmd` path.

Install the Codex CLI once before the first run:

```powershell
scripts\windows\install-codex.cmd
```

`make`, `systemd`, and `service-install` remain Linux-only.

With Omni enabled on Linux/operator path:

```bash
cd /home/bloob/atlas/homelab/infra/automation/codex-telegram-gateway
make run
make run-omni
```

With Omni enabled on native Windows:

```powershell
scripts\windows\run.cmd
scripts\windows\run-omni.cmd
```

## Baseline Commands

Linux/operator path:

```bash
make doctor
make test
make run
make run-omni
make service-install
make service-install-omni
make service-status
make service-status-omni
make service-rollout
make service-restart
make service-restart-private
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

Live user-account bootstrap:

```bash
make user-login
make user-status
```

Windows-native equivalent:

```powershell
scripts\windows\user-login.cmd
scripts\windows\user-status.cmd
scripts\windows\user-e2e.cmd
```

## Notes

- `Spike` stays the only heavy live worker; `Omni` uses short one-shot `codex exec` passes
- if `OMNI_ENABLED=false`, the gateway behaves like a clean single-bot deployment
- native Windows now supports direct `.env`-based startup without atlas paths or WSL-only assumptions; `WORKSPACE_ROOT` is preferred, `ATLAS_WORKSPACE_ROOT` stays as a compatibility alias
- Windows wrappers intentionally use `npm ci --ignore-scripts`; this repo does not need package install scripts, and skipping them avoids flaky transitive `postinstall` failures on some Windows setups
- `make user-login` and `scripts\windows\user-login.cmd` now use a small built-in Node terminal prompt layer; the old `input`/`inquirer`/`lodash` stack is no longer in the production dependency graph
- `service-install` is intentionally Linux-only here because it targets `systemd --user`; it resolves `CODEX_BIN_PATH` without invoking a shell, preserves the installing shell `PATH` inside the user unit so repo-local helpers and user shims stay reachable, and Spike requires `systemd >= 250` for `ExitType=cgroup`
- on Linux, `make service-rollout` and `make service-restart` are the soft rollout path for Spike: the command waits until the replacement generation has actually taken leader traffic, while already active run topics keep finishing on the retiring generation; use `make service-hard-restart` only when you really want a blind restart
- `make service-restart-private` is the canonical “restart the private bot” path: it restarts `Omni` and then rolls `Spike` through the safe session-aware rollout flow
- Windows process-tree shutdown now uses `taskkill /t` fallback instead of assuming POSIX-only negative-pid signaling, so interrupted Codex runs are less likely to leave orphaned child processes behind
- local loopback IPC now retries blocked or reserved loopback ports on native Windows instead of failing the forwarding server on the first bind error
- Telegram replies are rendered through a Telegram-safe HTML normalizer; headings, standard and expandable quotes, code, links, and readable nested lists are preserved
- final Spike replies now retry transient Telegram/network send failures beyond plain `retry after`, and if the final send still never comes back the gateway keeps the answer visible in the existing progress bubble instead of dropping it completely
- local file refs stay human-readable in chat instead of leaking long host paths
- non-git workspace bindings stay valid for normal runs, and `/diff` now answers inline that the binding is not a git repo instead of poisoning the poll cycle
- `General` now has `/clear`, which is bot-triggered and bot-tracked: it preserves the active global menu and removes the tracked General clutter without needing a user-session backend
- the root `/global` menu in `General` now stacks `Bot Settings` / `Language` first, then `Guide` / `Help`, with `Wait` / `Suffix` and `Zoo` / `Clear` below
- `General -> Bot Settings` also carries a separate global model/reasoning pair for the temporary `/compact` summarizer, so brief rebuilds do not have to reuse the live worker profile
- Zoo is menu-only in normal operation, keeps buttons in English, localizes the card text to the topic language, assigns each new pet a stable random identity from the unused creature and temperament pools when possible, shows a creature-role header above the card, keeps the pet card gently animating while that pet screen stays open, paginates the root list, shifts refresh text from a generic first-frame status into temperament-driven ASCII pose swaps, shows previous-vs-current trend arrows in the stat block, keeps lower detail text inside an expandable quote, and normalizes duplicate repo names to path-derived labels with `[priv]` or `[pub]` suffixes when private/public twins exist
- if `zoo/topic.json` is lost, incomplete, or quarantined, the next live Zoo menu callback now rebuilds the stored chat/topic/menu binding instead of degrading into silent `zoo:` button no-ops
