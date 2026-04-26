# Testing

## Fast local checks

Linux/operator path:

```bash
cd /path/to/codex-telegram-gateway
npm ci
runtime_env="${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env"
state_root="${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway"
install -d -m700 "$(dirname "$runtime_env")" "$state_root"
install -m600 .env.example "$runtime_env"
# Edit runtime.env before doctor if this is a fresh host.
ENV_FILE="$runtime_env" make doctor
make lint
make typecheck
make test
```

Native Windows:

```powershell
cd O:\workspace\codex-telegram-gateway
copy .env.example .env
scripts\windows\install.cmd
scripts\windows\install-codex.cmd
scripts\windows\doctor.cmd
scripts\windows\admin.cmd status
scripts\windows\test.cmd
# Optional live default-backend smoke:
scripts\windows\test-live.cmd
# Fallback app-server debug only:
scripts\windows\test-live-app-server.cmd
```

Native Windows uses the repo-local `.env` by default. `ENV_FILE` still overrides it. Linux service installs should prefer `${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env`; mutable state stays under `${XDG_STATE_HOME:-$HOME/.local/state}/codex-telegram-gateway`.

## Repo-level validation

- `make doctor` — env, Telegram auth, webhook state, basic runtime checks, and Linux user-service freshness/stale-unit checks
- `npm ci` — install pinned Node dependencies before local tests or asset builds
- `npm run test:exec` / `npm run test:live` — package-script aliases for the same default exec-json checks when `make` is not the caller
- `npm run test:live:app-server` — package-script alias for fallback app-server live debugging; the runner injects `CODEX_ENABLE_LEGACY_APP_SERVER=1`
- `make host-bootstrap` — render the canonical host registry preset on `controller`
- `make host-bootstrap-runtime ARGS='--host worker-a'` — prepare a helper-capable remote runtime
- `make host-sync` — render and sync fresh `codex-space` outputs from `controller`
- `make host-doctor` — record host readiness, failure reasons, and `codex-space` freshness
- `make host-remote-smoke ARGS='--host worker-a'` — prove one real host-local `codex exec` run
- `make host-sync-install` — install the `systemd --user` host-sync timer on `controller`
- `make host-sync-status` — inspect that timer
- `make check-syntax` / `npm run check:syntax` — no-dependency JavaScript parser check using `node --check`; keep this as the cheapest syntax-only gate
- `make lint` / `npm run lint` — quick ESLint static-analysis gate over source, scripts, tests, and test-support; it intentionally avoids formatting rules
- `make typecheck` / `npm run typecheck` — quick TypeScript no-emit JS program pass over source, scripts, tests, and test-support; `checkJs` remains off until the JS surface is intentionally annotated
- `make test` / `npm test` — full non-live automated suite through `scripts/run-node-tests.mjs`; default discovery explicitly excludes `*.live.test.js` even if `CODEX_LIVE_TESTS=1` is set in the shell, runs inside an isolated per-run temp root, and removes that root at exit
- `make test-exec` / `npm run test:exec` — focused default-backend checks for local/remote exec argument shape, JSONL parsing, host-aware routing, the local worker-pool exec-json smoke contract, live-steer recovery, context-window and orphan tool-output recovery, stale-run cleanup, and progress-note compaction; the suite list lives in `scripts/run-node-tests.mjs`, and `make test-exec ARGS='...'` forwards Node test flags
- `make test-cleanup ARGS='--cleanup-all'` — explicit cleanup for marker-bearing test temp roots created by `scripts/run-node-tests.mjs`
- `npm run hygiene:knip` — pinned unused files/exports scan; `knip.json` declares CLI, scripts, tests, and test-support helper entrypoints
- `npm run hygiene:depcheck` — pinned dependency reachability scan
- `make hygiene` / `npm run hygiene` — run pinned `knip`, pinned `depcheck`, and production dependency advisory scan
- `make test-live` — alias for the real-Codex `exec-json` live smokes
- `make test-live-exec` — runs `src/cli/run-live-tests.js --exec-json` for the real-Codex `codex exec --json` smoke plus default worker-pool `exec-json` smoke; extra Node test flags pass through with `ARGS='...'`
- `make test-live-app-server` — runs `src/cli/run-live-tests.js --app-server` for legacy app-server live worker-pool debugging; the runner injects `CODEX_ENABLE_LEGACY_APP_SERVER=1`, defaults live runs to `--test-concurrency=1`, and accepts extra Node test flags with `ARGS='...'`
- `make smoke` — focused Spike smoke path
- `make soak` — multi-topic concurrency validation
- `npm run guidebook:build -- --language rus --output /tmp/guidebook-rus.pdf` and `npm run guidebook:build -- --language eng --output /tmp/guidebook-eng.pdf` — manual PDF builds for `/guide`
- `npm run runbook:build -- --language rus --output /tmp/runbook-rus.pdf` and `npm run runbook:build -- --language eng --output /tmp/runbook-eng.pdf` — manual PDF builds for the runbook
- `python3 scripts/generate-help-card.py` — rebuild `/help` card assets under `assets/help/`

Python-only asset helpers need their own image/PDF stack: `scripts/generate-help-card.py` uses Pillow, and `scripts/rasterize-pdf.py` uses PyMuPDF plus Pillow. Install those in your preferred venv or system package layer before regenerating raster artifacts.

Useful focused suites:

- `node scripts/run-node-tests.mjs test/telegram-command-parsing.test.js test/telegram-status-view.test.js`
- `node scripts/run-node-tests.mjs test/telegram-control-panels.test.js test/telegram-global-control-input.test.js test/telegram-topic-control-panels.test.js test/telegram-topic-control-input.test.js`
- `node scripts/run-node-tests.mjs test/telegram-control-surface.test.js test/telegram-session-ops.test.js`
- `node scripts/run-node-tests.mjs test/command-router.test.js test/telegram-surface-settings.test.js test/telegram-surface-reference.test.js test/telegram-prompt-flow.test.js test/telegram-prompt-starts.test.js test/telegram-prompt-queue.test.js test/telegram-prompt-buffering.test.js test/telegram-prompt-attachments.test.js test/telegram-prompt-wait.test.js`
- `node scripts/run-node-tests.mjs test/run-update-processing.test.js test/run-stale-run-recovery.test.js test/run-maintenance.test.js test/run-rollout-controller.test.js test/run-background-jobs.test.js`
- `node scripts/run-node-tests.mjs test/codex-runner.test.js test/codex-runner-common.test.js test/codex-runner-lifecycle.test.js test/codex-runner-recovery.test.js`
- `node scripts/run-node-tests.mjs test/telegram-exec-runner.test.js test/exec-runner.test.js test/host-aware-run-task.test.js`
- `node scripts/run-node-tests.mjs test/telegram-exec-runner.test.js test/worker-pool.test.js test/worker-pool-exec-json-contract.test.js test/worker-pool-startup.test.js test/progress-message.test.js test/session-store.test.js test/session-compactor.test.js` — progress filtering/finalization, local worker-pool exec-json smoke contract, exec-json live-steer recovery, context-window and orphan tool-output compact/fresh-thread recovery, `exec-json-run.jsonl`, `progress-notes.jsonl`, and `compaction-source.md`; verify internal tool/command/file/subagent traffic does not appear as thoughts while main-run natural-language progress stays visible
- `node scripts/run-node-tests.mjs test/service-generation-store.test.js test/service-rollout.test.js test/service-rollout-command.test.js test/update-forwarding-ipc.test.js test/spike-update-routing.test.js`
- `node scripts/run-node-tests.mjs test/worker-pool.test.js test/worker-pool-startup.test.js test/worker-pool-file-delivery.test.js test/worker-pool-delivery.test.js test/worker-pool-live-steer.test.js test/worker-pool-shutdown.test.js`
- `node scripts/run-node-tests.mjs test/zoo-service.test.js test/zoo-service-menu.test.js test/zoo-service-add-flow.test.js test/zoo-service-refresh.test.js test/zoo-render.test.js test/zoo-analysis.test.js test/zoo-model-response.test.js test/zoo-store.test.js`

## Multi-host validation on `controller`

Use this order:

1. `runtime_env="${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env"`
2. `ENV_FILE="$runtime_env" make host-bootstrap`
3. `ENV_FILE="$runtime_env" make host-sync`
4. `ENV_FILE="$runtime_env" make host-bootstrap-runtime ARGS='--host worker-a'`
5. `ENV_FILE="$runtime_env" make host-doctor`
6. `ENV_FILE="$runtime_env" make host-remote-smoke ARGS='--host worker-a'`
7. run one ordinary `worker-a`-bound Spike prompt through the default `exec-json` path
8. verify busy follow-ups live-steer cleanly while the `worker-a` run is active, including the controlled interrupted-child recovery path, and explicit `/q` prompts still queue for the next turn
9. verify a context-window failure on a bound host takes the compact/fresh-thread recovery path once instead of falling back to app-server semantics
10. verify one successful and one refused remote `telegram-file` send in a `worker-a`-bound topic
11. `ENV_FILE="$runtime_env" make host-sync-install`
12. `ENV_FILE="$runtime_env" make host-sync-status`

`host-doctor` expects rendered `codex-space` files to be recent. Run
`host-sync` first if the sync timer has been disabled or the host has been
offline longer than roughly three sync intervals.

## Live user testing

```bash
runtime_env="${XDG_CONFIG_HOME:-$HOME/.config}/codex-telegram-gateway/runtime.env"
export ENV_FILE="$runtime_env"
make user-login
make user-status
make user-e2e
make user-spike-audit
```

`make user-login` creates private user-account live-test files under `STATE_ROOT/live-user-testing/`; keep that directory in state, not in the source repo.

Native Windows equivalent:

```powershell
scripts\windows\user-login.cmd
scripts\windows\user-status.cmd
scripts\windows\user-e2e.cmd
scripts\windows\user-spike-audit.cmd
```

`make user-e2e` / `npm run user:e2e` is the broad real-account sanity path for topic creation, plain prompts, parallel topic pressure, and cleanup.
`make user-spike-audit` / `npm run user:spike-audit` is the narrower heavy Spike-only live audit for interrupt/resume, retained soft rollout, compact, and attachment ingress paths. The audit waits for soft-rollout settling instead of starting a second rollout request on top of an in-progress handoff. It treats a retained run that already completed with the expected token as valid even if owner metadata cleared before observation. Use `SPIKE_AUDIT_TIMEOUT_SECS=<seconds>` to raise all scenario waits for intentionally heavy prompts.

## Suggested validation order

1. `make doctor`
2. `make check-syntax`
3. `make lint`
4. `make typecheck`
5. `make test`
6. `make test-exec`
7. `make hygiene`
8. `make test-live-exec`
9. `make smoke`
10. live topic testing only after that

Native Windows:

1. `scripts\windows\install.cmd`
2. `scripts\windows\install-codex.cmd`
3. `scripts\windows\doctor.cmd`
4. `scripts\windows\admin.cmd status`
5. `npm run check:syntax`
6. `scripts\windows\test.cmd`
7. `scripts\windows\test-live.cmd` for default exec-json
8. `scripts\windows\user-status.cmd` if you plan live user-account checks
9. live topic testing only after that

## Ownership notes

- keep router shells thin
- keep `CHANGELOG.md` updated when validation gates, live-smoke coverage, deployment semantics, or operator-facing runtime behavior changes
- keep tests aligned with the same ownership split as the source tree
- keep control-panel fixtures in `test-support/control-panel-fixtures.js`
- keep prompt-flow fixtures in `test-support/prompt-flow-fixtures.js`
- keep worker-pool fixtures in `test-support/worker-pool-fixtures.js`
- keep Zoo fixtures in `test-support/zoo-fixtures.js`
- removed autonomy behavior should not regain product-facing coverage; only narrow legacy cleanup compatibility checks are acceptable
