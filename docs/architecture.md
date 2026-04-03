# Codex Telegram Gateway Architecture

## Goal

Expose the real local Codex runtime through Telegram forum topics without building a separate platform around it.

## Core Model

- one Telegram topic maps to one session
- one active run per topic at a time
- one operator-only private chat acts as the emergency rescue lane
- optional `/auto` adds a second trusted bot, `Omni`, in the same topic; `Spike` executes and `Omni` orchestrates
- if Omni is disabled globally, Spike falls back to a plain single-bot surface and ignores stale topic auto locks
- durable state lives under the configured state root, not inside the repo
- the real execution path is `codex app-server`, not a fake prompt wrapper

## Main Flow

1. `src/cli/run.js` polls Telegram updates and writes runtime heartbeat/events.
2. The poll loop gives operator private-chat messages first chance to enter `src/emergency/`, which can launch one isolated `codex exec` repair run.
3. `src/telegram/command-router.js` authenticates the configured operator, handles topic commands, and turns plain messages plus attachments into prompt input.
4. `src/session-manager/` resolves the topic session, workspace binding, suffixes, wait-mode state, queue state, exchange log, compact brief, and topic context file.
5. `src/pty-worker/worker-pool.js` owns active topic runs, progress messages, typing heartbeats, live steer, interrupts, and final delivery.
6. `src/pty-worker/codex-runner.js` launches `codex app-server`, connects over websocket JSON-RPC, starts turns, and tracks rollout files for recovery.
7. `src/cli/run-omni.js` plus `src/omni/` optionally run a second Telegram bot that owns `/auto`, records the goal, forwards prompts to Spike, and wakes only when Spike appends a final-event checkpoint for a completed run.

## Transport Behavior

- a normal prompt starts a Codex turn through `app-server`
- a follow-up prompt that lands while the run is still active is sent into that same live turn through `turn/steer`
- if the websocket transport drops, the gateway can keep watching the rollout file and still recover final output
- progress is commentary-oriented; raw tool chatter is not meant to become operator-facing status text
- the emergency lane uses one-shot `codex exec`, not `app-server`, and does not depend on topic/session continuity
- Omni also uses short one-shot `codex exec` evaluations instead of a second live `app-server` stack; Spike remains the only heavy live worker
- when `OMNI_ENABLED=false`, the Omni runtime may stay stopped, or idle if its user service is still installed

## Session Memory

Canonical durable surfaces:

- `meta.json` — topic/session metadata
- `meta.json:auto_mode` — topic-scoped Omni/Spike lock and autonomy state
- `exchange-log.jsonl` — durable raw prompt/final-reply history
- `active-brief.md` — derived recovery summary for the next fresh run
- `telegram-topic-context.md` — compact routing/file-delivery contract for Codex
- `artifacts/` — generated diffs and related outputs
- `state/.../emergency/` — isolated rescue-lane scratch space for private-chat attachments and `codex exec` output files
- `state/.../omni/runs/` — one-shot `codex exec` outputs for Omni decisions

## Operational Boundaries

- Telegram remains the only user-facing transport in this repo
- service state lives under the configured state root, not inside the repo
- file delivery is restricted to the current worktree, the session state directory, and `/tmp`
- the service is intentionally single-operator in this phase
- emergency mode is on-demand only: writing in operator private chat starts one isolated rescue run, and the lock disappears automatically when that run finishes or is interrupted
- in an active `/auto` topic, direct human prompts stop at Omni; Spike accepts prompt-starts there only from trusted Omni bot senders
- if Omni is disabled at the deployment level, those topic-scoped `auto_mode` locks become inert until Omni is re-enabled
