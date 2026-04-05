# Spike + Omni: newcomer guidebook

This is a short practical guide to the bot. It is not a full flag reference. It is a starting map: where to work, when to use menus, what you do not need to memorize, and which commands are actually worth remembering.

The main idea is simple: for daily work, prefer menus over memory. Commands still expose the full surface, but menus and buttons already cover most common settings.

## Quick start

`General` is the lobby. You usually do three things there: open the global menu, run shared operator shortcuts from it, and create new work topics.

The normal start looks like this:

```text
/new Backend Cleanup
```

Then enter the new topic and send the task as plain text. That is the normal happy path. Do not use `General` as a regular work session, and do not pile several unrelated tasks into one topic.

## Who does what

`Spike` is the main worker. It reads code, edits files, runs commands, and answers the task.

`Omni` exists only for `/auto`. It is a supervisor, not a second heavy worker. It watches completed `Spike` cycles and decides whether the task should continue.

If you are new, `Spike` alone is almost always enough. `/auto` becomes useful later, when you truly want a longer autonomous task and understand the token cost.

## Why menus should be your default

The bot is no longer a “memorize twenty commands” interface. The basic path is:

- use `/global` in `General` for chat-wide settings;
- use `/menu` inside a work topic for topic-local settings;
- use the pinned menu and inline buttons in `Zoo`.

Menus are the easier and safer path for things that change regularly but are not the task itself:

- viewing `Status` inside a topic;
- changing the UI language through the global menu in `General`;
- turning `wait` on or off;
- opening `Bot Settings` and changing `Spike`/`Omni` model and reasoning there;
- running topic ops through `Compact`, `Interrupt`, and `Purge` buttons;
- turning suffixes on or off;
- opening `Zoo` or running `Clear` straight from the global menu in `General`;
- opening `Guide` or `Help` straight from the global menu in `General`;
- refreshing the current screen.

The practical rule is simple: if you need to change a stable setting, start with a menu. It is faster, cleaner, and usually does not require remembering syntax. A few layout details are worth knowing: the global menu now starts with `Bot Settings` and `Language` on the top row, keeps `Guide` and `Help` immediately below them, leaves `Wait` / `Suffix` and `Zoo` / `Clear` lower on the root screen, and still keeps bot-specific runtime controls behind a dedicated `Bot Settings` screen instead of spreading them directly across the root menu. The effective bot summary also stays intentionally compact, for example `spike: gpt-5.4 (xhigh)`.

## What menus do not replace

Menus do not replace the work itself. Some things still belong to plain text or direct commands:

- the normal prompt inside a work topic;
- `/new`, because topic creation is command-driven;
- `/guide`, `/zoo`, and `/clear` still work from `General` if you prefer direct commands;
- `Zoo`, `Clear`, `Guide`, and `Help` are available as buttons in the global menu, but the direct commands still work too;
- `/q`, when you want to explicitly queue the next prompt;
- `/diff`;
- `/auto` and questions for `Omni`.

One more practical detail matters: some values start from a menu but are not chosen by button. Custom wait values or free-form suffix text are usually entered as a reply to the menu message after the bot asks for input.

Short version: menus are great for toggles, presets, screen navigation, and the common `General` shortcuts. Free-form text and the real work still live outside them.

## How work usually flows in a topic

Inside a work topic, plain text is treated as a normal prompt. If the run is free, it starts immediately. If the run is still active, a follow-up can be folded into that same stream.

`/q` is not for “one more thought.” It is for an explicit “do this next.”

```text
/q After the current check finishes, prepare a README patch.
```

If nothing is running, that prompt usually starts right away. If the current run is still closing out, `/q` simply waits its turn. During `/auto`, this queue path is unavailable because `Omni` already owns routing.

## When /wait matters

`/wait` is for collecting one larger prompt out of several smaller messages. For example: first send context, then a log chunk, then one more clarification, and only then flush everything as one clean request to `Spike`.

```text
/wait 60
```

After that, send a few messages and then flush them with a separate message. Any of these work:

```text
All
Все
Всё
```

For daily work, local `/wait` is usually enough. If you want the same collection window across the whole chat, there is also `/wait global`.

## Why /suffix exists

`/suffix` is not for one-off instructions. It is for stable reply habits such as:

- stay concise;
- always say what you verified;
- keep commands and code untranslated;
- mention whether tests were run before the final answer.

If the rule belongs to one topic, use a topic suffix. If it is your default habit across the whole chat, use a global suffix. For one-time instructions, a normal prompt is usually simpler than a suffix.

## Zoo without the bloat

`/zoo` is not a normal `Spike` work topic. It is a separate operator board for projects. Its job is to show which repo looks healthy, which one slipped, and where attention probably makes sense next.

The normal Zoo flow is almost entirely menu-only:

1. Open `/zoo`.
2. Tap `Add project`.
3. Describe the project in normal words.
4. The bot suggests the matching root.
5. Reply `Yes` or `No`.

After that, the topic mostly holds one pinned panel with pet cards and buttons such as `Back`, `Refresh`, `Remove`, and `Respawn menu`. In Zoo, the buttons intentionally stay English even when the card text is localized.

What matters in practice:

- Zoo is not for normal prompts or coding sessions;
- `Refresh` updates the project card without extra topic spam;
- `Remove` deletes the pet from Zoo, not the repo itself;
- if you track many projects, the list becomes paginated.

That is enough to use it well. Do not think of Zoo as a second command surface; it is closer to a compact repo status board.

## When /auto is actually worth it

`/auto` is for a longer autonomous task, not for normal back-and-forth chat. You set the goal, give the starting prompt, and then `Omni` watches completed `Spike` cycles and decides what should happen next.

If you just want normal interaction with the bot, `/auto` is almost certainly unnecessary. Learn the standard `Spike` topic flow with `/menu`, `/diff`, and `/compact` first, then bring in `Omni` only when it has a practical payoff.

## What is worth remembering

If you do not want to keep many commands in your head, these are enough to start:

- `/new` for a new work topic;
- `/global` for the global menu in `General`;
- `/menu` for the local topic menu;
- `/status` for a quick topic check;
- `/q` to queue the next prompt;
- `/diff` to see what already changed;
- `/compact` to compress a long topic into a brief;
- `/guide` to receive the PDF guidebook;
- `/zoo` to open the project board;
- `/interrupt` to stop a run when that is really necessary.

Everything else can be picked up as needed through help and menus.

## Good habits

Work with the rule “one topic = one stream of work.” Do not use `General` as a normal work session. For settings, look at menus first. For the actual task, use plain messages. For an explicit “do this after the current work,” use `/q`. If the topic gets too long, do not wait too long before `/compact`.

One more practical note: if the operator rolls the service forward while your topic already has an active run, that run should normally finish instead of being cut off in the middle.

That is already enough to use the bot confidently without diving into the internals.
