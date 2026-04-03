# Spike + Omni: newcomer guidebook

This is a short human guide to the bot. It is not a reference for every flag. It is a practical map: who does the work, where to write, when to use `/q`, `/wait`, `/suffix`, what `/auto` is for, and when `/diff`, `/compact`, and `/purge` actually matter.

## How to think about the system

Think of it this way: `General` is the lobby, and work topics are separate rooms for separate tasks. In `General` you open global settings, ask for reference material, and request the guidebook. Real work usually does not happen there; it lives in a concrete topic.

The normal starting flow is simple: create a topic directly with `/new Topic Name`, enter it, and send a plain-text prompt. If the task gets long, check `/diff` and run `/compact` from time to time.

Example:

```text
/new Backend Cleanup
```

The most useful beginner rule is: one topic, one work stream. Do not mix five unrelated tasks into the same thread.

## Who does what

`Spike` is the main worker. It receives the normal prompts, reads code, edits files, runs commands, and sends the final answer. If you enter a topic and start working normally, you are almost certainly working with `Spike`.

`Omni` exists only for `/auto`. It does not replace `Spike` and it is not meant to become a second heavy worker. Its job is to keep the goal in view, look at completed Spike cycles, and decide what should happen next.

You do not need `Omni` to start using the system. If you are on a capped plan such as `ChatGPT Plus`, it is often smarter to start with `Spike` only: `/auto` with `Omni` usually spends noticeably more tokens and burns through limits faster.

Short version: `Spike` is the live worker, and `Omni` is the `/auto` supervisor.

## Where to write and what happens next

Inside a work topic, plain text is treated as a normal prompt. If the topic is free, the run starts immediately. If a run is still active, a follow-up can be folded into the same work stream as a continuation.

`/q` is for a different case: when you do not mean "here is one more thought", but explicitly mean "do this next after the current work finishes". In that case the prompt goes into the `Spike` queue.

Example:

```text
/q After the current check finishes, prepare a README patch.
```

If nothing is running in that topic, the prompt usually starts right away. If the previous run is still finishing its final reply and shutting down, `/q` simply waits and starts next. During `/auto`, this queue path is intentionally unavailable because `Omni` already owns the routing.

## When to use /wait

`/wait` is not for queueing. It is for collecting one larger prompt from several smaller messages. This is useful when you want to send context in parts, add an attachment, and then flush everything as one cleaner request to `Spike`.

Example:

```text
/wait 60
```

After that you can send several short messages, and then send a separate flush message. Any of these words will work:

```text
All
Все
Всё
```

`/wait global` does the same thing across the whole chat, but for daily work the local one-shot mode is usually enough.

## Why /suffix matters

`/suffix` is a persistent appended instruction. It is not for one-off wishes. It is for habits and stable reply rules. Good suffixes sound like this: "stay concise", "always say what you verified", "leave commands and code untranslated", or "mention whether tests were run before the final answer".

Examples:

```text
/suffix Keep answers concise and always say what you verified.
```

```text
/suffix global Keep answers concise. Always call out verification.
```

If the rule belongs to one topic, use a topic suffix. If it is your default habit across the chat, use a global suffix. If the instruction matters only once, a normal prompt is simpler.

## Useful commands without the noise

You often do not need to type commands by hand at all. `General` has a global menu for chat-wide settings, and each work topic has a local menu for that topic. Those menus are the easiest way to change language, wait windows, models, and other common settings without memorizing command syntax.

- `/help` shows the command list with short explanations. If a command is unclear or you want to see the full list, start with `/help`.
- `/status` shows the topic state and the effective model and reasoning profile.
- `/menu` opens the local topic settings.
- `/language` changes the UI language.
- `/model` and `/reasoning` control `Spike`.
- `/omni_model` and `/omni_reasoning` control `Omni` when `/auto` is part of the deployment.

For a longer task, three more commands matter most:

- `/diff` gives you a quick look at what already changed in the workspace.
- `/compact` turns a long topic history into a short working brief. The bot keeps the important context and next-step facts so you can continue without dragging the full message log forever.
- `/purge` clears the local topic memory when it is no longer useful and you want a near-clean start.

## How to think about /auto

`/auto` is for a longer autonomous task, not for normal back-and-forth chat. You enable `/auto`, give the goal, provide the starting prompt, and then `Omni` watches the completed `Spike` cycles and keeps the task moving. While `/auto` is running, remember three things: `Spike` is still the main worker, the operator-facing dialogue in that topic is handled through `Omni`, and `/q` is intentionally unavailable there.

If you just want to ask "what is already done?" or "why are we waiting?", you can still ask that directly in the same topic.

## Good habits

Do not try to keep everything inside one topic. Do not use `General` as a work session. If you really mean "do this next after the current work", use `/q` instead of hoping timing will line up. If the task grows, run `/compact` before the topic turns into a mess. If you want a stable reply style, move it into `/suffix` instead of repeating it in every prompt.

That is already enough to start using the bot confidently without diving into the internals.
