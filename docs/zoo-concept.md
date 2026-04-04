# Zoo Concept

`Zoo` is a control-only Telegram topic for project tamagotchi cards.

The goal is simple: each selected project gets a persistent creature, a last known mood, and a small set of useful stats. The surface should feel playful, but the product is still a practical operator tool, not a game.

## Product Shape

- `/zoo` ensures that a dedicated Zoo topic exists and opens or refreshes the Zoo menu there.
- The Zoo topic is not a normal work session.
- Inside the Zoo topic, only Zoo commands, Zoo callbacks, and Zoo reply flows are allowed.
- Plain prompts and all non-Zoo gateway features are rejected in the Zoo topic with a short explanation.
- Each pet maps to one resolved project root directory.
- Each pet has a stable identity, a last snapshot, and a manual refresh action.

## Hard Requirements

- A separate Zoo topic is mandatory.
- Required stats include `Shitcode` and `Junk`.
- Project analysis is done by `codex exec` using `gpt-5.4-mini` with `reasoning: high`.
- The model is allowed to inspect the whole project directly. The gateway should not pre-score the repo with custom heuristics before the model runs.
- Adding a project must work through a natural-language lookup flow, not by making the operator manually type paths.
- Projects must be removable from the Zoo.
- Zoo card language follows the Zoo topic UI language: Russian Zoo means Russian card text, English Zoo means English card text.
- Creature personality must be explicit in the analysis prompt so each pet speaks in-species instead of sounding generic.
- Each pet should also have one stable temperament role so the same species can still feel different across projects.
- New pets should get their species and temperament by random assignment, but the picker should prefer identities that are not already used by existing Zoo pets.

## Operator Flows

### Open Zoo

1. The operator runs `/zoo`.
2. The gateway creates the Zoo topic if it does not exist yet.
3. The gateway opens or respawns the pinned Zoo menu message in that topic.

### Add Project

1. The operator taps `Add project`.
2. The Zoo asks for a natural-language description of the project.
3. The operator replies with something vague like `my private telegram to codex gateway`.
4. The gateway runs a Zoo lookup pass through `codex exec` with `gpt-5.4-mini`, `reasoning: high`.
5. The model searches the workspace and returns one best absolute path in strict JSON.
6. The gateway renders that result into the pinned menu itself instead of posting a separate chat message.
7. The operator replies `Yes` or `No`.
8. If the answer is `No`, the Zoo asks for a better description and the lookup loop repeats.
9. If the answer is `Yes`, the Zoo stores the project root, best-effort deletes the operator replies, and refreshes the menu.

### View Pet

1. The operator taps a pet button in the list.
2. The same menu message switches into the project detail screen.
3. The detail screen shows a creature-plus-temperament role header, an ASCII creature pose above the stats, and a collapsed-by-default lower quote section for mood, flavor, summary, repo metadata, and related detail text.

### Refresh Pet

1. The operator taps `Refresh`.
2. The Zoo starts one dedicated analysis run for that pet.
3. The detail message updates through a few event-driven phases such as `searching`, `inspecting`, and `finalizing`, but no success chatter is posted into the topic.
4. The stored snapshot is replaced with the new result and the detail screen is redrawn.

### Remove Pet

1. The operator taps `Remove`.
2. The Zoo asks for confirmation.
3. The pet metadata and snapshot history are deleted from Zoo state.
4. The source repo is never touched.
5. Remove stays disabled while a refresh for that pet is still running.

## Snapshot Model

The rendered card should use a fixed stat set so the menu stays comparable across projects.

V1 fixed stats:

- `Security`
- `Shitcode`
- `Junk`
- `Tests`
- `Structure`
- `Docs`
- `Operability`

Each snapshot should also contain:

- stable project id
- resolved path
- display name derived from the project root basename
- creature type and mood
- one short flavor line
- one short project summary
- the fixed stats with `0-100` values
- a few short findings
- one recommended next focus
- previous-vs-current trend markers
- refreshed timestamp

`Shitcode` and `Junk` are mandatory first-class stats, not optional flavor metrics.

If two Zoo pets point at private/public variants of the same repo basename, the menu should disambiguate them with canonical `[priv]` and `[pub]` suffixes instead of trusting free-form model naming.

Findings stay in stored snapshot JSON for history and future use, but they do not have to be rendered into the Telegram card itself.

## Analysis Strategy

- Each refresh runs a standalone `codex exec` at the stored project root.
- The prompt tells the model to inspect the full project autonomously with the tools available to it.
- The prompt must require a strict JSON output contract.
- The gateway stores the JSON result, then renders the Telegram card locally.
- The model should see the previous snapshot and pet memory so it can report progress or regress without losing continuity.
- V1 is manual-refresh only. No background refresh loop is required.

This keeps the logic practical:

- the model does the real inspection work
- the gateway owns state, rendering, and flow control
- the UI stays stable even if the model text style changes

## Telegram UX

- The Zoo uses one pinned menu message in the Zoo topic.
- The Zoo topic should stay menu-only in the normal case. Separate chat messages are reserved for actual errors.
- The root screen shows the pet list as inline buttons.
- When the stable grows beyond six pets, the root screen should paginate with Back/Next buttons in the same menu.
- The detail screen shows the last snapshot for one pet.
- Buttons stay small and boring, and intentionally remain in English: `Back`, `Refresh`, `Add project`, `Remove`, `Respawn menu`.
- The creature catalog should be broad enough that different repos do not collapse into the same few animals too often.
- The stats block sits near the top in a monospaced text block so the bars align cleanly.
- Motion should be sparse and event-driven only. Telegram bot text does not support real arbitrary text animation, so the practical V1 approach is slow `editMessageText` frame swaps between a few ASCII poses.
- Idle animation should continue while the operator keeps one pet detail screen open, and stop when the menu returns to root or another non-pet screen.
- Refresh voice should not stay generic for the whole run. A simple startup status is acceptable on the first frame, but later frames should use the pet's stable species-plus-temperament voice.
- No high-frequency timer animation in V1.

The practical V1 rendering should be text-first. The existing gateway already handles editable text panels well, while media-edit-heavy animation would add more moving parts than value.

## State Layout

Zoo state should live under the normal gateway state root, but outside the per-session work-topic model.

Suggested layout:

- `zoo/topic.json` for Zoo topic metadata, menu state, and pending add-project flow
- `zoo/pets/<pet-id>/pet.json` for resolved path and pet metadata
- `zoo/pets/<pet-id>/latest-snapshot.json` for the current rendered source of truth
- `zoo/pets/<pet-id>/history/<timestamp>.json` for snapshot history
- `zoo/runs/` for transient `codex exec` output files during lookup and refresh runs

## Security And Guardrails

- Zoo lookup and analysis must only resolve paths inside configured safe roots.
- Zoo lookup may use natural language, but path acceptance must still be explicit.
- Accepted paths must resolve to directories only.
- If lookup lands on a nested git path, Zoo stores the repo root so refresh always inspects the full project.
- Best-effort deletion of lookup chatter must never block the successful add flow.
- Operator replies used by the add-project flow should be deleted after processing so the topic stays clean.
- In-flight lookup results must not overwrite a newer add-project flow.
- Removing a pet deletes only Zoo state.
- The Zoo topic must reject all non-Zoo commands and plain prompts so it cannot silently behave like a normal Codex topic.

## Implementation Slices

1. Add the Zoo command, Zoo topic creation, and Zoo-topic router guard.
2. Add Zoo state stores for topic metadata, pet registry, and snapshot history.
3. Add the natural-language project lookup flow with yes-no confirmation and best-effort chat cleanup.
4. Add the pet detail screen and refresh loop using `codex exec`.
5. Add removal flow, stale-state cleanup, and menu respawn handling.

## Non-Goals For V1

- No background idle simulation.
- No auto-refresh-all feature.
- No sticker packs, GIFs, or heavy media animation.
- No reuse of normal work-topic session features inside the Zoo topic.
- No repo mutation during analysis.

## Direction

Build this inside the gateway first, but keep the domain split clean:

- Zoo topic and callbacks are Telegram-specific.
- Pet registry, snapshot contract, and rendering inputs should stay transport-agnostic.
- If the concept lands well, the core can be extracted later without rewriting the product idea.
