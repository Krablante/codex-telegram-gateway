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
- native resume/recovery now follows real Codex history surfaces first: `thread/list`, `provider_session_id`, rollout path, and `session_key` before any compact fallback
- compact briefs are expected to preserve still-active user-specific rules and delivery instructions from the exchange log without inventing fake placeholders
- while `/compact` is rebuilding the brief, direct prompt starts for that topic should stay blocked instead of racing a second run against the fresh start
- `telegram/command-handlers/` owns domain-specific command behavior; keep central routers thin
- `emergency/` owns the operator-only private-chat fallback built on isolated `codex exec`
- `rollout/` owns session-aware Spike handoff checks for soft service restarts

## Default paths

- repo root: wherever the repo is cloned
- default CLI env file: `${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env`
- default `make` env file: `.env`
- default state root: `${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway`
- a legacy compatibility alias is still accepted for `WORKSPACE_ROOT`

## Run and validate

- prefer repo entry points
- `make doctor`
- `make admin ARGS='status'`
- `make run`
- `make smoke`
- `make soak`
- `make user-e2e`
- `make user-spike-audit`
- `make service-install`
- `make service-rollout`
- `make service-restart-live`
- `make test-live`
- `make test`

## Operator preferences

- for “restart the live bot”, use `make service-restart-live`; it restarts `Omni` and rolls `Spike` softly
- never use raw `systemctl restart codex-telegram-gateway.service` for ordinary live updates; that is the blind hard-restart path and can cut an active run
- `make admin ARGS='status'` is also the fastest operator check for the resolved `CODEX_BIN_PATH`, `CODEX_CONFIG_PATH`, and parsed MCP server list before assuming `pitlane` is broken

## Agent Prompt Guidance

- prompt surfaces here should explicitly allow the runtime to use any available tools, MCP, and GPT-5.4 subagents when that materially helps
- prefer `pitlane` for codebase navigation, symbol lookup, usages, callers/callees, and execution-path tracing before broad file reads
- prefer `tavily` for fresh web search/research, `context7` for current library docs, and `requests` for direct HTTP/API fetches
- for container-backed MCP tools like `pitlane` and `large_file`, teach Codex the host-to-container workspace mirror when your deploy uses one, for example `/host/workspace/...` on the host becoming `/workspace/...` inside the tool
- keep tool use targeted; do not tell Codex to read large parts of the repo or the web blindly when a narrower MCP call will do
- keep prompt guidance concise and practical instead of bloated

## Boundaries

- do not turn this into a generic multi-provider orchestration platform
- do not add approval-flow or sandbox policy layers in this repo
- keep bot tokens and runtime secrets out of git
- keep mutable logs, sessions, indexes, and artifacts under the configured state root, not in the repo
