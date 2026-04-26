# Telegram Surface

## Topic model

- one Telegram topic maps to one session
- each topic session keeps an immutable `execution_host_id` binding
- normal prompts go to `Spike`
- operator private chat is a separate emergency lane

## Command surface

- `/help`
- `/guide`
- `/clear`
- `/new [host=<id>] [cwd=...|path=...] <title>`
- `/hosts`
- `/host`
- `/zoo`
- `/status`
- `/limits`
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

## General / global surface

`General` is the lobby.

- `/global` opens one persistent global menu there
- direct `/new host=<id> ...` binds the requested host explicitly; direct `/new ...` without `host=` binds the configured current/default host, normally `CURRENT_HOST_ID`
- `New Topic` skips host choice only when the host registry has exactly one host; with multiple registered hosts it keeps the picker and offers only ready hosts, even if only one host is currently ready
- `Hosts` shows the fleet overview
- `Bot Settings` exposes global Spike model/reasoning plus the separate `/compact` summarizer profile
- model menus there show only list-visible models from the current Codex catalog/cache
- `Guide`, `Help`, `Zoo`, and `Clear` are available from the same menu
- the selected global UI language also drives `General`-only replies such as `/guide`, `/help`, `/wait global ...`, and `/status`
- menu text input is single-menu-first: after tapping Custom/Set text/New Topic, the next plain text message from the requesting operator is consumed; reply-to-menu still works as compatibility
- pending-input prompts, validation errors, and confirmations are rendered inside the menu message instead of as separate bot messages when the menu can be edited

`/clear` works in `General` only. It preserves the active global menu and removes tracked General clutter.

## Topic / menu surface

`/menu` works only inside a topic.

Current topic panel coverage:

- `Status`
- topic-local `Wait`
- topic-local `Suffix`
- `suffix topic on|off`
- `Bot Settings` for topic-local Spike model/reasoning
- host-bound topic model menus resolve against that bound host's Codex catalog when the host publishes its own `codex_config_path`; on `controller`, remote-host catalogs ride through mirrored `models_cache.json` snapshots under `codex-space/hosts/<host-id>/rendered/`
- command buttons for `Compact`, `Interrupt`, and `Purge`
- live limits summary on the root screen

Explicit `/menu` always respawns a fresh visible menu near the current tail, repins it, and removes the replaced one.

After `/purge`, old topic-menu callbacks are treated as expired. The same topic remains usable: the next real plain prompt or flushed non-empty `/q` runnable prompt reactivates a fresh session with cleared run continuity and preserved host/workspace/UI binding. Blank `/q` help, buffered fragments, and attachment-only collection do not pre-create a runnable session.

## Prompt ingress

- plain text inside a topic starts a run
- the default `exec-json` backend live-steers a busy plain follow-up by accepting it, interrupting the active exec process, then resuming the same logical run with the merged prompt; an interrupted child exit from that requested steer is not shown as a user-visible incomplete-stream failure unless Codex emitted an explicit fatal JSONL event
- if live steer cannot be accepted or recovered, the gateway falls back to the next prompt queue instead of wedging the topic
- if `codex exec` hits context-window exhaustion, the worker compacts once using the state-contract source selector, then retries once as a fresh exec-json thread before surfacing failure
- if `codex exec` reports `No tool call found for function call output ...`, the worker treats the native thread as corrupt, compacts once, and retries once as a fresh exec-json thread before surfacing failure
- attachment-first prompts are buffered until the next text arrives
- long Telegram-split prompts and media groups are assembled before start

## Wait windows

Local one-shot mode:

- `/wait 60`
- `/wait 1m`
- applies only to the next prompt in the current topic
- resets automatically after that prompt is sent

Global persistent mode:

- `/wait global 60`
- `/wait global 1m`
- persists across topics for the same chat/user
- stays active until `/wait global off`

Rules:

- local wait wins over global wait in its topic
- each new fragment resets the timer
- `Все`, `Всё`, or `All` flushes the active buffered prompt immediately

## Prompt queue

- `/q <text>` — request explicit next-turn work; if the topic is idle it may start immediately, otherwise it waits FIFO
- `/q status` — show queued items with previews
- `/q delete <position>` — remove one queued item
- queued prompts may include attachments
- attachment-only `/q` files are reserved for the next `/q ...` text and are not consumed by a plain direct prompt
- the queue drains in FIFO order after the active run finishes

## Prompt suffixes and prompt contract

- `/suffix <text>` — topic-local suffix
- `/suffix global <text>` — persistent global suffix
- `/suffix topic off` — disable suffix application for this topic
- `/suffix topic on` — re-enable suffix application

Topic suffix overrides global suffix.

This is the canonical prompt contract:

- stable routing/file-delivery/shared-memory guidance is rendered as a host-aware `Context:` block for each run
- exec-json sends that block as Codex `developer_instructions`, not as ordinary user prompt text
- fallback app-server sends the same block as thread-level `developerInstructions`
- the effective saved `Work Style` rides in the same developer-instructions block too
- the user-turn body stays minimal and only carries `User Prompt:`

The `Context:` block is behavioral, not an inventory dump. It tells the agent:

- which Telegram topic is the default delivery target
- which bound host and cwd to use
- to report host unavailability instead of silently rebinding
- the `/workspace/<workspace-root-basename>` mirror root plus current mirrored cwd for container-backed MCPs
- how to send files back through Telegram
- where to find shared and bound-host operator memory when needed
- when to lazily read the per-topic context file for extra routing/detail

When thread-level context lists `telegram-file` send roots, that line constrains only `telegram-file` delivery sources. It is not a general filesystem sandbox.

## Runtime controls

Spike:

- `/model [list|clear|<slug>]`
- `/model global [list|clear|<slug>]`
- `/reasoning [list|clear|<level>]`
- `/reasoning global [list|clear|<level>]`

Rules:

- model menus and `/model list` show only list-visible models from the current Codex catalog/cache
- hidden/internal models stay out of the operator surface
- stale saved model overrides fall back to an available default
- reasoning choices are limited to levels supported by the currently resolved model

`/compact` uses a separate global model/reasoning pair from `General -> /global -> Bot Settings`. This is a gateway compaction command; the worker does not rely on sending `/compact` into noninteractive `codex exec --json resume`.

`/interrupt` is a stop request. The immediate reply only confirms the request was accepted; the later topic reply or `interrupted` status confirms the run actually settled.

`/status` shows the active backend, effective model/reasoning after topic/global/default merge, the live limits summary, and configured context-pressure knobs such as the auto-compact threshold. Live Spike runs pass those knobs through to Codex; gateway `/compact` uses its own summarizer profile and raises native auto-compact above the context window so bounded-source fallback remains visible to the gateway.

When the Codex profile sets:

```toml
model_context_window = 258000
model_auto_compact_token_limit = 240000
```

the status view surfaces the configured window and threshold so operators can confirm the live context-pressure policy without opening the host config by hand. If an already-running old fallback rollout reports a smaller actual window, `/status` keeps the configured window in the top summary and shows the rollout-reported value separately as `effective context window`.

## Rendering and delivery

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

- local file refs collapse to short labels instead of leaking long host paths
- topic replies prefer replying to the triggering message, but fall back to a plain topic send if that reply target disappeared
- default exec-json visible progress comes from main-run Codex natural-language `agent_message` progress notes and `reasoning` summaries
- fallback app-server progress can use protocol commentary agent messages while debugging that backend
- final replies come from the primary run final answer
- plan/todo, file-change, tool, web-search, command, and subagent events are internal activity and must not be rendered as thoughts
- live steer keeps the current progress bubble unchanged during the interrupt/rebuild gap; lifecycle labels and startup/liveness filler must not overwrite the last visible thought before the next real progress item or final answer
- if a run emits no visible natural-language progress, the progress bubble shows only the spinner marker `...`; liveness belongs in `/status` and runtime events, not synthetic thought text, startup/liveness filler, or internal recovery labels
- fenced `telegram-file` blocks with `action: send` trigger file delivery into the current topic
- local delivery roots are limited to the current worktree and the per-session state dir; remote delivery roots are limited to the translated bound-host worktree/cwd roots; system temp delivery is debug-only via `CODEX_ALLOW_SYSTEM_TEMP_DELIVERY=1`
- on host-bound topics, `telegram-file path:` must be an absolute path on the bound host

## UI language

- `/language rus`
- `/language eng`

General uses the global menu language. Work topics use the topic's stored language.

The selected language covers the visible operator surface:

- `/help` card assets
- `/guide` PDF source and generated file name
- menus and pending-input prompts
- `/status`, `/limits`, `/wait`, `/suffix`, `/model`, `/reasoning`, `/hosts`, and `/host` replies
- progress/failure text from worker runs
- Telegram command catalog entries, with English as the default catalog and Russian under Telegram `language_code=ru`

Known protocol aliases such as `All`, `Все`, and `Всё` may be shown in both languages because all three forms are valid flush commands.
