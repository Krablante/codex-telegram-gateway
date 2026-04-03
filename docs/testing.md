# Testing

Run these commands from the repo root.

## Fast Local Checks

```bash
make doctor
make test
```

## Repo-Level Validation

- `make doctor` — env, Telegram auth, webhook state, basic runtime checks
- `make test` — automated suite
- `npm run guidebook:build -- --language rus --output /tmp/guidebook-rus.pdf` — manual `/guide` PDF build
- `node --test test/prompt-queue.test.js` — focused `/q` queue semantics, including busy-retry after finalization
- `node --test test/omni-*.test.js test/session-compactor.test.js` — focused Omni + auto-compact slice
- `make smoke` — focused Spike smoke path
- `make smoke-omni` — focused Omni smoke path
- `make soak` — multi-topic concurrency validation

## Live User Testing

```bash
make user-login
make user-status
```

That flow stores the real Telegram user session under:

- `state/.../live-user-testing/telegram-user.env`
- `state/.../live-user-testing/telegram-user-session.txt`
- `state/.../live-user-testing/telegram-user-account.json`

## Suggested Validation Order

1. `make doctor`
2. `make test`
3. `make smoke`
4. `make smoke-omni` if Omni is enabled
5. manual topic testing after that
