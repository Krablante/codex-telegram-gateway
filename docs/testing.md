# Testing

## Fast Local Checks

Linux/macOS:

```bash
make doctor
make test
```

Native Windows:

```powershell
scripts\windows\install.cmd
scripts\windows\doctor.cmd
scripts\windows\test.cmd
```

## GitHub Actions CI

The public repo now runs a small CI workflow on push and pull request:

- Ubuntu: `npm test`
- Ubuntu: guidebook PDF build as a safe smoke check
- Windows: `scripts\windows\install.cmd` + `scripts\windows\test.cmd`

The live `make smoke` and `make smoke-omni` flows stay out of GitHub Actions on purpose. They expect a real `.env`, real Telegram credentials, and a host where short polling is acceptable.

## Repo-Level Validation

- `make doctor` — env, Telegram auth, webhook state, basic runtime checks
- `make test` — full automated suite
- `npm run guidebook:build -- --language rus --output /tmp/guidebook-rus.pdf` — manual PDF build for the beginner guidebook
- `node --test test/prompt-queue.test.js` — focused `/q` queue semantics, including busy-retry after finalization
- `node --test test/omni-*.test.js test/session-compactor.test.js` — focused Omni v2 + auto-compact slice
- `make smoke` — focused Spike smoke path
- `make smoke-omni` — focused Omni smoke path
- `make soak` — multi-topic concurrency validation

`make smoke`, `make smoke-omni`, `make soak`, and `make service-*` are Linux-first flows. On native Windows, stay on the direct wrapper path unless you intentionally add your own Windows service wrapper.

## Live User Testing

```bash
make user-login
make user-status
```

Native Windows equivalent:

```powershell
scripts\windows\user-login.cmd
scripts\windows\user-status.cmd
```

That flow stores the real Telegram user session under:

- `state/.../live-user-testing/telegram-user.env`
- `state/.../live-user-testing/telegram-user-session.txt`
- `state/.../live-user-testing/telegram-user-account.json`

## Zoo Manual Sanity

Once `make user-status` is healthy:

1. Run `/zoo`.
2. Confirm the pinned Zoo menu is still menu-only.
3. Confirm duplicate repo buttons keep the `[priv]` and `[pub]` suffixes visible.
4. Open one pet and verify the card appears without extra chatter in the topic.
5. Confirm the stat block shows visible trend markers and the lower detail text stays collapsed behind the expandable quote.
6. Tap `Back`, then `Respawn menu`, and confirm the menu comes back cleanly.

## General `/clear` Manual Sanity

Once the bot is running in the forum:

1. In `General`, send `/global`, then `/help` or `/guide` to create obvious clutter.
2. Run `/clear` in `General`.
3. Confirm only the active General menu remains there on success.
4. Confirm `/clear` inside a normal work topic replies with the General-only guidance instead of deleting topic messages.

## Suggested Validation Order

Linux/macOS:

1. `make doctor`
2. `make test`
3. `make smoke`
4. `make smoke-omni` if Omni is enabled
5. live topic testing only after that

Native Windows:

1. `scripts\windows\install.cmd`
2. `scripts\windows\install-codex.cmd`
3. `scripts\windows\doctor.cmd`
4. `scripts\windows\test.cmd`
5. live topic testing only after that
