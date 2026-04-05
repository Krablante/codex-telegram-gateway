# Codex Telegram Gateway AGENTS

Use this repo when editing the public Codex Telegram gateway.

Motto: avoid overengineering; prioritize efficient, modular systems, security, high autonomy, and ease of operation and use.

## What this repo is

- public single-operator Telegram gateway for the local `codex` runtime
- one Telegram topic maps to one session
- reference implementation, not a multi-provider agent platform

## Architecture

- `transport/` responsibility stays Telegram-specific
- `session-manager/` owns routing, lifecycle, and persistence
- `pty-worker/` owns the Codex `app-server` transport, live steer, rollout recovery, and worker lifecycle
- `telegram/command-handlers/` owns domain-specific command behavior; keep central routers thin
- `emergency/` owns the operator-only private-chat fallback built on isolated `codex exec`
- `rollout/` owns session-aware Spike handoff checks for soft service restarts

## Default paths

- repo root: wherever the repo is cloned
- default CLI env file: `${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env`
- default `make` env file: `.env`
- default state root: `${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway`
- compatibility alias: `ATLAS_WORKSPACE_ROOT` is still accepted for `WORKSPACE_ROOT`

## Run and validate

- prefer repo entry points
- `make doctor`
- `make admin ARGS='status'`
- `make run`
- `make smoke`
- `make soak`
- `make service-install`
- `make service-rollout`
- `make test-live`
- `make test`

## Workflow

- this repo follows a private-first workflow
- changes should land and be validated in the private repo first, then be mirrored here once they are safe to publish
- when a fix or UX change exists in both repos, keep tests, docs, changelog, and release state aligned with the private source of truth

## Boundaries

- do not turn this into a generic multi-provider orchestration platform
- do not add approval-flow or sandbox policy layers in this repo
- keep bot tokens and runtime secrets out of git
- keep mutable logs, sessions, indexes, and artifacts under the configured state root, not in the repo

## Atlas reminder

- root `atlas/AGENTS.md` is the main workspace contract; keep its global rules, navigation order, and precedence in mind even when working in this scope
- `atlas/_context/README.md` is the one-file fast-start for shared workspace context; open deeper `_context/*` modules only when the task clearly needs them
