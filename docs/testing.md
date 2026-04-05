# Testing

## Fast Local Checks

Linux/operator path:

```bash
cd /path/to/codex-telegram-gateway
make doctor
make test
```

Native Windows:

```powershell
cd C:\path\to\codex-telegram-gateway
copy .env.example .env
scripts\windows\install.cmd
scripts\windows\install-codex.cmd
scripts\windows\doctor.cmd
scripts\windows\admin.cmd status
scripts\windows\test.cmd
```

On native Windows, leave `CODEX_BIN_PATH` empty unless you need a custom shim path. The runtime now falls back to `codex.cmd` by default, the symlinked-worktree coverage uses directory junctions so Developer Mode is not required for that test slice, and guidebook/runbook PDF generation now prefers Unicode-capable system fonts from `%WINDIR%\Fonts` so Cyrillic does not degrade into mojibake.

## Repo-Level Validation

- `make doctor` — env, Telegram auth, webhook state, basic runtime checks
- `make test` — full automated suite
- `npm run guidebook:build -- --language rus --output /tmp/guidebook-rus.pdf` — manual PDF build for the beginner guidebook
- `node --test test/telegram-command-parsing.test.js test/telegram-status-view.test.js` — fast pure-surface checks for command parsing and status rendering ownership
- `node --test test/codex-limits.test.js` — focused Codex limits parsing/cache behavior, including stale-fast UI reads with background refresh
- `node --test test/telegram-callback-batch-ack.test.js` — focused callback fast-path coverage so batch-level early acks stay best-effort and non-breaking
- `node --test test/telegram-control-panels.test.js test/telegram-global-control-input.test.js test/telegram-topic-control-panels.test.js test/telegram-topic-control-input.test.js` — focused global and topic panel ownership, including callback, recreate, lifecycle, and pending reply-input paths
- `node --test test/control-panel-store.test.js test/telegram-file-directive.test.js test/telegram-reply-normalizer.test.js` — focused control-panel store serialization and Telegram transport normalization regressions, including CRLF input paths
- `node --test test/telegram-control-surface.test.js test/telegram-session-ops.test.js` — focused `/clear`, `/new`, `/diff`, `/compact`, and `/purge` ownership slices
- `node --test test/command-router.test.js test/telegram-surface-settings.test.js test/telegram-surface-reference.test.js test/telegram-prompt-flow.test.js test/telegram-prompt-auto.test.js test/telegram-prompt-starts.test.js test/telegram-prompt-queue.test.js test/telegram-prompt-buffering.test.js test/telegram-prompt-attachments.test.js test/telegram-prompt-wait.test.js` — router spine, command-surface ownership, and split prompt-ingress coverage
- `node --test test/run-update-processing.test.js test/run-stale-run-recovery.test.js test/run-maintenance.test.js test/run-rollout-controller.test.js test/run-background-jobs.test.js` — focused poll bootstrap, stale-running startup recovery, run-once maintenance, rollout control, background timer ownership, offset persistence, and forwarded-vs-local update processing coverage for the Spike runtime shell
- `node --test test/codex-runner.test.js test/codex-runner-common.test.js test/codex-runner-lifecycle.test.js test/codex-runner-recovery.test.js` — focused codex-runner ownership slices for helper exports, live turn lifecycle, and rollout recovery
- `node --test test/service-generation-store.test.js test/service-rollout.test.js test/service-rollout-command.test.js test/update-forwarding-ipc.test.js test/spike-update-routing.test.js` — focused session-aware rollout slices for leader lease, retiring-session ownership, repo-local operator rollout handoff, local IPC forwarding, and topic route resolution
- `node --test test/worker-pool.test.js test/worker-pool-startup.test.js test/worker-pool-file-delivery.test.js test/worker-pool-delivery.test.js test/worker-pool-live-steer.test.js test/worker-pool-shutdown.test.js` — focused worker-pool ownership slices for startup, delivery, live steer, and shutdown behavior
- `node --test test/prompt-queue.test.js` — focused `/q` queue semantics, including busy-retry after finalization and corrupt-queue quarantine
- `node --test test/omni-coordinator.test.js test/omni-coordinator-*.test.js test/omni-decision.test.js test/omni-memory.test.js test/omni-prompt-handoff.test.js test/session-compactor.test.js` — focused Omni v2 coverage with a compact coordinator spine plus split setup/cycle/input/sleep/shutdown ownership
- `node --test test/zoo-service.test.js test/zoo-service-menu.test.js test/zoo-service-add-flow.test.js test/zoo-service-refresh.test.js test/zoo-render.test.js test/zoo-analysis.test.js test/zoo-model-response.test.js test/zoo-store.test.js` — focused Zoo ownership slices for topic/menu, missing-topic-state callback recovery, add-flow, refresh, render, and store behavior
- `make smoke` — focused Spike smoke path
- `make smoke-omni` — focused Omni smoke path
- `make soak` — multi-topic concurrency validation

`make smoke`, `make smoke-omni`, `make soak`, and `make service-*` are Linux/operator flows. On native Windows, stay on the direct wrapper path unless you intentionally add your own Windows service wrapper.

## Live User Testing

```bash
make user-login
make user-status
```

Native Windows equivalent:

```powershell
scripts\windows\user-login.cmd
scripts\windows\user-status.cmd
scripts\windows\user-e2e.cmd
```

The built-in `user-login` flow now uses the repo's own Node prompt helper for phone/code/password entry instead of the old third-party `input`/`inquirer` stack. That keeps the operator UX the same while removing stale transitive dependencies from the production graph.

That flow stores the real Telegram user session under:

- `state/.../live-user-testing/telegram-user.env`
- `state/.../live-user-testing/telegram-user-session.txt`
- `state/.../live-user-testing/telegram-user-account.json`

## Zoo Manual Sanity

Once the user-status check is healthy:

1. Run `/zoo`.
2. Confirm the pinned Zoo menu is still menu-only.
3. Confirm duplicate repo buttons keep the `[priv]` and `[pub]` suffixes visible.
4. Open one pet and verify the card appears without extra chatter in the topic.
5. Confirm the stat block includes trend arrows and the lower detail text stays collapsed behind the expandable quote.
6. Tap `Back`, then `Respawn menu`, and confirm the menu comes back cleanly.

## Topic `/menu` Manual Sanity

Once the bot is running in a normal work topic:

1. Run `/menu`.
2. Run `/menu@YourBot`.
3. Confirm a fresh menu appears near the latest messages.
4. Confirm the replaced menu disappears instead of piling up.
5. Confirm the Telegram pin service notices do not remain in the topic.
6. Tap the in-menu `Status` button and confirm it renders the same state as `/status`.

## General `/clear` Manual Sanity

Once the bot is running in the forum:

1. In `General`, send `/global`, then `/help` or `/guide` to create obvious clutter.
2. Run `/clear` in `General`.
3. Confirm only the active General menu remains there on success.
4. Confirm `/clear` inside a normal work topic replies with the General-only guidance instead of deleting topic messages.

## Suggested Validation Order

1. `make doctor`
2. `make test`
3. `make smoke`
4. `make smoke-omni` if Omni is enabled
5. live topic testing only after that

Native Windows:

1. `scripts\windows\install.cmd`
2. `scripts\windows\install-codex.cmd`
3. `scripts\windows\doctor.cmd`
4. `scripts\windows\admin.cmd status`
5. `scripts\windows\test.cmd`
6. `scripts\windows\user-status.cmd` if you plan live user-account checks
7. live topic testing only after that

## Test Ownership Notes

- the repo now follows a modular-first ownership model: if code moves into a domain handler, the tests should move with that domain instead of regrowing giant central suites
- keep pure parsing assertions in `test/telegram-command-parsing.test.js`, not in the giant router suite
- keep pure status text assertions in `test/telegram-status-view.test.js`
- keep `/global` menu lifecycle, status/help navigation, and direct callback actions in `test/telegram-control-panels.test.js`
- keep global panel pending reply-input start/apply/clear behavior in `test/telegram-global-control-input.test.js`
- keep control-panel store serialization regressions in `test/control-panel-store.test.js`
- keep the General panel shell/domain split aligned: `global-control-panel.js` for public routing, `global-control-panel-lifecycle.js` for message lifecycle, `global-control-panel-actions.js` for direct mutations, `global-control-panel-input.js` for pending-input flow, and `global-control-panel-view.js` for render/schema work
- keep `/menu`, topic panel callback navigation, status rendering, recreate cleanup, and pin/delete lifecycle in `test/telegram-topic-control-panels.test.js`
- keep topic panel pending reply-input start/apply/clear behavior in `test/telegram-topic-control-input.test.js`
- keep the topic panel shell/domain split aligned: `topic-control-panel.js` for public routing, `topic-control-panel-lifecycle.js` for message lifecycle, `topic-control-panel-actions.js` for direct mutations, `topic-control-panel-input.js` for pending-input flow, and `topic-control-panel-view.js` for render/schema work
- keep shared panel test fixtures in `test-support/control-panel-fixtures.js` instead of re-growing copy-paste setup blocks
- keep `/clear` and other General control-surface behavior in `test/telegram-control-surface.test.js`
- keep `/new`, `/diff`, `/compact`, and `/purge` behavior in `test/telegram-session-ops.test.js`
- keep `SessionService` auto-mode stale/overlap regressions in `test/session-service.test.js`
- keep `SessionStore` lock serialization, `patchWithCurrent()` freshness, and concurrent artifact-count coverage in `test/session-store.test.js`
- keep emergency private-chat allowlist and attachment-flow regressions in `test/emergency-router.test.js`
- keep `/help`, `/guide`, and suffix-help delivery behavior in `test/telegram-surface-reference.test.js`
- keep Telegram file-directive parsing, malformed-block handling, and CRLF fence coverage in `test/telegram-file-directive.test.js`
- keep `/status`, `/limits`, `/language`, `/wait`, `/suffix`, and runtime-setting command behavior in `test/telegram-surface-settings.test.js`
- keep Codex limits parsing, cache refresh semantics, and stale-fast UI reads in `test/codex-limits.test.js`
- keep batch-level callback early-ack behavior in `test/telegram-callback-batch-ack.test.js`
- keep long-poll bootstrap, forwarded-vs-local update dispatch, and IPC forwarding probes in `test/run-update-processing.test.js`
- keep stale-running startup cleanup, including clearing dead thread/rollout resume state and emitting an Omni-visible failed final, in `test/run-stale-run-recovery.test.js`
- keep run-once maintenance ordering in `test/run-maintenance.test.js`
- keep rollout request/reconcile behavior in `test/run-rollout-controller.test.js`
- keep background timer registration and leader-gated scans in `test/run-background-jobs.test.js`
- keep shared prompt-flow helpers in `test-support/prompt-flow-fixtures.js`
- keep the compact prompt ingress spine in `test/telegram-prompt-flow.test.js`
- keep `src/telegram/command-handlers/prompt-flow.js` as the thin public facade and move heavy prompt logic into `prompt-flow-common.js`, `prompt-flow-starts.js`, `prompt-flow-queue.js`, and `prompt-flow-routing.js`
- keep auto-topic prompt gating in `test/telegram-prompt-auto.test.js`
- keep direct prompt starts, suffix application, and captioned starts in `test/telegram-prompt-starts.test.js`
- keep `/q` and suffix command flow coverage in `test/telegram-prompt-queue.test.js`
- keep long-fragment buffering, guard behavior, interrupt cancellation, and buffered busy coverage in `test/telegram-prompt-buffering.test.js`
- keep prompt attachment carry-over and `/q` attachment-scope separation in `test/telegram-prompt-attachments.test.js`
- keep local/global wait-window buffering and manual flush coverage in `test/telegram-prompt-wait.test.js`
- keep Telegram markdown/html normalization, including CRLF input handling, in `test/telegram-reply-normalizer.test.js`
- keep shared codex-runner fixtures in `test-support/codex-runner-fixtures.js`
- keep the compact codex-runner integration spine in `test/codex-runner.test.js`
- keep `src/pty-worker/codex-runner.js` as the thin public shell and move heavy runner logic into `codex-runner-common.js`, `codex-runner-transport.js`, and `codex-runner-recovery.js`
- keep public helper/export coverage in `test/codex-runner-common.test.js`
- keep primary-thread filtering, active-turn refresh, and async finalization coverage in `test/codex-runner-lifecycle.test.js`
- keep disconnect, rollout replay, and recovery fallback coverage in `test/codex-runner-recovery.test.js`
- keep session-aware service rollout coverage in `test/service-generation-store.test.js`, `test/service-rollout.test.js`, `test/service-rollout-command.test.js`, `test/update-forwarding-ipc.test.js`, and `test/spike-update-routing.test.js`
- keep shared worker-pool helpers in `test-support/worker-pool-fixtures.js`
- keep the compact worker-pool integration spine in `test/worker-pool.test.js`
- keep `src/pty-worker/worker-pool.js` as the thin public shell and move heavy worker logic into `worker-pool-transport.js`, `worker-pool-delivery.js`, `worker-pool-lifecycle.js`, and `worker-pool-common.js`
- keep worker startup and resume/bootstrap behavior in `test/worker-pool-startup.test.js`
- keep telegram-file and attachment-delivery coverage in `test/worker-pool-file-delivery.test.js`
- keep progress/final-reply/failure delivery coverage in `test/worker-pool-delivery.test.js`
- keep live-steer, busy/capacity, and late-event coverage in `test/worker-pool-live-steer.test.js`
- keep shutdown and interrupt lifecycle coverage in `test/worker-pool-shutdown.test.js`
- keep shared Omni coordinator helpers in `test-support/omni-coordinator-fixtures.js`
- keep the compact Omni coordinator integration spine in `test/omni-coordinator.test.js`
- keep Omni handoff queue persistence and corrupt-handoff quarantine in `test/omni-prompt-handoff.test.js`
- keep `src/omni/coordinator.js` as the thin public facade and move heavy Omni logic into `coordinator-memory.js`, `coordinator-delivery.js`, `coordinator-decision-flow.js`, and `coordinator-common.js`
- keep fresh-state handoff and patch-shaping coverage in `test/omni-coordinator-delivery.test.js`
- keep `OmniMemoryStore` normalization plus lock/freshness coverage in `test/omni-memory.test.js`
- keep `/auto` setup, initial goal capture, setup delivery fallbacks, and initial handoff coverage in `test/omni-coordinator-setup.test.js`
- keep cycle evaluation, auto-compact, sleep decisions, model/workspace resolution, and stale-final handling in `test/omni-coordinator-cycle.test.js`
- keep blocked resume, `/omni` questions, and operator-input gating in `test/omni-coordinator-input.test.js`
- keep sleep resume scans and operator wake-up behavior in `test/omni-coordinator-sleep.test.js`
- keep interrupted-pause, `/auto off`, queued-handoff clearing, and clean re-arm behavior in `test/omni-coordinator-shutdown.test.js`
- keep shared Zoo helpers in `test-support/zoo-fixtures.js`
- keep the compact Zoo integration spine in `test/zoo-service.test.js`
- keep `src/zoo/service.js` as the thin public facade and move heavy Zoo logic into `service-menu.js`, `service-add-flow.js`, `service-refresh.js`, and `service-common.js`
- keep Zoo topic/menu lifecycle, missing-topic-state callback recovery, stale-menu callback safety, and root/pet screen behavior in `test/zoo-service-menu.test.js`
- keep add-project lookup, confirmation, and duplicate-name reconciliation coverage in `test/zoo-service-add-flow.test.js`
- keep refresh cleanup and deleted-pet recovery coverage in `test/zoo-service-refresh.test.js`
- keep `test/command-router.test.js` focused on the thin router smoke paths such as top-level short-circuits and dispatch
