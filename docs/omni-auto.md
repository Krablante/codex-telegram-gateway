# Omni And /auto

## Purpose

`Omni` is the small autonomy supervisor for `Spike`.

- `Spike` does the heavy live work
- `Omni` handles `/auto`
- `Omni` evaluates `Spike` final replies and decides what to do next
- `Omni` stays locked to the user goal instead of acting like a dumb `continue` relay
- `Omni` is optional at the deployment level

## Setup Flow

1. `/auto`
2. next message = goal
3. next message = initial worker prompt
4. `Omni` forwards the first real prompt to `Spike`

Replying to Omni messages is not required; ordinary next messages in the same topic are enough.

## Phases

- `await_goal`
- `await_initial_prompt`
- `running`
- `evaluating`
- `sleeping`
- `blocked`
- `done`
- `failed`
- `off`

## Omni V2 Decision Model

Current Omni decisions are goal-locked and use these modes:

- `continue_same_line`
- `continue_after_sleep`
- `pivot_to_next_line`
- `blocked_external`
- `done`
- `failed`

`pivot_to_next_line` is the important new case:

- the current proof line is honestly exhausted
- the bigger locked goal is still alive
- Omni should switch lines instead of surfacing a fake blocker

## Topic-Scoped Omni Memory

Each `/auto` topic now keeps a small `omni-memory.json`.

That memory is intentionally small and practical. It carries things like:

- `goal_constraints`
- `current_proof_line`
- `proof_line_status`
- `last_spike_summary`
- `last_decision_mode`
- `known_bottlenecks`
- `candidate_pivots`
- `side_work_queue`
- `supervisor_notes`
- `why_this_matters_to_goal`
- `goal_unsatisfied`
- `what_changed_since_last_cycle`
- `do_not_regress`

The point is continuity:

- Omni does not need to rediscover the same supervisory context every cycle
- Spike gets richer handoffs instead of empty “continue” nudges
- auto-compact can refresh Spike context without losing Omni’s small planning state

## Human Input Rules

When `/auto` is active:

- direct human prompts stop going to `Spike`
- `Spike` only accepts prompt-starts from trusted `Omni`
- plain human questions in `running`, `sleeping`, or `evaluating` are treated as direct questions to `Omni`
- plain non-question operator input is still queued where the auto phase expects it
- if the operator interrupts `Spike` and later gives new input, the next Omni -> Spike handoff starts a fresh continuation instead of trying to reuse the interrupted Codex thread

You can still use `/omni`, but you do not have to for normal direct questions during active `/auto`.

## Sleep Behavior

`Omni` can choose `sleep_minutes` from `1` to `60`.

That is used when:

- the live proof line is healthy
- no immediate intervention is needed
- immediate re-pinging `Spike` would be spammy or pointless

During sleep:

- `Spike` is not woken up
- a direct question to `Omni` is still allowed
- fresh operator input can be folded into the wake-up context
- Omni may also keep one narrow bounded side-work item in memory for the next wake-up handoff

## Handoff Shape

Omni -> Spike handoffs are now more structured.

A continuation or pivot handoff can include:

- current proof line
- what changed since the last cycle
- what part of the locked goal is still unsatisfied
- why this line matters to the goal
- one primary next action
- optional bounded side work
- do-not-regress constraints

This keeps `/auto` practical:

- the locked goal stays visible
- Spike still remains the only heavy worker
- Omni can supervise long-running work without turning into a second build agent

## Automatic Continuity Refresh

Long `/auto` runs can now auto-compact at cycle boundaries.

Rules:

- never mid-run
- only after a Spike final and before the next Omni -> Spike handoff
- preserve pending human input and Omni memory
- keep manual `/compact` unchanged
- emit a short visible topic message when auto-compact triggers

The current threshold is intentionally simple:

- Omni handoff count since last compact is at least 10
- there is no extra age floor; once `/auto` reaches that count and hits a safe cycle boundary, it refreshes continuity immediately

If compaction itself fails, Omni falls back to continuing without compact instead of killing a healthy autonomy loop.

## Blockers

Real blockers are narrow:

- missing secret or ID after vault/secret-broker lookup
- real external hard stop
- unrecoverable environment/resource issue

These are not blockers by default:

- normal code breakage
- test failures
- repairable runtime issues
- “this one proof line is exhausted, but the bigger goal still lives”

## Operator Questions

Examples:

- `что мы уже сделали?`
- `почему ты сейчас спишь?`
- `я правильно понимаю, что solve bar ещё не закрыт?`

These questions:

- do not wake `Spike`
- do not reset sleep
- do not change `auto_mode`
- can trigger a narrow read-only repo inspection if it helps Omni answer truthfully
