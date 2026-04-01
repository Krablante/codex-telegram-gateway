# Codex Telegram Gateway — Makefile

ENV_FILE ?= .env
NODE ?= node

.PHONY: config doctor run smoke soak test test-live admin service-install service-status service-logs service-restart

config:
	test -f "$(ENV_FILE)"

doctor: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/doctor.js

run: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/run.js

smoke: config
	TELEGRAM_POLL_TIMEOUT_SECS=1 RUN_ONCE=1 ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/run.js

soak: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/soak.js

test:
	$(NODE) --test

test-live:
	CODEX_LIVE_TESTS=1 $(NODE) --test test/worker-pool.live.test.js

admin: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/admin.js $(ARGS)

service-install: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/install-user-service.js

service-status:
	systemctl --user --no-pager --full status codex-telegram-gateway.service

service-logs:
	journalctl --user -u codex-telegram-gateway.service -n 100 --no-pager

service-restart:
	systemctl --user restart codex-telegram-gateway.service
