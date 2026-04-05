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
- `/clear`
- `/new`
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

`/help` sends the visual help card as two separate file attachments.

`/guide` works in `General` only and sends the beginner PDF guidebook in the selected `General` language.

`/clear` works in `General` only. It preserves the active global menu message and its current screen, then removes the tracked General clutter that the bot knows about. Successful cleanup stays silent; separate General messages are reserved for real cleanup errors.

`/zoo` ensures that one dedicated Zoo topic exists, opens or recreates the pinned Zoo menu there, syncs that topic to the caller UI language, and keeps that topic reserved for Zoo-only flows.

Zoo pets are stored against resolved project-root directories, not arbitrary file paths, and `Remove` is disabled while a pet refresh is in flight.

Zoo is menu-only in the normal case: the pinned menu message carries the add-project flow, confirmation flow, pet card, refresh state, and root-list pagination. Separate topic messages are reserved for actual errors.

Zoo cards are localized to the Zoo topic language, use explicit creature personality and stable temperament roles, render the gameplay stats in a monospaced block above the summary text with previous-vs-current trend arrows, keep findings out of the Telegram card itself, intentionally keep the inline buttons in English, assign new pets from a random unused-first identity pool so the stable does not fill in a predictable list order, normalize duplicate repo names to path-based labels with `[priv]` or `[pub]` when private/public twins exist, and place the lower narrative/detail section inside a collapsed-by-default expandable quote.

Telegram bots do not have true arbitrary text animation for editable menu panels, so Zoo uses sparse ASCII frame swaps instead of high-frequency animation. While a pet detail screen stays open, the ASCII pose should keep moving slowly even when the pet is idle. During refresh, the first frame may use a simple generic status, but later refresh frames should fall into the pet's species-plus-temperament voice. The creature pool and temperament pool are intentionally broad so different repos can land on different pet styles, roles, and animation frames.

`/limits` shows the current Codex limits snapshot. On capped accounts it reports the live `5h` and `7d` windows; on unlimited accounts it says so directly instead of showing an unavailable placeholder.

`/global` works only in `General`. It opens one persistent inline-button control panel there.

The panel keeps the menu message alive and sends separate status/error messages into `General` after each applied action.

The root screen now starts with `Bot Settings` and `Language`, then puts `Guide` and `Help` directly beneath them before the lower `Wait` / `Suffix` and `Zoo` / `Clear` operator rows.

The selected panel language also drives `General`-only replies for commands that do not have a topic session, such as `/help`, `/status`, `/wait global ...`, and other global-setting commands.

The service also tracks incoming and outgoing `General` messages in a small ledger so `/clear` can remove them later while preserving the current menu message.

Current panel coverage:

- `/wait global ...`
- `/suffix global ...`
- `Bot Settings` submenu for Spike and Omni model/reasoning screens
- live limits summary on the root screen
- interface language switch for the `General` control panel
- `Zoo` button that opens or refreshes the dedicated Zoo topic/menu
- `Clear` button that runs the same General cleanup as `/clear`
- `Guide` button that sends the same `/guide` beginner PDF from `General`
- `/help` card delivery from the same menu

Stable values are handled directly by buttons. Free-form values such as the global suffix text or a custom global wait value are entered by replying to the pinned menu message.

`/menu` works only inside a topic. It opens or recreates one persistent topic-local control panel there, repins it, removes the replaced menu, and cleans up the transient Telegram pin notices. Telegram-style command suggestions such as `/menu@YourBot` are accepted too.

New topics created via `/new` now get that local menu automatically right after the bootstrap message.
Explicit `/new cwd=...` bindings also accept quoted paths, so Windows paths with spaces work too, for example `/new cwd="C:/Users/Example User/Source Repos" Audit topic`.

Current local panel coverage:

- inline `Status` screen with the same status text as `/status`, rendered inside the menu itself
- `/wait ...` for the current topic
- `/suffix ...` for the current topic
- `/suffix topic on|off`
- `Bot Settings` submenu for topic-local Spike and Omni model/reasoning screens
- compact effective bot summaries on the root screen, rendered like `spike: gpt-5.4 (xhigh)`
- topic command buttons for `/compact`, `/interrupt`, and `/purge`
- live limits summary on the root screen

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
- plain follow-up text during an active Spike run is live-steered into that same run; use `/q` only when you explicitly mean "do this next after the current run"
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

`/status` shows the effective profile after topic/global/default merge and includes the same live limits summary that the root menus use.

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
- delivery roots are limited to the current worktree, the session state dir, and the system temp dir

## UI Language

- `/language rus`
- `/language eng`

This affects help, status, progress/failure text, and other operator-facing replies.
