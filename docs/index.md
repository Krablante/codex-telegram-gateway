# Codex Telegram Gateway Docs

Use this page as the doc entrypoint instead of treating `README.md` as the full manual.

## Core docs

- [../CHANGELOG.md](../CHANGELOG.md) — factual operator-facing change history
- [architecture.md](./architecture.md) — system shape, module ownership, runtime flow
- [telegram-surface.md](./telegram-surface.md) — commands, menus, waits, suffixes, rendering, delivery
- [deployment.md](./deployment.md) — env model, services, multi-host bootstrap
- [state-contract.md](./state-contract.md) — mutable state under `the configured state root/...`
- [testing.md](./testing.md) — automated, live, and operator validation
- [runbook.md](./runbook.md) / [runbook-rus.md](./runbook-rus.md) — operator troubleshooting and recovery
- [setup.md](./setup.md) — first-time setup path for a single operator

## Operator / user-facing docs

- [guidebook-eng.md](./guidebook-eng.md) / [guidebook-rus.md](./guidebook-rus.md) — source markdown for `/guide`
- [zoo-concept.md](./zoo-concept.md) — Zoo topic concept

## Recommended read order

1. [architecture.md](./architecture.md)
2. [telegram-surface.md](./telegram-surface.md)
3. [deployment.md](./deployment.md)
4. [setup.md](./setup.md)
5. [testing.md](./testing.md)
6. [../CHANGELOG.md](../CHANGELOG.md)
7. [runbook.md](./runbook.md) or [runbook-rus.md](./runbook-rus.md) when operating the live service
