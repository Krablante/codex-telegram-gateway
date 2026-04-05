# Codex Telegram Gateway AGENTS

Use this repo when editing the public Codex Telegram gateway.

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

## Boundaries

- do not turn this into a generic multi-provider orchestration platform
- do not add approval-flow or sandbox policy layers in this repo
- keep bot tokens and runtime secrets out of git
- keep mutable logs, sessions, indexes, and artifacts under the configured state root, not in the repo
