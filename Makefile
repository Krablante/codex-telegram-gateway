# Codex Telegram Gateway — Makefile

ENV_FILE ?= .env
NODE ?= node

.PHONY: config doctor run run-omni smoke smoke-omni soak test test-live user-login user-status user-e2e user-spike-audit admin service-install service-install-omni service-status service-status-omni service-logs service-logs-omni service-rollout service-restart service-hard-restart service-restart-omni service-restart-live

config:
	test -f "$(ENV_FILE)"

doctor: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/doctor.js

run: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/run.js

run-omni: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/run-omni.js

smoke: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/run-smoke.js

smoke-omni: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/run-smoke.js --omni

soak: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/soak.js

test:
	$(NODE) --test

test-live: config
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/run-live-tests.js

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

service-install-omni: config
	SERVICE_VARIANT=omni ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/install-user-service.js

service-status:
	systemctl --user --no-pager --full status codex-telegram-gateway.service

service-status-omni:
	systemctl --user --no-pager --full status codex-telegram-gateway-omni.service

service-logs:
	journalctl --user -u codex-telegram-gateway.service -n 100 --no-pager

service-logs-omni:
	journalctl --user -u codex-telegram-gateway-omni.service -n 100 --no-pager

service-rollout:
	ENV_FILE="$(ENV_FILE)" $(NODE) src/cli/service-rollout.js

service-restart: service-rollout

service-restart-live:
	@$(MAKE) service-restart-omni
	@$(MAKE) service-rollout

service-hard-restart:
	systemctl --user restart codex-telegram-gateway.service

service-restart-omni:
	systemctl --user restart codex-telegram-gateway-omni.service
