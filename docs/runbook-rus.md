# Runbook для Codex Telegram Gateway

Используй этот файл для живой эксплуатации и восстановления. Детали продуктовой поверхности вынесены в отдельные docs:

- [telegram-surface.md](./telegram-surface.md)
- [omni-auto.md](./omni-auto.md)
- [deployment.md](./deployment.md)
- [testing.md](./testing.md)

## Быстрые проверки в репо

```bash
cd /path/to/codex-telegram-gateway
make admin ARGS='status'
make admin ARGS='sessions --state parked'
make doctor
make test
```

## Ручной foreground run

```bash
cd /path/to/codex-telegram-gateway
make run
```

Если включён Omni:

```bash
cd /path/to/codex-telegram-gateway
make run-omni
```

Native Windows:

```powershell
cd O:\workspace\codex-telegram-gateway
copy .env.example .env
scripts\windows\install.cmd
scripts\windows\install-codex.cmd
scripts\windows\doctor.cmd
scripts\windows\admin.cmd status
scripts\windows\run.cmd
scripts\windows\run-omni.cmd
```

На native Windows используй wrapper scripts, а не голый `npm` внутри PowerShell.

## Где смотреть runtime

- heartbeat: `${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway/logs/runtime-heartbeat.json`
- events: `${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway/logs/runtime-events.ndjson`
- doctor snapshot: `${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway/logs/doctor-last-run.json`
- per-session exchange log: `.../sessions/<chat-id>/<topic-id>/exchange-log.jsonl`
- per-session brief: `.../sessions/<chat-id>/<topic-id>/active-brief.md`

Признаки здорового runtime:

- `lifecycle_state: running`
- свежий `observed_at`
- вменяемый `active_run_count`
- ожидаемые usernames ботов и forum chat id

## Локальная admin-поверхность

Используй repo-local admin CLI, когда тема уже parked или удалена и Telegram-команды до неё больше не доходят:

```bash
cd /path/to/codex-telegram-gateway
make admin ARGS='status'
make admin ARGS='sessions --state parked'
make admin ARGS='show <chat-id> <topic-id>'
make admin ARGS='pin <chat-id> <topic-id>'
make admin ARGS='unpin <chat-id> <topic-id>'
make admin ARGS='reactivate <chat-id> <topic-id>'
make admin ARGS='purge <chat-id> <topic-id>'
```

Эквивалент для native Windows:

```powershell
scripts\windows\admin.cmd status
scripts\windows\admin.cmd sessions --state parked
scripts\windows\admin.cmd show <chat-id> <topic-id>
scripts\windows\admin.cmd pin <chat-id> <topic-id>
scripts\windows\admin.cmd unpin <chat-id> <topic-id>
scripts\windows\admin.cmd reactivate <chat-id> <topic-id>
scripts\windows\admin.cmd purge <chat-id> <topic-id>
```

## Сервисы

```bash
cd /path/to/codex-telegram-gateway
make service-install
make service-status
make service-logs
make service-rollout
make service-restart
make service-hard-restart
```

Если `service-install` не может определить `CODEX_BIN_PATH`, задай абсолютный путь к бинарнику и повтори установку. На native Windows практичный дефолт такой: оставь `CODEX_BIN_PATH` пустым, чтобы runtime взял `codex.cmd`; если задаёшь вручную, предпочитай `codex.cmd` или абсолютный путь до `...\codex.cmd`.

`make service-rollout` и `make service-restart` для `Spike` теперь идут через session-aware soft rollout: repo-local rollout-команда ждёт, пока новый generation реально возьмёт leader traffic, а уже активные run topics добегают на retiring generation. `make service-hard-restart` оставлен как слепой жёсткий рестарт. Для `service-install` у Spike теперь нужен `systemd >= 250`, потому что unit опирается на `ExitType=cgroup`.

Если включён Omni:

```bash
make service-install-omni
make service-status-omni
make service-logs-omni
make service-restart-omni
```

## Что делать при проблемах

- сначала запускай `make doctor`
- перед слепым рестартом смотри `make admin ARGS='status'`
- если сломалась только одна тема, сначала пробуй topic-level `/status`, `/interrupt`, `/purge`
- если live run ещё активен, сначала используй мягкий `service-restart`; к `service-hard-restart` переходи только если нужен именно жёсткий обрыв всего cgroup
- если сломан сам topic path, переключайся в emergency private chat lane
- если тема уже исчезла, используй local admin surface вместо попыток сильнее давить Telegram
- на native Windows для этого используй `scripts\windows\admin.cmd ...`, а не Linux-only `make admin`
- перед ручным редактированием state сверяй `runtime-events.ndjson`, `meta.json`, `exchange-log.jsonl` и `active-brief.md`
- после ручного `/compact` ожидай, что следующий свежий run будет стартовать из `active-brief.md`

## Нюансы восстановления

- если сохранённый `codex_thread_id` больше не резюмится нормально, runtime один раз попробует retry и только потом уйдёт в compact recovery
- если Omni глобально выключен, старое topic `auto_mode` состояние остаётся на диске, но становится inert
- если Telegram сообщает, что тема недоступна, сессия может перейти в `parked`
- если Telegram потерял исходный reply target для сообщения в теме, доставка в тему откатится к обычному send в ту же тему
- просроченные parked sessions могут быть auto-purged retention sweep'ом
- heartbeat теперь также показывает generation id, leader/retiring состояние и rollout status для service-level handoff
