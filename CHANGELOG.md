# Changelog

All notable changes to this project will be documented in this file.

The format is intentionally simple and human-readable.

## [Unreleased]

## [0.3.43] - 2026-04-21

Fixed:

- corrupt `sessions/.../meta.json` now fails closed after quarantine during `ensure()` instead of being treated like a missing session and silently recreating fresh active state
- global Codex settings and global prompt suffix stores now serialize overlapping writes, matching the safer store patterns already used elsewhere in the runtime
- pending prompt attachment buffering now merges under the session meta lock, so overlapping attachment-first prompts stop dropping each other
- `SessionService.getDefaultBinding()` now clears failed resolution cache so a transient bad path does not poison later successful calls
- bare `wait 60` / `wait 600` aliases now still parse when Telegram attaches unrelated entities to the same message
- topic `/menu` repins are safer: the gateway no longer guesses and deletes `message_id + 1`, so it stops risking accidental deletion of an unrelated neighboring message
- direct `/help` and `/guide` delivery paths now handle undelivered document results explicitly instead of silently pretending success
- Omni reply sends now have the same missing-reply-target fallback as topic sends, direct Omni-query children are tracked for shutdown, and auto continuation paths stop queueing fresh Spike work after Telegram already parked the topic
- replacement rollout generations no longer inherit ambient `process.execArgv` flags unless the caller passes them explicitly

Docs:

- refreshed README, AGENTS, Telegram surface, runbook, and testing docs for the safer `/menu` repin behavior, the `CODEX_BIN_PATH` + `CODEX_CONFIG_PATH` + MCP triage flow, and `/status` configured-vs-effective context reporting

Tests:

- public `node --test`: 621 pass, 0 fail, 4 skip
- public `npm run test:live`: 4 pass, 0 fail

## [0.3.42] - 2026-04-18

Fixed:

- `/compact` now persists a real in-progress state while the brief rebuild runs, blocks direct prompt starts in that topic during the rebuild, validates the rebuilt brief shape before accepting it, and clears stale run/ownership continuity cleanly when the fresh-start handoff is committed
- session-aware rollout now keeps ownership on just-starting topics instead of relying only on `last_run_status === "running"`, so retained topics keep forwarding correctly across soft restarts even during the start window
- topic control-panel `/compact` actions now respect queued Omni handoffs the same way typed `/compact` already did
- `message_thread_id: 0` is now treated strictly as Telegram `General`, not as a synthetic work-topic session id
- topic document delivery now preserves `reply_to_message_id` and `contentType`, with the same missing-reply-target fallback as normal topic replies
- stale configured default models now fall back to a real available model instead of bypassing cached-model validation
- live steer now recovers from the transient `no active turn to steer` app-server race by refreshing the in-progress turn through `thread/resume` instead of dropping the steer attempt outright
- Windows live-test entrypoints are more robust: `scripts\\windows\\test-live.cmd` now changes into the repo root before launching the live suite, and the live runner uses an absolute repo-root test path
- `doctor` now reports both `allowed_user_id` and `allowed_user_ids`

Docs:

- refreshed README, AGENTS, runbooks, testing docs, and state contract for the new `/compact` runtime contract, the better config bootstrap hint, and the Windows live-test wrapper behavior

Tests:

- public `node --test`: 605 pass, 0 fail, 4 skip
- public `npm run test:live`: 4 pass, 0 fail

## [0.3.41] - 2026-04-18

Fixed:

- `/compact` brief rebuilds now preserve still-active user-specific rules and delivery instructions from the exchange log more explicitly instead of collapsing everything into generic preferences
- rebuilt briefs no longer invent placeholder rules when the summarizer leaves that section empty

Docs:

- refreshed README, AGENTS, Telegram surface, runbook, state contract, and testing docs so the public operator contract matches the current compact behavior

Tests:

- public `node --test`: 598 pass, 0 fail, 4 skip
- public `npm run test:live`: 4 pass, 0 fail

## [0.3.40] - 2026-04-18

Fixed:

- Windows CI now validates the intended `CODEX_LIMITS_COMMAND` contract correctly: legacy quoted string parsing is tested as POSIX-only behavior, while native Windows continues to require JSON argv syntax
- the repeated upstream `SIGINT` recovery regression test now uses a timeout budget that matches the real bounded backoff path, so slower Windows runners do not fail a healthy worker-pool lifecycle on timing noise alone

Tests:

- public `node --test`: 597 pass, 0 fail, 4 skip

## [0.3.39] - 2026-04-18

Fixed:

- native resume now follows real Codex session history more closely: the gateway repairs continuity through `thread/list`, `provider_session_id`, rollout metadata, and `session_key` before it falls back to a brief rebuild
- websocket disconnects now try to reattach to the same live `codex app-server` session before dropping into rollout fallback, and service shutdown/rollout paths stop self-interrupting healthy runs by default
- startup stale-run recovery now preserves resumable continuity when possible and can recover already-completed runs from rollout truth instead of flattening everything into fake interrupted or failed outcomes
- session lifecycle handling is tighter: purged topics stay purged, repeated topic-unavailable parking stops spamming lifecycle state, `General` message-ledger writes are serialized, and topic reply fallback is cleaner when Telegram loses the original reply target
- native Windows handling is more robust: case-insensitive `PATH` / `PATHEXT`, safer `.cmd` / `.bat` launching, Windows-reserved attachment-name sanitizing, transient filesystem retry for atomic replace, and platform-aware live prompt helpers
- `CODEX_LIMITS_COMMAND` remains shell-free everywhere and now requires the JSON argv form on native Windows instead of guessing through POSIX-style command strings

Ops:

- `make test-live` now uses the repo-local live-test runner, `make user-spike-audit` is available for heavier user-account Spike validation, and native Windows now ships matching `scripts\\windows\\test-live.cmd` and `scripts\\windows\\user-spike-audit.cmd` wrappers
- chained soft rollouts can now start cleanly even when the previous replacement generation already took traffic and an older generation is still draining retained topics

Docs:

- README, AGENTS, deployment, runbooks, architecture, state contract, and testing docs now describe the native resume-first contract, the new live validation entrypoints, and the current Windows/Linux operator behavior

Tests:

- public `node --test`: 597 pass, 0 fail, 4 skip
- public `npm run test:live`: 4 pass, 0 fail

## [0.3.38] - 2026-04-17

Fixed:

- upstream-aborted runs now retry on the same Codex thread before the gateway falls back to a fresh-thread rebuild, which preserves continuity better on large long-lived topics
- live-steer recovery keeps replaying accepted image inputs while resuming the same thread instead of forcing an immediate thread reset

Observability:

- `run.attempt` and `run.recovery` telemetry now record `requested_thread_id` and `same_thread_resume` so operators can see when recovery stayed on the original Codex thread

Docs:

- README, architecture, and testing docs now describe the same-thread upstream recovery path instead of the older fresh-thread-first wording

Tests:

- updated worker-pool upstream recovery regression coverage to assert same-thread retries for ordinary and live-steer abort paths

## [0.3.37] - 2026-04-17

Fixed:

- long prompt buffering no longer reactivates a parked topic session before a real run actually starts
- `/new` inside an already open topic now reuses the loaded workspace binding instead of doing redundant inheritance resolution
- ordinary upstream-interrupted runs now get a bounded two-restart recovery budget, and a final answer that already arrived before the abort is preserved as `completed` instead of being thrown away
- repeated recovery attempts inside one run now reuse the already loaded Codex runtime profile inputs instead of rereading config and model state every time

Observability:

- `runtime-events.ndjson` now records per-attempt `run.attempt` entries with thread, final-answer, command/commentary, and abort metadata so operators can see why recovery happened instead of guessing from chat output
- `make admin ARGS='status'` now surfaces the resolved `CODEX_CONFIG_PATH` and parsed MCP server list for faster live diagnostics

Docs:

- README, AGENTS, deployment, runbook, state-contract, testing, and Telegram surface docs now explain the bounded recovery path, Codex config visibility, and generic host-to-container MCP path mirror guidance

Tests:

- added regression coverage for buffer-without-reactivation, `/new` binding reuse, MCP config parsing, user-service config pinning, two-step upstream recovery, late-abort final-answer salvage, and generic topic-context mirror hints

## [0.3.36] - 2026-04-16

Fixed:

- ordinary runs no longer die immediately as terminal interruptions when upstream aborts the active turn without a user stop; the worker pool now retries once on a fresh thread before surfacing `interrupted`

Observability:

- `runtime-events.ndjson` now records per-run `run.started`, `run.recovery`, and `run.finished` entries with interrupt and recovery metadata so operators can correlate real recovery paths instead of guessing from chat output alone

Tests:

- added regression coverage for ordinary upstream-interrupt restart and for the one-retry cap before a final interrupted outcome

## [0.3.35] - 2026-04-16

Fixed:

- accepted live-steer follow-ups no longer die as fake terminal interruptions when upstream aborts the current turn right after accepting steer; the worker pool clears dead thread state and rebuilds the same top-level run on a fresh thread
- steer-triggered recovery now replays accepted image inputs as real `localImage` items on the replacement attempt instead of degrading them into text-only context

Docs:

- README, architecture, Telegram surface docs, both guidebooks, and testing docs now describe the new live-steer recovery path so operators understand when the gateway retries, queues, and rebuilds the run

Tests:

- added regression coverage for accepted live-steer restart after upstream abort, including replay of image attachments on the recovery attempt

## [0.3.34] - 2026-04-16

Fixed:

- stalled disconnect recovery and early-start run failures now tear down orphaned live Codex state instead of leaving topics stuck in fake `running`
- live `codex app-server` launches now force the configured full-access/never-approval runtime args instead of drifting into a sandboxed app-server path
- upstream interrupted Codex turns now finalize as interrupted instead of being surfaced as ordinary failed runs
- Telegram Bot API `retry_after` throttles on ordinary reply sends are retried inline, so temporary `429 Too Many Requests` responses stop replaying the same update and duplicating queue confirmations

Docs:

- public AGENTS and Telegram surface docs now recommend keeping MCP/tooling guidance in the persistent global suffix, with `pitlane`, `tavily`, `context7`, and `requests` called out explicitly
- README notes now record the live full-access app-server behavior, stuck-run cleanup, upstream interrupt finalization, and inline Telegram rate-limit retry path
- runbook, deployment, testing, architecture, and state-contract docs now use generic public paths/state-root wording instead of private Atlas-specific examples, and the public restart path is documented consistently as `make service-restart-live`

Tests:

- added regression coverage for stalled disconnect recovery, startup run cleanup, forced full-access live app-server args, upstream interrupt finalization, and inline `retry_after` recovery in `TelegramBotApiClient`

## [0.3.33] - 2026-04-09

Fixed:

- oversized prompt attachments no longer poison the Telegram poll cycle; the gateway now sends a small inline "too large" reply and acknowledges the update instead of retrying the same failing attachment forever

Docs:

- Telegram surface, state contract, deployment/setup docs, runbooks, and testing docs now describe the clean oversized-attachment behavior and record Local Bot API as the future path for true huge-file Telegram ingestion

Tests:

- added regression coverage for oversized prompt attachments in the Spike update-dispatch layer

## [0.3.32] - 2026-04-08

Docs:

- minor styled README refresh so the public repo keeps one consistent README format and visual style instead of drifting toward the plain private variant

## [0.3.31] - 2026-04-08

Fixed:

- Spike now finishes a stuck native Windows run from rollout `task_complete` even when the websocket stays alive and never emits the terminal live event
- `/diff` now returns a normal inline unavailable reply for plain-folder bindings instead of throwing `not a git repository` and poisoning the poll cycle

Docs:

- README, architecture, runbooks, Telegram surface docs, state contract, testing docs, and both guidebooks now describe the non-git `/diff` behavior and the rollout-backed Windows finalization path

Tests:

- added regression coverage for live `task_complete` finalization without websocket disconnect and for `/diff` on non-git bindings

## [0.3.30] - 2026-04-07

Fixed:

- changing the configured model now clears a stale incompatible reasoning override for Spike, Omni, and `/compact` instead of leaving hidden unsupported values in state
- stale unavailable model overrides now stop shadowing the configured default profile, while an explicit config default still survives a stale cached model list

Docs:

- README, Telegram surface docs, state contract, testing docs, and both guidebooks now label the `/compact` profile more explicitly as a brief-rebuild summarizer setting

Tests:

- added regression coverage for `/compact` global panel controls plus compact runtime-profile resolution and stale-reasoning cleanup in `SessionService`

## [0.3.29] - 2026-04-07

Changed:

- `General -> Bot Settings` now exposes a separate global model/reasoning pair for the temporary `/compact` summarizer instead of forcing brief rebuilds to reuse the live worker defaults

Docs:

- guidebooks, Telegram surface docs, and the state contract now explain that `/compact` uses its own global model/reasoning profile from `General -> Bot Settings`

Tests:

- added regression coverage for `/compact` global panel controls and the compact runtime profile used by `SessionCompactor`

## [0.3.28] - 2026-04-06

Fixed:

- `/auto` continuation handoffs now switch to a compact goal capsule after bootstrap, so live Omni -> Spike prompts stay focused instead of dragging the full mission essay every cycle
- Omni memory now keeps the legacy `remaining_goal_gap` alias in sync with `goal_unsatisfied`, so stale gap text does not linger after a new decision updates the real next gap

Ops:

- added `make service-restart-live` as the canonical live restart path: restart `Omni`, then soft-roll `Spike`

Docs:

- README, AGENTS, and runbooks now point operators at the safe restart entrypoint and warn against raw `systemctl restart` for ordinary live updates

Tests:

- added prompt-shape coverage for compact goal-capsule handoffs, fallback goal-capsule memory, and legacy goal-gap alias sync
- public `make test`: 513 pass, 0 fail, 2 skip

## [0.3.27] - 2026-04-06

Fixed:

- `/auto` now refreshes continuity after 10 Omni handoffs at the next safe cycle boundary instead of waiting for an additional age threshold

Docs:

- Omni auto-mode docs now describe the count-only compact trigger explicitly

Tests:

- tightened the Omni cycle regression so a future `first_omni_prompt_at` can no longer block a valid count-based auto-compact

## [0.3.26] - 2026-04-05

Fixed:

- `UpdateForwardingServer` now updates its public `endpoint` after a loopback bind retry, so forwarded updates stop targeting the stale blocked port on Windows

Docs:

- testing docs now call out rebound-endpoint sync coverage inside the loopback forwarding slice

Tests:

- added a deterministic regression that forces a retry bind and verifies the public forwarding endpoint follows the rebound port

## [0.3.25] - 2026-04-05

Fixed:

- the late-final grace window no longer uses an unref'ed timer, so completion can finish cleanly under CI and other short-lived process exits instead of leaving `run.finished` pending
- local loopback forwarding now retries blocked or reserved loopback ports such as Windows `EACCES` / `EPERM` bind failures instead of failing the forwarding server on the first attempt

Docs:

- README, runbook, state-contract, and testing docs now call out the blocked-port loopback retry path and the completion-timing coverage behind it

Tests:

- added regression coverage for blocked-port loopback retry and tightened the codex-runner test description around late-final completion timing

## [0.3.24] - 2026-04-05

Fixed:

- final Spike replies now retry transient Telegram and network send failures instead of dropping the run result after a successful completion
- when that transient final send still never comes back, the final answer now stays visible in the existing progress bubble instead of disappearing
- long final replies now preserve already-delivered Telegram `message_id` metadata even if a later chunk fails
- the runner now waits briefly for a late primary final answer after `turn/completed`, avoiding spurious generic `Done.` / `Готово.` fallbacks

Docs:

- README, architecture, runbook, state-contract, and testing docs now describe the final-reply recovery path and the short late-final grace window

Tests:

- added regression coverage for transient final-reply recovery, progress-bubble fallback, partial-delivery metadata, parked final-send handling, and late final-answer ordering after `turn/completed`

## [0.3.23] - 2026-04-05

Fixed:

- stale callbacks from an older Zoo menu message no longer replace the active stored `menu_message_id`, so recovery and respawn flows keep editing the real current menu

Tests:

- added regression coverage for stale Zoo callbacks so old buttons cannot steal the active menu binding during normal callback handling

## [0.3.22] - 2026-04-05

Fixed:

- Zoo now rebuilds lost `zoo/topic.json` topic/menu binding from the next live Zoo menu callback, so button-driven flows like `Add project` stop failing as silent no-ops after state corruption
- recovered Zoo topics re-enter the Zoo-only add-flow path immediately instead of falling through to ordinary topic session routing

Docs:

- README, architecture, runbook, state-contract, testing, and Zoo concept docs now describe the Zoo state-recovery path explicitly

Tests:

- added regression coverage for missing Zoo topic state recovery through a live menu callback plus immediate add-flow continuation

## [0.3.21] - 2026-04-05

Fixed:

- runtime heartbeat writes are now serialized, avoiding overlapping temp-file rename races during concurrent observer updates
- startup stale-run recovery now clears dead thread/rollout resume state and emits a synthetic failed final, so `/auto` topics can recover cleanly after a Spike restart
- buffered live steer flush now retries short transient transport recovery failures, so follow-up prompts sent during run startup are not silently stranded

Tests:

- added regression coverage for serialized heartbeat writes, stale-run recovery final-event emission, and transient buffered-steer flush retries

## [0.3.20] - 2026-04-05

Fixed:

- guidebook and runbook PDF generation now prefers Unicode-capable Windows system fonts, so Russian text no longer falls back to broken base-PDF glyphs on native Windows
- when a Cyrillic PDF source is requested but no usable Unicode font can be found, generation now fails loudly instead of sending mojibake

Tests:

- added Windows font-resolution regression coverage for the PDF guidebook generator

## [0.3.19] - 2026-04-05

Fixed:

- startup now recovers stale `running` sessions whose recorded owner generation is no longer live, so old crashed runs stop blocking fresh work after restart
- rollout recovery now treats real `task_complete` entries as a valid completion fallback and picks up `last_agent_message` when the live websocket finalization path did not finish cleanly

Docs:

- architecture and testing docs now include the startup stale-run recovery slice and its focused regression coverage

## [0.3.18] - 2026-04-05

Fixed:

- the global `Zoo` button now keeps the real Zoo routing path alive, so pressing it from `General` opens the Zoo flow instead of falling back to the generic "use a dedicated work topic" reply

Tests:

- added callback-path regression coverage for `global menu -> Zoo -> synthetic /zoo -> zooService`

## [0.3.17] - 2026-04-05

Changed:

- live follow-up prompts now retry short transient `steer` failures before falling back to the next prompt queue, so mid-run follow-ups stop bouncing to the generic busy reply
- the Spike runtime shell and session-store internals were split into thinner modules while keeping the public command surface and cross-platform behavior stable

Fixed:

- `RUN_ONCE` / smoke maintenance no longer starts background timers that can race the explicit one-shot maintenance path

Docs:

- README now summarizes the current `0.3.17` wave more directly, and the public architecture/testing docs describe the modular runtime shell plus run-once maintenance ownership

## [0.3.16] - 2026-04-05

Changed:

- the global `General` menu now keeps `Guide` and `Help` directly under `Bot Settings` and `Language`, so the most common reference actions stay at the top of the pinned surface

Docs:

- README, Telegram surface docs, and both guidebooks now describe the updated root-menu order

## [0.3.15] - 2026-04-05

Changed:

- the global `General` menu root now includes one-tap `Zoo` and `Clear` shortcuts, keeping the common operator actions on the same pinned surface
- `Bot Settings` and `Language` now sit on the top row of the global menu so the stable configuration entrypoints are front-loaded

Docs:

- README, Telegram surface docs, and both guidebooks now describe the current global-menu layout and shortcuts

## [0.3.1] - 2026-04-05

Fixed:

- native Windows Codex startup now defaults cleanly to `codex.cmd`, launches shim wrappers through explicit `cmd.exe /d /s /c`, and avoids `detached` app-server / exec runs where Windows process handling is fragile
- app-server startup failures now surface recent `stdout` / `stderr` lines instead of only returning a blind timeout
- Windows symlinked-worktree coverage now uses directory junctions, avoiding unnecessary `Developer Mode` / elevated-privilege requirements for that test slice
- cross-platform CI expectations now correctly distinguish Linux and native Windows defaults for `CODEX_BIN_PATH` and detached `codex exec` behavior

## [0.3.0] - 2026-04-05

Added:

- session-aware Spike rollout and handoff via `make service-rollout`, `make service-restart`, `make service-hard-restart`, plus generation/liveness verification and rollout ownership storage
- modular handler/runtime slices across Telegram, worker-pool, Omni, and Zoo, with matching `test-support/` fixtures and a much broader public regression suite
- public runbook PDF build support, Russian runbook source, `scripts/windows/admin.cmd`, and `scripts/windows/user-e2e.cmd`

Changed:

- public repo is now fully resynced to the current private architecture wave while keeping public defaults: XDG config/state on Linux, `%LOCALAPPDATA%` on Windows, repo-local `.env` for `make`, and public GitHub package metadata
- systemd install flow now resolves `CODEX_BIN_PATH` without invoking a shell, preserves `PATH` inside the user unit, and documents the `systemd >= 250` requirement for soft Spike rollout
- README, deployment, testing, runbook, state-contract, and Telegram surface docs now describe the current menu/control/rollout behavior instead of the older `0.2.2.2` surface

Fixed:

- native Windows stop/restart handling no longer depends on POSIX-only negative-pid signaling; interrupted runs now fall back to `taskkill /t`
- Windows `PATH`/`Path` lookup and `.cmd` shim handling are now robust for native installs and GitHub Actions runners
- rollout handoff now rejects stale or mismatched update-forwarding traffic instead of trusting the first generation heartbeat that appears

## [0.2.2.2] - 2026-04-04

Added:

- `/limits` as a first-class public command, with the same live snapshot folded into `/status`, `/global`, and `/menu`
- an in-menu `Status` screen for topic-local `/menu`, so operators can inspect state without emitting a separate topic reply
- public env/docs coverage for remote limits sourcing via `CODEX_LIMITS_COMMAND` or `CODEX_LIMITS_SESSIONS_ROOT`

Changed:

- `/menu` now accepts Telegram-style `/<command>@YourBot` suggestions, recreates the pinned panel cleanly on reopen, and removes replaced menu clutter plus transient pin notices
- guidebook, Telegram surface, deployment, testing, and README docs now match the current limits/menu/live-steer behavior

Fixed:

- repeated live follow-up prompts now keep steering the same active Codex run instead of stalling after the first continuation
- `/q` queue previews render cleanly again instead of leaking raw formatting tags into Telegram
- limits sourced through `CODEX_LIMITS_COMMAND` no longer echo the raw shell command back into Telegram when no safe JSON `source` label is provided

## [0.2.2.1] - 2026-04-04

Added:

- explicit Zoo trend-marker coverage in the public test suite so pet-card stat changes stay visible and stable

Changed:

- README now treats `v0.2.2.1` as a small catch-up release and calls out the current Zoo/rendering surface more directly
- setup and deployment docs now explain the true minimum config more plainly, including bot admin rights and the practical meaning of `DEFAULT_SESSION_BINDING_PATH`
- Telegram surface and testing docs now match the current Zoo card shape more closely, including expandable detail text and visible trend markers

Fixed:

- Zoo stat trends now react to any real increase or decrease instead of waiting for a five-point jump
- rendered Zoo cards now use proper `↑` and `↓` arrows instead of weaker ASCII placeholders

## [0.2.2] - 2026-04-04

Added:

- GitHub Actions CI for Ubuntu and native Windows test coverage, plus a safe guidebook-build smoke check

Changed:

- README now reflects the current public surface more cleanly, including Zoo, `General /clear`, Windows-native usage, and CI
- testing docs now separate CI-safe smoke from the live/manual `make smoke` path

Fixed:

- `telegram-file` delivery now canonicalizes real paths before allowed-root checks, so Windows path aliases and canonical temp/worktree paths no longer break delivery
- worker-pool cross-platform tests no longer depend on Linux-only `/etc/hosts` or raw non-canonical temp-path formatting

## [0.2.1] - 2026-04-04

Added:

- experimental menu-only `Zoo` topic for project tamagotchi cards, including project lookup, stable pet identity, localized cards, duplicate private/public repo disambiguation, and per-pet snapshot history
- `General` now has `/clear`, which preserves the active menu and removes tracked clutter without needing a user-session cleanup sweep
- native Windows wrapper scripts for install, Codex CLI install, doctor, test, run, Omni run, and live-user helpers

Changed:

- public repo is now caught up with the current private functional surface, including Zoo, `General /clear`, and the latest runtime/test hardening
- native Windows is now a first-class deployment path with repo-local `.env` fallback, Windows-safe temp roots, safer path handling, and clearer docs
- direct file delivery now uses the system temp directory instead of assuming `/tmp`

Fixed:

- native Windows bootstrap no longer depends on bash, systemd, or Linux-only env defaults just to get the gateway online
- workspace diff artifact generation no longer risks flaky parallel `git diff` behavior on Windows
- Windows test coverage now avoids POSIX-only assumptions around file modes, timers, and path formatting

Docs:

- refreshed README, setup, deployment, testing, and architecture docs for `Zoo`, `General /clear`, and Windows-native usage
- added the public Zoo concept note and updated the Telegram surface docs to reflect the current command surface

## [0.2.0] - 2026-04-03

Added:

- public `Omni` support with `/auto`, goal-locked supervision, topic-scoped Omni memory, richer Spike handoffs, sleep/pivot/block/done decisions, and safe auto-compact at cycle boundaries
- full prompt queue support via `/q`, including queued text, queued attachments, queue status/delete operations, and correct handoff across the short finalization window
- new Telegram control surfaces: global menu in `General`, topic-local `/menu`, per-topic and global runtime-setting controls, and explicit `Spike`/`Omni` model and reasoning commands
- beginner `/guide` PDF generation from source markdown, plus refreshed help-card assets
- live-user helpers for userbot login/status/e2e flows and state-only bootstrap files
- optional dedicated Omni runner via `make run-omni`, `make service-install-omni`, and `src/cli/run-omni.js`

Changed:

- deployment is now cleanly split between Spike-only mode and Spike + Omni mode, with Omni truly optional instead of assumed
- Telegram reply rendering is much more robust for nested lists, fenced code blocks, links, shortened local file labels, and `telegram-file` delivery blocks
- direct prompts, long Telegram fragments, media groups, caption-first flows, queued prompts, and attachment-only messages now share a more reliable prompt assembly path
- topic creation via `/new` supports explicit `cwd=...` or `path=...` bindings, automatic topic-local menu bootstrap, and better inherited language behavior
- runtime settings moved to a richer model with global/topic overrides for Spike and Omni model/reasoning, plus clearer `/status` reporting
- public defaults are generic again: XDG config/state paths, repo-local `.env` for `make`, `WORKSPACE_ROOT`, public-safe examples, and public-safe test fixtures
- README and setup/onboarding docs were rewritten into a clearer OSS-style entrypoint with stronger quick start, docs map, path-binding guidance, and Windows path notes

Fixed:

- `/q` no longer loses prompts around the short end-of-run finalization window
- sleeping/stale `/auto` state handling is safer and no longer blocks normal prompts when Omni is disabled
- unavailable-topic failures are handled more gracefully across topic replies, diff delivery, help delivery, and Omni lifecycle transitions
- guidebook PDF generation now uses stable viewer-safe output with corrected text flow, spacing, colors, and public wording
- dependency audit tail was cleaned up by refreshing the lockfile so `npm audit --omit=dev` is clean again

Docs:

- docs were split into focused guides for setup, deployment, architecture, Telegram surface, `/auto`, testing, runbook, and state contract
- guidebook content now explains `Spike`, `Omni`, `/new`, `/q`, `/wait`, `/suffix`, `/compact`, `/purge`, menus, `/help`, and optional Omni usage in beginner-friendly language
- workspace binding behavior is now documented explicitly, including `WORKSPACE_ROOT`, `DEFAULT_SESSION_BINDING_PATH`, relative `cwd=...`, absolute paths, and Windows path examples

## [0.1.2] - 2026-04-01

Fixes:

- `/compact` now rebuilds a denser `active-brief.md` from `exchange-log.jsonl`, with explicit workspace context, current state, open work, and latest exchange guidance for the summarizer
- the first fresh run after `/compact` now bootstraps from that generated brief instead of starting from a near-empty prompt
- startup/shutdown interruption got a race fix so interrupted runs tear down more reliably during edge-case timing

## [0.1.1] - 2026-04-01

Fixes:

- manual `/compact` now clears stored Codex thread and context snapshot state
- the next worker prompt after `/compact` now starts from rebuilt brief continuity instead of resuming the old thread
- `/status` no longer keeps showing stale thread-backed context usage right after successful compaction

## [0.1.0] - 2026-03-31

Initial public release.

Highlights:

- Telegram forum topics mapped to durable local Codex sessions
- live run steering for follow-up prompts in the same topic
- commentary-style progress delivery instead of raw tool spam
- bilingual Telegram UI with `RUS` and `ENG` modes
- file-first prompt handling and attachment-aware prompts
- session compaction with local exchange-log based brief rebuilding
- operator-only emergency private-chat rescue lane
- public docs, setup guide, runbook, and MIT licensing
