# Runbook

## Канонические пути

- repo root: `/path/to/codex-telegram-gateway`
- state root: `${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway`
- runtime env: `${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env`

## Первые проверки

```bash
cd /path/to/codex-telegram-gateway
ENV_FILE=${XDG_CONFIG_HOME:-~/.config}/codex-telegram-gateway/runtime.env make doctor
make admin ARGS='status'
make service-status
make service-logs
```

Полезные live-файлы:

- heartbeat: `${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway/logs/runtime-heartbeat.json`
- events: `${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway/logs/runtime-events.ndjson`
- doctor snapshot: `${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway/logs/doctor-last-run.json`

Если state был создан до private-by-default permissions, один раз почини права:

```bash
chmod -R go-rwx ${XDG_STATE_HOME:-~/.local/state}/codex-telegram-gateway
```

## Основные operator actions

```bash
make run
make smoke
make soak
make service-install
make service-rollout
make service-restart
make service-restart-live
```

`make service-rollout` / `make service-restart` — безопасный soft-rollout.
Для обычного обновления live bot используй `make service-restart-live`.
Перед повторным restart проверь `make admin ARGS='status'`; если rollout уже `requested` или `in_progress`, жди, не запускай второй rollout поверх.

Только last resort:

```bash
make service-hard-restart
```

`make service-hard-restart` используй только для намеренного слепого рестарта, который может оборвать активные runs. Для обычных обновлений не используй сырой `systemctl restart codex-telegram-gateway.service`.

## Проверки host-affinity

```bash
make host-bootstrap
make host-sync
make host-bootstrap-runtime ARGS='--host worker-a'
make host-doctor
make host-remote-smoke ARGS='--host worker-a'
make host-sync-install
make host-sync-status
```

Ожидаемо:

- ready hosts показываются как ready
- unavailable hosts называются явно
- prompt в bound topic fail-closed, а не тихо ребиндится на `controller`
- remote `telegram-file` работает только из translated worktree/cwd allowed roots на bound host, если явно не включён debug system-temp delivery

## Частые проблемы

### Topic пишет, что host unavailable

Это значит: тема привязана к хосту, который сейчас не ready.

Что делать:

1. `make host-doctor`
2. посмотреть конкретную причину failure у хоста
3. либо починить этот host, либо создать новый topic на ready host

Не надо тихо ребиндить сломанную тему.

### Topic потерял binding

Это значит: у сессии больше нет валидного saved execution host.

Runtime специально fail-closed. Создай новую тему из `General` через `/new ...`.

### `/diff` unavailable

Это значит: binding указывает на обычную папку, а не на git repo.

Это не авария runtime. Либо меняй binding, либо просто не используй `/diff` в этой теме.

### `/compact` как будто завис

Проверь:

- run ownership через `/status`
- строки про pressure в `/status` (`auto-compact`, context window и latest usage), чтобы понять, близок ли runtime к compact boundary
- `logs/runtime-events.ndjson`
- не стоит ли у темы `compaction_in_progress`

Помни: `/compact` сначала пересобирает `active-brief.md`, а потом уже сбрасывает continuity для следующего fresh run. У gateway/operator surface нет отдельного synthetic report/continue reset mode; поддерживаемые context-pressure пути — `/compact` и Codex auto-compact.

### В Telegram виден только нейтральный progress

Такой run должен оставаться на нейтральном локализованном статусе, например `Работаю` плюс spinner, пока Codex не emit-ит main-run natural-language progress (`agent_message` progress notes или `reasoning`). Внутренние recovery labels вроде `live-steer-restart` не должны попадать в bubble. Если выглядит мёртвым:

1. смотри `runtime-heartbeat.json`
2. смотри свежие `runtime-events.ndjson`
3. проверь, не идёт ли run без видимых `agent_message`/`reasoning` items и только с внутренним plan/file/tool/subagent/command traffic

User-visible failure replies специально короткие. Raw `codex exec stderr` tails остаются в diagnostics/warnings и не должны попадать в финальную Telegram-ошибку.

### `Codex ran out of room in the model's context window`

Это может быть реальный переполненный thread, stale resume key или внешний upstream pressure у Codex. Дефолтный `exec-json` worker должен сделать один recovery сам:

1. собрать `active-brief.md` через compact
   - source selection описан в `docs/state-contract.md`: full log для small logs, full `compaction-source.md` если small logs имеют pending progress notes, bounded source для oversized logs
2. очистить stale thread/provider continuity
3. один раз повторить latest prompt как fresh `codex exec --json` thread

Если снова падает, смотри `logs/runtime-events.ndjson` на `recovery_kind: context-window-compact`, затем делай gateway `/compact` вручную или новый `/new` topic, если upstream продолжает отдавать эту ошибку. Не считай отправку `/compact` внутрь `codex exec --json resume` стабильным noninteractive recovery API.

### Remote exec-json topic падает на SSH/path setup

Дефолтный remote path — прямой `ssh -T <host> codex exec --json`, не JSON-RPC host executor. Проверь:

- `/status` с backend и bound host
- `make host-doctor`
- `make host-remote-smoke ARGS='--host <id>'`
- registry поля host: `ssh_target`, `workspace_root`, `worker_runtime_root`, `codex_bin_path`, `codex_config_path`, `codex_auth_path` и `default_binding_path`
- `logs/runtime-events.ndjson`

`node src/cli/host-executor.js --stdio-jsonrpc` относится только к fallback app-server backend.

### `codex app-server` вышел с кодом `0`

Это относится только к `CODEX_GATEWAY_BACKEND=app-server` и `CODEX_ENABLE_LEGACY_APP_SERVER=1`.

Нормальная трактовка зависит от момента:

- после финального ответа graceful exit — это обычное завершение
- до финального ответа это надо трактовать как resumable transport loss, а не как автоматический crash

Если у run уже был `thread id`, сначала жди resume/recovery path и только потом считай, что сломан worker или gateway.

### Exec backend не сделал live steer для follow-up

Для дефолтного `exec-json` это больше не ожидаемо. Busy plain follow-up должен приниматься как live steer: gateway добавляет его в логический run, прерывает активный exec process и resume-ит Codex thread с объединённым prompt. `/q` остаётся явной очередью на следующий turn.

Проверь:

- ответил ли Telegram сообщением о принятом live steer или deferred queue
- строку `backend` в `/status`
- `logs/runtime-events.ndjson` с `backend: exec-json`
- был ли текущий exec process прерван и запустился ли same-thread retry/recovery
- для `exec-json` steer-triggered child exit может выглядеть как `code=1, signal=null`; если steer был запрошен и fatal JSONL event не пришёл, это controlled upstream interruption для resume, а не пользовательский failure `stream ended before turn.completed`

## Ручная чистка state

Сначала предпочитай `/purge` из самого topic.

Если всё же нужен ручной осмотр, session dirs лежат тут:

```text
state/.../sessions/<chat-id>/<topic-id>/
```

Полезные файлы:

- `meta.json`
- `exchange-log.jsonl`
- `progress-notes.jsonl`
- `active-brief.md`
- `compaction-source.md`
- `spike-prompt-queue.json`
- `incoming/`
- `artifacts/`
- `topic-control-panel.json`

Legacy-следы удалённой autonomy-логики ещё могут встречаться в старом state, но runtime теперь их strip/ignore во время normalization.
