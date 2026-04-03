# Changelog

All notable changes to this project will be documented in this file.

The format is intentionally simple and human-readable.

## [0.2.0] - 2026-04-03

Highlights:

- optional `Omni` bot and `/auto` now ship publicly, including goal-locked supervision, topic-scoped Omni memory, richer Spike handoffs, sleep/pivot decisions, and safe auto-compact at cycle boundaries
- new Telegram control surface: `/guide`, `/global`, `/menu`, `/q`, `/omni_model`, `/omni_reasoning`, and topic/global runtime-setting menus
- `/q` now supports true queued prompts, status/delete operations, attachment-aware queueing, and correct handoff across the short finalization window
- `/guide` generates a beginner PDF guidebook from source markdown, with public-safe wording and no private workspace references
- Telegram reply rendering is more robust: nested lists, code blocks, links, path-label shortening, and file-send blocks behave better in real topics
- deployment can run cleanly in Spike-only mode; Omni is fully optional and its command surface disappears when disabled
- docs were restructured into focused guides for setup, deployment, operator surface, `/auto`, testing, runbook, and state contract
- public defaults are now generic again: XDG state/config paths, repo-local `.env` for `make`, generic `WORKSPACE_ROOT`, and public-safe examples/fixtures

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
