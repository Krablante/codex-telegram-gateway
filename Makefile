# Codex Telegram Gateway — Makefile

ENV_FILE ?= .env
NODE ?= node

.PHONY: config doctor host-bootstrap host-bootstrap-runtime host-doctor host-remote-smoke host-sync host-sync-install host-sync-status run smoke soak lint typecheck check-syntax test test-exec test-cleanup hygiene hygiene-knip hygiene-depcheck hygiene-audit test-live test-live-exec test-live-app-server user-login user-status user-e2e user-spike-audit admin service-install service-status service-logs service-rollout service-restart service-restart-live service-hard-restart

config:
	@test -f "$(ENV_FILE)" || { \
		echo "Missing runtime env: $(ENV_FILE)" >&2; \
		echo "Set ENV_FILE=/path/to/runtime.env or bootstrap a repo-local .env from .env.example." >&2; \
		exit 1; \
	}

doctor: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/doctor.js

host-bootstrap: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/host-bootstrap.js

host-bootstrap-runtime: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/host-bootstrap-runtime.js $(ARGS)

host-doctor: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/host-doctor.js

host-remote-smoke: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/host-remote-smoke.js $(ARGS)

host-sync: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/host-sync.js

host-sync-install: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/install-host-sync-timer.js

host-sync-status:
	systemctl --user --no-pager --full status codex-telegram-gateway-host-sync.timer

run: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/run.js

smoke: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/run-smoke.js

soak: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/soak.js

lint:
	npm run lint

typecheck:
	npm run typecheck

check-syntax:
	$(NODE) scripts/check-syntax.mjs

test:
	$(NODE) scripts/run-node-tests.mjs $(ARGS)

test-exec:
	$(NODE) scripts/run-node-tests.mjs --suite exec $(ARGS)

test-cleanup:
	$(NODE) scripts/run-node-tests.mjs --cleanup-only $(ARGS)

hygiene-knip:
	npm run hygiene:knip

hygiene-depcheck:
	npm run hygiene:depcheck

hygiene-audit:
	npm audit --omit=dev --audit-level=moderate

hygiene: hygiene-knip hygiene-depcheck hygiene-audit

test-live: test-live-exec

test-live-exec: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/run-live-tests.js --exec-json $(ARGS)

test-live-app-server: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/run-live-tests.js --app-server $(ARGS)

user-login: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/user-login.js

user-status: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/user-status.js

user-e2e: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/user-live-e2e.js

user-spike-audit: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/user-live-spike-audit.js

admin: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/admin.js $(ARGS)

service-install: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/install-user-service.js

service-status:
	systemctl --user --no-pager --full status codex-telegram-gateway.service

service-logs:
	journalctl --user -u codex-telegram-gateway.service -n 100 --no-pager

service-rollout:
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/service-rollout.js

service-restart: service-rollout

service-restart-live: service-rollout

service-hard-restart:
	systemctl --user restart codex-telegram-gateway.service
