# Contributing

## Development flow

1. Keep runtime state out of the repo.
2. Prefer repo entry points over ad hoc commands.
3. Run `make test` before sending changes.
4. Run `make test-live` when touching live transport behavior.

## Local env

- copy `.env.example` to `.env`
- do not commit real bot tokens or operator ids

## Scope

- keep the runtime small and host-oriented
- do not add a generic multi-provider agent platform here
