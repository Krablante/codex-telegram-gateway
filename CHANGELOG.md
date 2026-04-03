# Changelog

All notable changes to this project will be documented in this file.

The format is intentionally simple and human-readable.

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
