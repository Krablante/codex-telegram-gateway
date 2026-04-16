# Codex Telegram Gateway Architecture

## Goal

Expose the real local Codex runtime through Telegram forum topics without building a separate agent platform.

## Core model

- one Telegram topic maps to one session
- one active run per topic at a time
- one operator-only private chat acts as the emergency rescue lane
- optional `/auto` adds a second trusted bot, `Omni`, in the same topic; Spike executes and Omni orchestrates
- if Omni is disabled globally, Spike falls back to a plain single-bot surface and ignores stale topic auto locks
- the gateway keeps durable topic memory under `state/.../sessions/<chat>/<topic>/`
- the real model execution path is `codex app-server`, not a fake wrapper around static prompts

## Main flow

1. `src/cli/run.js` polls Telegram updates and writes runtime heartbeat/events.
   - the main poller now keeps button/callback responsiveness ahead of background maintenance: prompt-handoff scans stay on timers, retention sweep runs on its own timer, Codex limits are warmed once at startup instead of first being fetched on a button press, and callback batches are acknowledged immediately before the heavier serialized update handling continues
   - the Spike runtime now also supports session-aware generation handoff: exactly one generation owns Telegram intake, active run topics stay pinned to their current generation, and a new generation can take idle/new topics immediately during rollout by forwarding retained-topic updates over local loopback IPC
   - `src/cli/run-runtime-context.js` owns bootstrap-time runtime wiring, service construction, and store/layout setup
   - `src/cli/run-update-processing.js` owns bootstrap offset discovery, long-poll readiness cleanup, and the forwarded-vs-local Telegram update processing path
   - `src/cli/run-stale-run-recovery.js` owns startup cleanup for stale `running` sessions whose recorded owner generation is no longer verifiably live, clears stale thread/rollout resume state so the next prompt starts cleanly, and emits a synthetic failed-final signal so Omni can recover `/auto` topics after a Spike restart
   - `src/cli/run-background-jobs.js` owns heartbeats, queued-prompt scans, and retention sweep timers
   - `src/cli/run-maintenance.js` owns the explicit one-shot maintenance path so `RUN_ONCE`/smoke mode does not depend on background timer races
   - `src/cli/run-rollout-controller.js` owns rollout request/reconcile/retire control flow so the composition root stays focused on lifecycle orchestration instead of rollout detail
2. The poll loop gives operator private-chat messages first chance to enter `src/emergency/`, which bypasses topic/session state and can launch one isolated `codex exec` repair run.
3. `src/telegram/command-router.js` is the thin Telegram shell: it authenticates the configured operator, classifies message type, applies high-level policy, and dispatches into domain handlers.
4. `src/telegram/command-handlers/` keeps the heavier command domains split by responsibility:
   - `prompt-flow.js` is the thin public facade for prompt-ingress behavior
   - `prompt-flow-common.js` owns shared prompt/queue text builders and pure prompt-shaping helpers
   - `prompt-flow-starts.js` owns direct prompt starts, busy-to-steer delivery, and buffered prompt flush entrypoints
   - `prompt-flow-queue.js` owns `/q` queue flow, queue buffering, queue attachment carry-over, and queue delivery text
   - `prompt-flow-routing.js` owns prompt ingress pre-routing, `/q` command routing, Omni-disabled `/omni` feedback, and topic wait-window bridging
   - `surface-commands.js` is the thin dispatcher for the text command surface
   - `surface-reference-commands.js` owns `/help`, `/guide`, and suffix-help delivery
   - `surface-settings-commands.js` owns `/status`, `/limits`, `/language`, `/wait`, `/suffix`, `/interrupt`, and runtime-setting surface flows
   - `surface-command-common.js` owns the shared finalize/delivery helpers used by the surface handlers
   - `runtime-settings.js` owns `/model`, `/reasoning`, `/omni_model`, and `/omni_reasoning`
   - `control-panels.js` owns synthetic `/global` dispatch, pending reply routing for panel input, and control-panel callback fanout
   - `control-surface.js` owns General cleanup and other cross-panel control-surface helpers such as `/clear`
   - `session-ops.js` owns `/new`, `/diff`, `/compact`, `/purge`, and their background follow-up delivery
   - `topic-commands.js` owns topic-scoped status text builders for wait/language/suffix/new/diff/compact/purge flows
5. The panel layer also follows the same split:
   - `src/telegram/global-control-panel.js` keeps the General `/global` public shell: command entrypoints, callback routing, and domain fanout
   - `src/telegram/global-control-panel-view.js` owns the global panel view/schema side: screen text, inline keyboards, callback codec, and render-time data loading
   - `src/telegram/global-control-panel-lifecycle.js` owns General-menu message lifecycle, unchanged refresh behavior, and panel refresh rendering
   - `src/telegram/global-control-panel-actions.js` owns direct global-panel mutations for wait, suffix, model, and reasoning actions
   - `src/telegram/global-control-panel-input.js` owns pending-input start/clear flows and reply-based global panel input handling
   - `src/telegram/global-control-panel-common.js` keeps the shared global-panel helpers such as callback auth shaping, serialized mutation chains, status sends, and edit-state helpers
   - `src/telegram/topic-control-panel.js` keeps the topic `/menu` public shell: command entrypoints, callback routing, and domain fanout
   - `src/telegram/topic-control-panel-view.js` owns the topic panel view/schema side: screen text, inline keyboards, callback codec, and data loading for render-time state
   - `src/telegram/topic-control-panel-lifecycle.js` owns topic-menu message lifecycle, pin/delete cleanup, recreate-on-unchanged behavior, and panel refresh rendering
   - `src/telegram/topic-control-panel-actions.js` owns direct topic-panel mutations for wait, suffix, model, reasoning, and language actions
   - `src/telegram/topic-control-panel-input.js` owns pending-input start/clear flows and reply-based topic panel input handling
   - `src/telegram/topic-control-panel-common.js` keeps the shared topic-panel helpers such as callback auth shaping, serialized mutation chains, status sends, and safe delete/pin helpers
6. `src/session-manager/` resolves the topic session, workspace binding, suffixes, wait-mode state, exchange log, compact brief, and topic context file.
   - `src/session-manager/session-service.js` keeps the stable public session facade used by the Telegram, Omni, Zoo, and CLI surfaces
   - `src/session-manager/session-auto-mode-service.js` owns topic `auto_mode` mutations and always computes them from the latest locked session state before save
   - `src/session-manager/session-store.js` is the thin public facade for the file-backed session store
   - `src/session-manager/session-store-lifecycle.js` owns lock-aware meta mutations, save semantics, reactivation, parking, and purge flows
   - `src/session-manager/session-store-files.js` owns exchange-log IO, artifact writes, compact-state reads, and generic session file helpers
   - `src/session-manager/session-store-meta.js` owns meta normalization, ownership shaping, runtime defaults, and purge-stub shaping
   - `src/session-manager/session-store-io.js` owns meta/text reads, exchange-log normalization, and artifact file naming
   - `src/session-manager/session-store-common.js` is now the thin shared facade for meta-lock constants and session-store helper re-exports
7. The worker layer now follows the same shell-plus-domain split:
   - `src/pty-worker/worker-pool.js` is the thin public shell that keeps the exported `CodexWorkerPool` surface stable
   - `src/pty-worker/worker-pool-transport.js` owns progress bubbles, typing heartbeats, and live steer buffering/flush behavior, including the short retry window before follow-up fallback
   - `src/pty-worker/worker-pool-delivery.js` owns final reply delivery, transient final-send retry/fallback behavior, Telegram file delivery, and Spike final-event emission
   - `src/pty-worker/worker-pool-lifecycle.js` owns run startup, resume fallback, lifecycle persistence, interrupts, shutdown coordination, and the fresh-thread recovery path for live-steer and ordinary upstream-aborted runs
   - `src/pty-worker/worker-pool-common.js` keeps the shared worker contracts and pure helpers that really cross those slices
8. The `codex-runner` layer now follows the same shell-plus-domain split:
   - `src/pty-worker/codex-runner.js` is the thin public facade for `runCodexTask`: child lifecycle wiring, turn orchestration, steer buffering, short late-final grace after `turn/completed`, live rollout `task_complete` fallback, and finish/fail coordination
   - `src/pty-worker/codex-runner-common.js` keeps shared runner helpers such as warning filtering, child-exit checks, and event summarization
   - `src/pty-worker/codex-runner-transport.js` owns app-server startup wait, websocket connect, and JSON-RPC transport behavior
   - `src/pty-worker/codex-runner-recovery.js` owns rollout replay parsing, summary dedupe tracking, live `task_complete` watching, and post-disconnect fallback recovery
9. `src/cli/run-omni.js` plus `src/omni/` optionally run a second Telegram bot that owns `/auto`, records the goal, forwards prompts to Spike, and wakes only when Spike appends a final-event checkpoint for a completed run.
   - `src/omni/coordinator.js` is now the thin public facade for `OmniCoordinator`
   - `src/omni/coordinator-memory.js` owns coordinator-side memory seeding, patching, and auto-compact bookkeeping on top of `memory.js`
   - `src/omni/memory.js` keeps the small file-backed topic memory store and applies patch operations from the latest locked state so overlapping Omni updates do not overwrite fresher memory
   - `src/omni/coordinator-delivery.js` owns Telegram delivery, operator-input shaping, Spike handoff queueing, and shutdown/interrupt delivery mechanics
   - `src/omni/coordinator-decision-flow.js` owns Omni evaluation, sleep/block/continue orchestration, and resume scans
   - `src/omni/coordinator-common.js` keeps the small shared coordinator helpers and command/query classification helpers
10. `src/zoo/` now follows the same shell-plus-domain split:
   - `src/zoo/service.js` is the thin public facade for `ZooService`
   - `src/zoo/service-menu.js` owns Zoo topic provisioning, callback-backed topic-state recovery, menu payload building, and menu edit/send/pin flow
   - `src/zoo/service-add-flow.js` owns add-project replies, workspace lookup, confirmation, and pet-display-name reconciliation
   - `src/zoo/service-refresh.js` owns callback-side refresh/remove actions, stale-pet cleanup, and animation ticker lifecycle
   - `src/zoo/service-common.js` keeps the shared Zoo text helpers, callback parsing, safe delete/pin helpers, and canonical path/name helpers

## Modular Direction

This repo now explicitly follows a modular-first handler model.

- keep central shells thin; they should classify, gate, and dispatch, not accumulate domain logic
- keep Telegram command behavior in domain handlers under `src/telegram/command-handlers/`
- keep panel render/schema code separate from panel mutation/lifecycle code once a panel grows beyond one screen
- when a handler grows a second heavy responsibility, split it by domain before it turns back into a hub
- keep tests aligned with the same ownership boundaries instead of pushing everything back into router-sized suites
- use shared helper modules for real cross-domain contracts, not as a dumping ground for unrelated code

## Current watchlist

- `src/cli/run.js` is now a lighter composition root, but keep signal handling, abort ownership, and shutdown sequencing there instead of smearing that lifecycle across helpers.
- keep `src/cli/run-background-jobs.js` and `src/cli/run-rollout-controller.js` narrow; they should stay as small closure-based runtime slices, not turn into second-stage monoliths.
- the session-store boundary is healthier now, but keep new persistence logic split between `session-store-lifecycle.js`, `session-store-files.js`, `session-store-meta.js`, and `session-store-io.js` instead of letting one helper file regrow into the next storage monolith.
- `src/pty-worker/worker-pool-lifecycle.js` is intentionally the run-lifecycle owner, but new steer or delivery behavior should stay in `worker-pool-transport.js` and `worker-pool-delivery.js` unless it truly belongs to lifecycle coordination.
- `src/telegram/global-control-panel-view.js` and `src/telegram/topic-control-panel-view.js` are still the heaviest view modules; keep new callback/input/lifecycle behavior in their existing sibling modules so the views stay render-focused.

## Transport behavior

- a normal prompt starts a Codex turn through `app-server`
- repeated follow-up prompts that land while the run is still active are sent into that same live turn through `turn/steer`; short transient steer failures are retried before the gateway falls back to the next prompt queue
- button-driven control-panel and status surfaces prefer cached Codex limits immediately and refresh them in the background instead of stalling a menu redraw on a slow limits source
- button presses now also clear Telegram's callback spinner on a per-batch fast path before the full message/callback business logic finishes, so button pickup stays snappy even when the batch still has heavier work behind it
- service rollout is now per-topic rather than whole-process drain: a retiring generation keeps only the topics that already had an active run, while the replacement generation becomes the intake leader for everything else
- generation liveness for rollout/forwarding is verified through the advertised loopback IPC identity, not only by pid plus heartbeat TTL, so fast pid reuse is much less likely to fool ownership checks
- if the websocket transport drops, or native Windows leaves it alive without a terminal event, the gateway can still use the rollout file to finish the run
- progress is commentary-oriented; command output and transport bookkeeping are not meant to become user-facing progress text
- the emergency lane uses one-shot `codex exec`, not `app-server`, and does not depend on topic routing/session continuity
- Omni also uses short one-shot `codex exec` evaluations instead of a second live `app-server` stack; the only heavy live worker remains Spike
- while an emergency repair run is active, normal operator prompts in topics are blocked so the rescue path stays isolated from live topic runs
- when `OMNI_ENABLED=false`, the Omni runtime may stay stopped, or idle if its user service is still installed

## Session memory

Canonical durable surfaces:

- `meta.json` — topic/session metadata
- `meta.json:auto_mode` — topic-scoped Omni/Spike lock and autonomy state
- `exchange-log.jsonl` — durable raw prompt/final-reply history
- `active-brief.md` — derived recovery summary with enough continuity for a fresh post-compact or post-recovery run
- `telegram-topic-context.md` — compact routing/file-delivery contract for Codex
- `artifacts/` — generated diffs and related outputs
- `state/.../emergency/` — isolated rescue-lane scratch space for downloaded private-chat attachments and `codex exec` output files
- `state/.../omni/runs/` — one-shot `codex exec` outputs for Omni decisions

The gateway does not treat raw PTY output or full tool chatter as canonical memory.

## Operational boundaries

- Telegram remains the only user-facing transport in this repo
- service runtime/state lives under the configured local state root, not inside the repo
- file delivery is intentionally restricted to the current worktree, the session state directory, and the system temp dir
- the service is intentionally single-operator in this phase
- emergency mode is on-demand only: writing in operator private chat starts one isolated rescue run, and the lock disappears automatically when that run finishes or is interrupted
- in an active `/auto` topic, direct human prompts stop at Omni; Spike accepts prompt-starts there only from trusted Omni bot senders
- if Omni is disabled at the deployment level, those topic-scoped `auto_mode` locks become inert until Omni is re-enabled
