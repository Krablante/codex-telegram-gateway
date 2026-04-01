# Codex Telegram Gateway Architecture

## Goal

Expose the real local Codex runtime through Telegram forum topics without building a separate agent platform.

## Core model

- one Telegram topic maps to one session
- one active run per topic at a time
- one operator-only private chat acts as the emergency rescue lane
- durable topic memory lives under the configured state root
- the real execution path is `codex app-server`, not a static wrapper

## Main flow

1. `src/cli/run.js` polls Telegram updates and writes runtime heartbeat/events.
2. The poll loop gives operator private-chat messages first chance to enter `src/emergency/`, which bypasses topic/session state and can launch one isolated `codex exec` repair run.
3. `src/telegram/command-router.js` authenticates the operator, handles normal topic commands, and turns messages plus attachments into prompt input.
4. `src/session-manager/` owns topic routing, session metadata, wait-mode state, suffixes, exchange-log memory, compact brief, and topic context files.
5. `src/pty-worker/worker-pool.js` owns active topic runs, progress delivery, live steer, interrupts, and final reply delivery.
6. `src/pty-worker/codex-runner.js` launches `codex app-server`, speaks JSON-RPC over websocket, and can recover from rollout files if the live socket drops.

## Transport behavior

- a normal prompt starts a Codex turn through `app-server`
- a follow-up prompt that lands while the run is still active is sent into that same live turn through `turn/steer`
- if the websocket transport drops, the gateway can continue watching the rollout file and still wait for commentary/final output
- progress is commentary-oriented; raw tool output and transport bookkeeping are not meant to become user-facing progress text
- the emergency lane uses one-shot `codex exec`, not `app-server`, and does not depend on topic routing/session continuity
- while an emergency repair run is active, normal operator prompts in topics are blocked so the rescue path stays isolated from live topic runs

## Session memory

Canonical durable surfaces:

- `meta.json` — topic/session metadata
- `exchange-log.jsonl` — durable raw prompt/final-reply history
- `active-brief.md` — derived recovery summary
- `telegram-topic-context.md` — compact routing/file-delivery contract for Codex
- `artifacts/` — generated diffs and related outputs
- `state_root/emergency/` — isolated rescue-lane scratch space for downloaded private-chat attachments and `codex exec` output files

The gateway does not treat raw PTY output or full tool chatter as canonical memory.

## Operational boundaries

- Telegram is the only user-facing transport in this repo
- mutable state lives outside the repo under the configured state root
- file delivery is intentionally restricted to the current worktree, the session state directory, and `/tmp`
- the service is intentionally single-operator in this phase
- emergency mode is on-demand only: writing in operator private chat starts one isolated rescue run, and the lock disappears automatically when that run finishes or is interrupted
