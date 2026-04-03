# Codex Telegram Gateway Docs

Use this as the docs entrypoint instead of trying to treat `README.md` as the whole manual.

## Core Docs

- [architecture.md](./architecture.md) — system shape, runtime flow, boundaries
- [state-contract.md](./state-contract.md) — durable state files and what they mean
- [runbook.md](./runbook.md) — live operations, recovery, and failure handling

## Operator Surface

- [telegram-surface.md](./telegram-surface.md) — commands, prompt buffering, queueing, menus, rendering
- [omni-auto.md](./omni-auto.md) — `/auto`, `Omni`, memory, pivots, sleep, blockers
- [guidebook-rus.md](./guidebook-rus.md) and [guidebook-eng.md](./guidebook-eng.md) — source markdown for the beginner `/guide` PDF

## Deployment And Validation

- [setup.md](./setup.md) — compact setup walkthrough
- [deployment.md](./deployment.md) — env model, services, Spike-only vs Spike+Omni
- [testing.md](./testing.md) — doctor, smoke, soak, live-user testing

## Suggested Read Order

1. [setup.md](./setup.md)
2. [architecture.md](./architecture.md)
3. [telegram-surface.md](./telegram-surface.md)
4. [omni-auto.md](./omni-auto.md) if you plan to use `/auto`
5. [runbook.md](./runbook.md) once the service is live
