# Codex Telegram Gateway Architecture

## Goal

Expose the real Codex runtime local to the selected execution host through Telegram forum topics without building a second agent platform.

## Core model

- one Telegram topic maps to one session
- one active run per topic at a time
- one worker bot: `Spike`
- one topic keeps one immutable execution-host binding
- if the bound host is unavailable, prompt start fails closed with an explicit host-named reply
- state lives under `the configured state root/...`
- the normal execution path is per-turn `codex exec --json`
- the older `codex app-server` WebSocket transport remains available only as `CODEX_GATEWAY_BACKEND=app-server` plus `CODEX_ENABLE_LEGACY_APP_SERVER=1` fallback
- operator private chat stays a separate emergency `codex exec` lane

## Main runtime flow

1. `src/cli/run.js` is the composition root.
   - bootstraps runtime context, stores, lifecycle services, background jobs, and rollout wiring
   - polls Telegram updates
   - emits heartbeat and structured runtime events
2. `src/cli/run-update-processing.js` handles offset bootstrap, forwarded-vs-local dispatch, and callback ack fast paths.
3. `src/telegram/command-router.js` is the thin Telegram shell.
   - auth
   - classify message / callback / topic context
   - dispatch into domain handlers
4. `src/telegram/command-handlers/` owns the Telegram surface by domain:
   - `prompt-flow*.js` plus `prompt-flow/` — direct prompts, `/q`, wait-window bridging, buffering, and backend-aware busy behavior
   - `surface-reference-commands.js` plus `surface-reference/` — `/help`, `/guide`, suffix help, help-card delivery
   - `surface-settings-commands.js` plus `surface-settings/` and `runtime-settings/` — `/status`, `/limits`, `/language`, `/wait`, `/suffix`, `/interrupt`, model/reasoning settings
   - `session-ops.js` plus `session-ops/` — `/new`, `/diff`, `/compact`, `/purge`
   - `control-panels.js` plus `global-control-panel*/topic-control-panel*` — `/global`, `/menu`, single-menu-first text input, callback fanout
5. `src/telegram/global-control-panel*` and `src/telegram/topic-control-panel*` now split shell, lifecycle, command/callback handling, pending-input flow, actions, and view/schema logic.
6. `src/session-manager/` owns session state.
   - `session-service.js` is the stable public facade over binding, attachments, prompt queue, prompt surface, runtime settings, and context services
   - `session-store*.js` owns meta normalization, file IO, lifecycle mutations, and locking
   - `session-compactor.js` plus `session-compactor/` own recovery-brief compaction source selection, prompt shaping, and Codex summarizer runs
   - prompt suffix, runtime settings, queue, and topic-context rendering live here too
7. `src/pty-worker/` owns worker orchestration, delivery, backend selection, busy/queue handling, remote execution routing, and fallback app-server lifecycle.
   - `worker-pool.js` is the stable public shell
   - `worker-pool-transport.js` handles progress bubbles, typing, and backend-aware busy behavior
   - `worker-pool-delivery.js` handles final reply delivery, telegram-file sends, and Spike final events
   - `worker-pool-lifecycle.js` is now the lifecycle facade over startup, attempt/recovery, finalize, and shutdown stage modules
8. `src/codex-exec/telegram-exec-runner.js` owns the default exec backend.
   - fresh turn: `codex exec --json --dangerously-bypass-approvals-and-sandbox -C <cwd> -`
   - continuation: `codex exec --json --dangerously-bypass-approvals-and-sandbox -C <cwd> resume <thread_id> -`
   - remote turn: direct `ssh -T <host> '<codex>' exec --json ...`, with the prompt on stdin
   - the first `thread.started.thread_id` is persisted as `session.codex_thread_id`
   - only main-run natural-language `agent_message` progress notes and `reasoning` items become Telegram-visible progress; plan/todo, file-change, tool, web-search, command, and collab/subagent items stay internal
9. `src/pty-worker/codex-runner*.js` owns the fallback app-server transport, JSON-RPC turn lifecycle, websocket reattach, rollout replay fallback, steer buffering, startup bootstrap, and completion recovery through focused stage modules.
10. `src/codex-runtime/limits/` owns limits snapshot normalization, formatting, and source/service resolution.
11. `src/telegram/guidebook/` owns guidebook/runbook markdown parsing, font resolution, PDF layout/rendering, and rasterization.
12. `src/zoo/` owns the dedicated Zoo topic and pet/menu flows.
13. `src/emergency/` owns the isolated private-chat rescue lane.

## Prompt and context model

- stable per-topic routing and file-delivery context is rendered as a host-aware `Context:` block for every run
- exec-json sends that block through Codex `developer_instructions`, while the fallback app-server path sends the same block as `developerInstructions`
- effective saved `Work Style` is appended to that developer-instructions block too
- the visible user-turn body is intentionally small and only carries `User Prompt:`
- `Context:` names the bound host, execution cwd, `/workspace/<workspace-root-basename>` MCP mirror root, Telegram delivery roots, shared operator memory, and bound-host memory
- runtime profile resolution uses the current Codex catalog, while model menus expose only the list-visible subset; for host-bound topics the catalog comes from the current host config directly or a mirrored remote-host `models_cache.json` snapshot when available
- `telegram-topic-context.md` remains a control-plane artifact, not the main runtime source of truth for remote runs

## Session memory

Canonical durable surfaces:

- `meta.json` — topic/session metadata
- `exchange-log.jsonl` — append-only user prompt + final reply history
- `progress-notes.jsonl` — append-only main-run natural-language progress notes used as recovery hints
- `exec-json-run.jsonl` — transient latest exec-json turn mirror used by stale-run recovery to salvage already-emitted final answers
- `active-brief.md` — derived recovery brief used after `/compact` or explicit recovery
- `telegram-topic-context.md` — local control-plane topic context copy
- `spike-prompt-queue.json` — `/q` FIFO queue
- `incoming/` — downloaded topic attachments
- `artifacts/` — diff snapshots and similar outputs

The gateway does not treat raw Codex event/tool chatter or fallback app-server/PTY output as canonical memory. Progress notes are intentionally narrower: only Telegram-visible main-run natural-language notes are persisted, so compact/crash recovery can recover current work without storing hidden reasoning or orchestration noise.

## Codex backend contract

`CODEX_GATEWAY_BACKEND` accepts:

- `exec-json` — default; one clean `codex exec --json` process per turn
- `app-server` — temporary fallback for legacy WebSocket/live-steer debugging; rejected unless `CODEX_ENABLE_LEGACY_APP_SERVER=1`

Exec backend behavior:

- prompt text is written to stdin; the prompt is never shell-quoted into the command line
- child Codex processes receive a scrubbed allowlisted environment, not the gateway's Telegram/state/host-registry secrets
- `-p` is never used as a prompt flag; it belongs to Codex profiles
- cwd is passed with `-C`
- local and remote image paths are passed as `-i`
- runtime model/reasoning/context-pressure knobs are passed as `-c` overrides
- continuity is `codex_thread_id` only; fallback app-server provider ids, rollout paths, and snapshot `session_id` values are ignored or cleared in the default path
- startup stale-run recovery runs only after the instance has the intake-leader lease, rechecks ownership under the session meta lock, and may read `exec-json-run.jsonl` for an already-finished default-backend turn
- busy-topic plain follow-ups are accepted as live steer: the active exec process is interrupted and the same logical run resumes with the merged prompt; child exits caused by the requested steer are classified as upstream interruption/recovery, not as incomplete-stream crashes, unless Codex emitted an explicit fatal JSONL event
- context-window exhaustion gets one recovery attempt: compact the topic into `active-brief.md`, clear stale continuity, and retry once as a fresh exec-json thread. Source selection is in `docs/state-contract.md`: small logs use the full exchange log, small logs with pending progress notes use a full `compaction-source.md`, and oversized logs use bounded recent/progress/high-signal/checkpoint slices.
- gateway recovery does not depend on injecting `/compact` into `codex exec --json resume`; that path is not treated as a stable noninteractive CLI control API
- visible progress is sourced from main-run natural-language `agent_message` progress notes and `reasoning` items
- plan/todo, file-change, tool, web-search, command, and collab/subagent events stay internal
- recovery/retry state is emitted to runtime events, not as synthetic Telegram thought text
- remote runs keep the SSH connection open for the turn; a durable spooler is a future improvement, not part of the MVP

Fallback app-server behavior:

- protocol commentary agent messages may still drive progress while debugging that backend
- command/tool/file/subagent activity must remain internal and must not be rendered as thoughts

## Operational boundaries

- Telegram is the only user-facing transport in this repo
- service runtime/state lives under `the configured state root/...`, not in source
- file delivery is intentionally restricted to safe roots: local worktree/session state, or translated remote worktree/cwd roots for host-bound topics
- service rollout is per-topic and ownership-aware
- fallback app-server graceful exit after a final answer is normal completion; before a final answer it is recovered through the resume path instead of being reported as `exited with code 0`
- the gateway is intentionally single-bot now; removed legacy autonomy metadata is stripped or ignored during normalization
