# Telegram Surface

## Topic Model

- one Telegram topic maps to one session
- normal prompts go to `Spike`
- operator private chat is a separate emergency lane
- when `/auto` is active, `Omni` becomes the operator-facing supervisor for that topic

## Command Surface

Spike-only mode:

- `/help`
- `/guide`
- `/new`
- `/status`
- `/global`
- `/menu`
- `/language`
- `/q`
- `/wait`
- `/suffix`
- `/model`
- `/reasoning`
- `/interrupt`
- `/diff`
- `/compact`
- `/purge`

`/help` sends the visual help card as two separate file attachments.

`/guide` works in `General` only and sends the beginner PDF guidebook in the selected `General` language.

`/global` works only in `General`. It opens one persistent inline-button control panel there.

The panel keeps the menu message alive and sends separate status/error messages into `General` after each applied action.

The selected panel language also drives `General`-only replies for commands that do not have a topic session, such as `/help`, `/status`, `/wait global ...`, and other global-setting commands.

Current panel coverage:

- `/wait global ...`
- `/suffix global ...`
- `/model global ...`
- `/reasoning global ...`
- `/omni_model global ...`
- `/omni_reasoning global ...`
- interface language switch for the `General` control panel
- `/help` card delivery from the same menu

Stable values are handled directly by buttons. Free-form values such as the global suffix text or a custom global wait value are entered by replying to the pinned menu message.

`/menu` works only inside a topic. It opens or recreates one persistent topic-local control panel there and pins it again.

New topics created via `/new` now get that local menu automatically right after the bootstrap message.

Binding rules for `/new`:

- `/new Topic Name` starts from `DEFAULT_SESSION_BINDING_PATH`
- if `DEFAULT_SESSION_BINDING_PATH` is unset, it falls back to `WORKSPACE_ROOT`
- `/new cwd=backend/api Topic Name` resolves `backend/api` relative to `WORKSPACE_ROOT`
- `/new cwd=/absolute/path Topic Name` uses that absolute path directly

Current local panel coverage:

- `/wait ...` for the current topic
- `/suffix ...` for the current topic
- `/suffix topic on|off`
- `/model ...`
- `/reasoning ...`
- `/omni_model ...`
- `/omni_reasoning ...`
- interface language switch for the topic
- `/help` card delivery from the same menu

Spike + Omni mode adds:

- `/auto`
- `/omni`
- `/omni_model`
- `/omni_reasoning`

## Prompt Buffering

Local one-shot mode:

- `/wait 60`
- `/wait 1m`
- applies only to the next prompt in the current topic
- resets automatically after that prompt is sent

`/new` inherits the current interface language from the source topic, or from the `General` control panel when it is launched there.

Global persistent mode:

- `/wait global 60`
- `/wait global 1m`
- persists across topics for the same chat/user
- stays active until `/wait global off`

Rules:

- local wait wins over global wait in its topic
- each new fragment resets the timer
- `Все`, `Всё`, or `All` flushes the active buffered prompt immediately

## Prompt Queue

- `/q <text>` — put a Spike prompt into the topic queue
- `/q status` — show queued items with short previews
- `/q delete <position>` — remove one queued item by 1-based position
- queued prompts may include the same Telegram attachments as normal prompts
- attachment-only `/q` files stay reserved for the next `/q ...` text and are not consumed by a plain direct Spike prompt
- long `/q ...` messages and media groups use the same fragment buffering path before they are queued
- if nothing is running in the topic and the queue was empty, `/q` is enqueued and then drained immediately, so it starts a new run right away
- if a run is still in the short finalizing window, `/q` stays queued and starts on the next drain after teardown
- otherwise queued prompts start in FIFO order right after the current run finishes
- `/q` is Spike-only and stays unavailable while `/auto` owns the topic

## Prompt Suffixes

- `/suffix <text>` — topic-local suffix
- `/suffix global <text>` — persistent global suffix
- `/suffix topic off` — disable suffix application for this topic
- `/suffix topic on` — re-enable suffix application

Topic suffix overrides global suffix.

## Runtime Controls

Spike:

- `/model [show|list|clear|<slug>]`
- `/model global [show|list|clear|<slug>]`
- `/reasoning [show|list|clear|<level>]`
- `/reasoning global [show|list|clear|<level>]`

Omni:

- `/omni_model [show|list|clear|<slug>]`
- `/omni_model global [show|list|clear|<slug>]`
- `/omni_reasoning [show|list|clear|<level>]`
- `/omni_reasoning global [show|list|clear|<level>]`

`/status` shows the effective profile after topic/global/default merge.

## Rendering And Delivery

Visible replies are normalized into Telegram-safe HTML.

Preserved well:

- headings
- quotes
- inline code
- fenced code blocks
- bold / italic / underline
- external links
- readable nested lists

Transport-specific rules:

- local file refs collapse to short labels instead of leaking full host paths
- topic replies prefer replying to the triggering message, but fall back to a plain topic send if that reply target disappeared
- fenced `telegram-file` blocks with `action: send` trigger file delivery into the current topic
- delivery roots are limited to the current worktree, the session state dir, and `/tmp`

## UI Language

- `/language rus`
- `/language eng`

This affects help, status, progress/failure text, and other operator-facing replies.
