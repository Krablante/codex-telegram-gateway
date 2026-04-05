# Codex Telegram Gateway Docs

Use this page as the entrypoint instead of treating `README.md` as the whole product manual.

The repo now follows a modular-first layout: thin central shells, domain handlers, and matching test ownership. `architecture.md` and `testing.md` are the canonical docs for that code-shape contract.

## Core Docs

- [setup.md](./setup.md) — first-time installation and onboarding
- [architecture.md](./architecture.md) — system shape, runtime flow, boundaries
- [state-contract.md](./state-contract.md) — mutable state surfaces under `the configured state root`
- [runbook.md](./runbook.md) and [runbook-rus.md](./runbook-rus.md) — troubleshooting, failure handling, recovery, operator actions

## Operator Surface

- [telegram-surface.md](./telegram-surface.md) — Telegram commands, prompt buffering, suffixes, rendering, file delivery
- [omni-auto.md](./omni-auto.md) — `/auto`, `Omni`, setup flow, phases, sleep, blockers, direct questions
- [zoo-concept.md](./zoo-concept.md) — control-only Zoo topic concept for project tamagotchi cards
- [guidebook-rus.md](./guidebook-rus.md) and [guidebook-eng.md](./guidebook-eng.md) — source markdown for the `/guide` beginner PDF

## Deployment And Validation

- [deployment.md](./deployment.md) — env model, service shape, Spike-only vs Spike+Omni
- [testing.md](./testing.md) — doctor, smoke, soak, live-user testing

## Recommended Read Order

1. [architecture.md](./architecture.md)
2. [setup.md](./setup.md)
3. [telegram-surface.md](./telegram-surface.md)
4. [omni-auto.md](./omni-auto.md) if Omni is enabled
5. [deployment.md](./deployment.md)
6. [runbook.md](./runbook.md) or [runbook-rus.md](./runbook-rus.md) when operating the live service
