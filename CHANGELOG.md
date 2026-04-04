# Changelog

All notable changes to this project will be documented in this file.

The format is intentionally simple and human-readable.

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
