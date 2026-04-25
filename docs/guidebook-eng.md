# Spike: newcomer guidebook

This is a short practical guide to the bot. It is not a full flag reference. Think of it as the map you need before the detailed docs.

## Quick start

`General` is the lobby. You usually do three things there:

- open the global menu with `/global`
- create new work topics with `/new [host=<id>] [cwd=...|path=...] <title>`; no `host=` uses the configured current/default host, normally `CURRENT_HOST_ID`, and the global `New Topic` button skips host choice only when the registry has exactly one host
- use shared operator shortcuts such as `/help`, `/guide`, `/hosts`, or `/zoo`

The normal start looks like this:

```text
/new Backend Cleanup
/new host=worker-a cwd=projects/codex-telegram-gateway Gateway Audit
```

Then enter the new topic and send the task as plain text.

## Who does what

`Spike` is the worker. It reads code, edits files, runs commands, and answers the task.

There is no second supervisor bot anymore. The normal path is direct topic work with one worker and one topic-local session.

## Why menus should be your default

The easiest path is:

- use `/global` in `General` for chat-wide settings
- use `/menu` inside a work topic for topic-local settings
- use the pinned menu in `Zoo`

Menus are the safer and faster path for stable settings:

- checking `Status`
- changing UI language
- turning `wait` on or off
- changing Spike model/reasoning
- changing the separate `/compact` summarizer profile
- running `Compact`, `Interrupt`, and `Purge`
- changing suffixes

Practical rule: if you want to change a stable setting, start with a menu.

## What menus do not replace

Menus do not replace the work itself. These still belong to normal text or direct commands:

- the normal prompt inside a work topic
- `/new ...` topic creation
- `/q` when you explicitly mean “run this next”
- `/diff` to inspect git-backed changes
- `/guide`, `/help`, `/zoo`, and `/clear` if you prefer direct commands

Some values still start from a menu but are entered as the next plain text message, such as a custom wait time or free-form suffix text.

## How work usually flows in a topic

Inside a work topic, plain text is treated as a normal prompt. If the run is free, it starts immediately. With the default `exec-json` backend, a follow-up during an active run is accepted as live steer for the same logical run. Use `/q` when you explicitly want the text to run after the current turn settles.

`/q` is not for “one more thought.” It is for an explicit “do this next.”

```text
/q After the current check finishes, prepare a README patch.
```

If nothing is running, that prompt usually starts right away. If the current run is still closing out, `/q` simply waits its turn.

## When /wait matters

`/wait` is for collecting one larger prompt out of several smaller messages.

```text
/wait 60
```

After that, send a few messages and flush them with a separate message:

```text
All
Все
Всё
```

For daily work, local `/wait` is usually enough. If you want the same collection window across the whole chat, there is also `/wait global`.

## Why /suffix exists

`/suffix` is for stable reply habits such as:

- stay concise
- say what you verified
- keep commands and code untranslated
- mention whether tests were run

If the rule belongs to one topic, use a topic suffix. If it is your default habit across the whole chat, use a global suffix. For one-off instructions, a normal prompt is usually simpler.

## Zoo without the bloat

`/zoo` is not a normal work topic. It is a separate operator board for projects.

The normal flow is mostly menu-only:

1. Open `/zoo`.
2. Tap `Add project`.
3. Describe the project.
4. Confirm the suggested root.

After that the topic mostly holds one pinned panel with pet cards and buttons such as `Back`, `Refresh`, `Remove`, and `Respawn menu`.

## What is worth remembering

If you do not want to memorize many commands, these are enough:

- `/new` — create a new work topic
- `/global` — open the global menu in `General`
- `/menu` — open the topic-local menu
- `/status` — quick topic check
- `/q` — queue the next prompt
- `/diff` — see what already changed in a git-backed workspace
- `/compact` — compress a long topic into a brief
- `/guide` — receive this guidebook as PDF
- `/zoo` — open the project board
- `/interrupt` — stop a run when really necessary

## Good habits

- one topic = one stream of work
- do not use `General` as a normal work session
- use menus for stable settings
- use plain messages for the real task
- use `/q` only for explicit next-step work
- do not wait too long before `/compact` when a topic gets large

That is already enough to use the bot confidently without diving into internals.
