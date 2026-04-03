# Docs

This folder is the human-readable map of the project.

If you are new here, do not start by reading every file in order. Use the path that matches what you are trying to do.

## Start Here

- [../README.md](../README.md) — product overview, quick start, project boundaries
- [setup.md](./setup.md) — the recommended install and first-run path
- [deployment.md](./deployment.md) — runtime shape, env model, user services, Spike-only vs Spike+Omni

## Day-To-Day Use

- [telegram-surface.md](./telegram-surface.md) — commands, menus, buffering, queueing, rendering, file delivery
- [omni-auto.md](./omni-auto.md) — how `/auto` works, what `Omni` does, and what it does not do
- [guidebook-rus.md](./guidebook-rus.md) / [guidebook-eng.md](./guidebook-eng.md) — source markdown for the beginner `/guide` PDF

## Operating The System

- [runbook.md](./runbook.md) — recovery, troubleshooting, local admin flows, safe operations
- [testing.md](./testing.md) — doctor, smoke, soak, focused slices, live-user checks
- [state-contract.md](./state-contract.md) — what the runtime writes to disk and why
- [architecture.md](./architecture.md) — internals, flow, and boundaries

## If You Want To...

| Goal | Read |
| --- | --- |
| get the bot online quickly | [setup.md](./setup.md) |
| understand the Telegram UX | [telegram-surface.md](./telegram-surface.md) |
| decide whether you even need `Omni` | [deployment.md](./deployment.md), [omni-auto.md](./omni-auto.md) |
| debug a broken live instance | [runbook.md](./runbook.md) |
| understand what is persisted and what is rebuilt | [state-contract.md](./state-contract.md) |
| understand the actual runtime flow | [architecture.md](./architecture.md) |

## Recommended Read Order

1. [setup.md](./setup.md)
2. [telegram-surface.md](./telegram-surface.md)
3. [deployment.md](./deployment.md)
4. [omni-auto.md](./omni-auto.md) if you plan to use `/auto`
5. [runbook.md](./runbook.md) when the service becomes live
