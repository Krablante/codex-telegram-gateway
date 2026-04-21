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
make admin ARGS='show -1003577434463 12345'
make admin ARGS='pin -1003577434463 12345'
make admin ARGS='unpin -1003577434463 12345'
make admin ARGS='reactivate -1003577434463 12345'
make admin ARGS='purge -1003577434463 12345'
```

Эквивалент для native Windows:

```powershell
scripts\windows\admin.cmd status
scripts\windows\admin.cmd sessions --state parked
scripts\windows\admin.cmd show -1003577434463 12345
scripts\windows\admin.cmd pin -1003577434463 12345
scripts\windows\admin.cmd unpin -1003577434463 12345
scripts\windows\admin.cmd reactivate -1003577434463 12345
scripts\windows\admin.cmd purge -1003577434463 12345
```

`make admin ARGS='status'` теперь ещё показывает реальный `CODEX_BIN_PATH`, `CODEX_CONFIG_PATH` и список MCP server names, распарсенных из этого конфига. Это первый быстрый чек, если кажется, что у Codex внезапно пропал `pitlane`, `tavily` или другой MCP.

## Сервисы

```bash
cd /path/to/codex-telegram-gateway
make service-install
make service-status
make service-logs
make service-rollout
make service-restart
make service-restart-live
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
make service-restart-live
```

`make service-restart-live` теперь каноничный путь для обычного живого рестарта: он перезапускает `Omni`, а `Spike` прокатывает через мягкий session-aware rollout. Raw `systemctl restart codex-telegram-gateway.service` не использовать, если не нужен именно слепой жёсткий рестарт.
Если предыдущий rollout уже успел перевести leader traffic, но retiring generation ещё дренирует retained topics, повторный `make service-restart-live` теперь честно запускает следующий soft rollout вместо фальшивого стопора `already-shifted`.

## Что делать при проблемах

- сначала запускай `make doctor`
- перед слепым рестартом смотри `make admin ARGS='status'`
- если кажется, что пропал `pitlane` или `large_file`, сначала проверь MCP-список через `make admin ARGS='status'`, а потом перепроверь, что в prompt/context используется правильный host-to-`/workspace/...` mirror path
- если сломалась только одна тема, сначала пробуй topic-level `/status`, `/interrupt`, `/purge`
- если live run ещё активен, сначала используй мягкий `service-restart`; к `service-hard-restart` переходи только если нужен именно жёсткий обрыв всего cgroup
- если soft rollout упёрся в timeout из-за ещё активной retained topic, сначала дай этой теме завершиться или прерви её, потом повтори `make service-restart-live` вместо raw `systemctl restart`
- если сломан сам topic path, переключайся в emergency private chat lane
- если тема уже исчезла, используй local admin surface вместо попыток сильнее давить Telegram
- на native Windows для этого используй `scripts\windows\admin.cmd ...`, а не Linux-only `make admin`
- перед ручным редактированием state сверяй `runtime-events.ndjson`, `meta.json`, `exchange-log.jsonl` и `active-brief.md`
- после ручного `/compact` ожидай, что бот сначала обновит `active-brief.md`, сохранив в нём ещё актуальные user rules и delivery instructions, и только потом следующий свежий run стартует из rebuilt brief
- пока этот rebuild идёт, обычные prompt'ы в той же теме намеренно блокируются, чтобы не устроить гонку со fresh-start handoff
- для тяжёлой живой проверки сначала используй `make test-live`, `make user-e2e` и `make user-spike-audit`, а уже потом пытайся руками диагностировать один сломанный topic

## Нюансы восстановления

- если сохранённый `codex_thread_id` больше не резюмится нормально, runtime сначала попробует починить continuity через реальные Codex history surfaces: `thread/list`, `provider_session_id`, rollout metadata и `session_key`; compact recovery остаётся последним bounded fallback, а не первым ходом
- если Omni глобально выключен, старое topic `auto_mode` состояние остаётся на диске, но становится inert
- если `zoo/topic.json` пропал, остался неполным или ушёл в quarantine, живой callback из меню Zoo теперь сам восстанавливает сохранённую chat/topic/menu привязку; до этого симптом выглядел как тихие no-op на Zoo-кнопках или деградация Zoo-топика в обычный session routing
- если Telegram сообщает, что тема недоступна, сессия может перейти в `parked`
- если Telegram потерял исходный reply target для сообщения в теме, доставка в тему откатится к обычному send в ту же тему
- если prompt-вложение больше текущего прямого bot-download лимита, gateway теперь шлёт короткий inline-ответ, что файл слишком большой, и ack'ает update вместо бесконечного повтора одного и того же poll cycle failure
- если финальный ответ Spike упёрся во временный Telegram/network send failure, gateway теперь ретраит именно финальную доставку; если send так и не вернулся, итоговый ответ остаётся видимым в уже существующем progress bubble вместо полного пропадания результата
- если длинный финальный ответ успел отправить часть chunk'ов, а потом сорвался на следующем, Spike final-event metadata теперь сохраняет уже доставленные Telegram message id вместо вида «не дошло ничего»
- если `turn/completed` пришёл раньше реального финального `agentMessage`, runner теперь держит короткое grace-window для этого позднего primary final answer, прежде чем скатиться к generic `Done.` / `Готово.`
- если на native Windows websocket остался жив, но rollout уже записал `task_complete`, runner теперь всё равно может завершить run по этому rollout-сигналу вместо вечного `running`
- если локальный rollout-forwarding IPC упёрся в заблокированный или зарезервированный loopback-порт, сервер теперь пробует следующий candidate port вместо мгновенного фейла на первом bind error
- просроченные parked sessions могут быть auto-purged retention sweep'ом
- heartbeat теперь также показывает generation id, leader/retiring состояние и rollout status для service-level handoff
