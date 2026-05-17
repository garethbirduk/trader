# trader — design notes

A skin-agnostic simulation engine for buy-low / sell-high trading games.
The engine models a living market — world supply pools, autonomous NPCs,
forward-sold deals with deadlines, a ledger of leads and trust, and an
auction house that catches anything that doesn't clear privately. The
player is one actor among many; the world runs whether anyone is
watching or not.

This document describes what is currently built. For the player-facing
description of how the game *plays*, see [game.md](game.md).

## Repo layout

```
src/engine/         Core engine: clock, db, types, stock, deals, …
src/engine/world/   Hour-tick subsystems registered on the world
src/engine/mechanics/  Pluggable interaction modules (pub-deal)
src/skins/          Content packs (item kinds, actors, locations, prices)
src/headless/       CLI runner for self-running simulations
tests/              Invariant + scenario tests
webapp/             React viewer (static + live modes)
```

## Engine architecture

### Clock and the hour-tick lifecycle

The world advances in 1-hour ticks across configurable run lengths.
Each tick is run as a deterministic pipeline, registered in
`setup.ts` in this order:

1. **LEAVE** — actors whose schedule places them elsewhere this hour
   depart; `actor.departed` fires for each.
2. **ARRIVE** — those actors land at their destination;
   `actor.travelled` fires for each.
3. **INTERACT** — gossip with proprietors, the daily auction (within
   its window), pool claims, pub deals, market sale, shop sale,
   off-map resale. By this point everyone is at the location they
   are meant to be at this hour.
4. **TICK** — the world clock advances one hour.

Steps 1+2 are owned by `policy-tick`, which is registered first so
every interaction handler observes post-arrival state.

### DB layer

`src/engine/core/db.ts` defines a narrow `DB` interface. Two drivers
implement it:

- `db-better-sqlite3.ts` — native, used by the Node sim.
- `db-sqljs.ts` — WASM, used by the browser live mode.

Schema is built by ordered migrations in
`src/engine/core/migrations/`. `applyMigrations(db, ALL_MIGRATIONS)`
brings any DB up to head; the caller decides when to run it (the
browser path skips re-migration when reopening an existing DB).

The rest of the engine is driver-agnostic — entry points pick.

### Subsystems registered on the world

Hour-tick subsystems live in `src/engine/world/` and attach via
`registerXxx(world, opts)`. `ls src/engine/world/` is the authoritative
inventory; the placeholder skin wires pool spawning in via
`src/skins/placeholder/pool-spawner.ts`.

### Mechanics module

`src/engine/mechanics/pub-deal/` holds the negotiation engine used by
pub deals, shop sales, and market stalls. Drives the back-and-forth
that gets embedded into `pubdeal.agreed` / `pubdeal.walked` events as a
turn sequence the UI can replay.

### Events

The world's narration is the event stream (`core/events.ts`). Events
are value-shaped — no references to internal state — so they are safe
to log, store, ship to the browser, and replay. The current set
covers world/day rollovers, actor movement, deal lifecycle, pool
flushes, pub-deal lifecycle (with full negotiation turns), gossip
exchanges, deliveries, heat, authority raids, the auction lifecycle
(docket published, knowledge acquired, inspected, cleared/unsold/
written-off), and per-actor planner decisions.

### Economics — one config bundle

`src/engine/economics/config.ts` is the single source of truth for
tuning. Every "magic number" controlling margins, spreads, multipliers,
or pricing-chain ratios lives in `EconomicsConfig`. Sections:

- Per-tier price multipliers
- Pool spawning (opening fraction, jitter, closing fraction)
- Starter stock acquisition range
- Pub-deal haggling (buyer ceiling fraction, tier mode, assumed tier)
- Retail-estimate band (accuracy → spread)
- Bidder behaviour (customer-mismatch multiplier, per-flaw discounts)
- Market sale (price fraction, customer-type personas, hourly footfall)
- Per-hour planner (base weights, lot-interest weight, threshold,
  cash-low and full-bag drives, shop specialty match, travel cost,
  weekend modifiers, jitter)
- Off-map auction populism (max bidders per lot, resell margin)

Skins extend or override via `resolveEconomicsConfig(partial)`.
The placeholder skin's current settings: wholesale at 25 % of retail
mid, pub ceiling at 60 %, shop ceiling at 75 %, tier-blind pub buyers
assuming `fair`.

### The actor planner

For "flexible" actors (those with FLEXIBLE slots in their daily
routine), each hour the planner scores candidate destinations —
auction house, market, every pub, every shop, newspaper drops, home —
using inputs from:

- Intrinsic kind-preference base weights.
- Inventory pressure (full-bag → go sell; empty → go acquire).
- Cash pressure (low cash → go earn).
- Known docket lots that score high on the actor's category accuracy
  (pulls towards Sotheby's when they know something is on).
- Shop-specialty match (pulls Boycie's furniture haul to a furniture
  shop's keeper).
- Travel cost against current location.
- Weekend modifier per kind.
- Small RNG jitter for non-determinism.

The planner produces an "actor.planned" event each hour with the
chosen destination and its component scores — so the UI can show
*why* an actor went where they did.

### Skins — content packs

Currently one skin: `src/skins/placeholder/`. It seeds item kinds,
actors with routines, locations with open hours, bidder profiles,
shop specialties, pool-reachability category maps, and the day-1
starter stock. The engine never references skin-specific names.

The README names *Only Fools and Horses* and *Minder* as intended
real skins. Neither is built yet. Three loose data files at the repo
root — `more character routines.txt`, `profiles.json`,
`eastereggs.json` — look like raw OFAH source material waiting to be
turned into a skin.

## Snapshot + dump pipeline

`src/engine/snapshot.ts` is shared by both run paths:

- `captureSnapshot(db, day)` reads world state into a `DaySnapshot`.
- Subscribers push one snapshot per `day.ended`, plus a "day 0"
  snapshot right after seeding so the webapp can show pre-day-1
  positions.
- `buildRunDump(...)` assembles seed, tally, events, snapshots, and
  end-of-run derived data (actors, items, locations, routines,
  economics) into the JSON the webapp consumes.

Run dumps are produced identically in Node (→ `events.json`) and in
the browser (→ kept in memory). The webapp can't tell the difference.

## Two run paths

### Headless (Node)

```sh
npm run sim -- --seed default --days 14 --out webapp/public/events.json
```

`src/headless/run-sim.ts` opens `better-sqlite3`, calls `setupWorld`,
subscribes the console handler + tally + snapshot capture, and runs
to completion. Optional `--quiet` suppresses console narration;
optional `--out` writes the dump.

### In-browser live mode

`webapp/src/live-mode.ts` is selected by `?mode=live` in the URL.
It boots sql.js (WASM SQLite), opens an in-memory DB through
`db-sqljs.ts`, calls the same `setupWorld`, runs the same engine,
and produces the same `RunDump` shape. The engine bundle is
code-split so static-mode visitors do not pay for it.

URL params: `?mode=live&seed=foo&days=N`. Progress is reported back
via an `onProgress` callback so the loading screen can show
"day k/N".

## Webapp

React + Vite. Tab-based main panel, resizable sidebar, scene deck.

**Tabs:** Events · Inventory · Deals · Pools · Map · Editor (dev only).
**Sidebar:** Actors / Locations top tabs; Profile / Diary / Knows /
Inventory / Notebook / Relations lower tabs.
**Header:** browser-style back/forward over selection history,
TimeStepper, PlaybackControls, seed + event count.

## Deployment

`.github/workflows/deploy.yml` on push to `main`:

1. Runs the headless sim to produce `events.json`.
2. Builds the webapp with `BASE_URL=/trader/`.
3. Deploys `webapp/dist/` to GitHub Pages.

Both modes are served from the same static bundle.

## Testing

- Unit tests cover RNG, clock, locations, items, stock lots, deals,
  leads, trust, auction (lots, sessions, bid ladders, bidder
  profiles), heat, transport, negotiation, policy, market sale,
  market mechanics, pool grounding and lead decay.
- `invariants.test.ts` runs a full 14-day sim under three seeds and
  asserts cash conservation, non-negative balances, no stranded
  deals, no zero-quantity stock lots, every flushed pool has
  `flushed_day` set, proceeds reconcile against claim + auction-win
  revenue, the item-kind catalogue is unchanged, and pool flushes
  actually occur.
- `db-sqljs.test.ts` boots the full engine against the WASM driver,
  proving Node and browser paths produce structurally equivalent
  state.

## Determinism

The engine is deterministic for a given seed. RNG is seeded once at
world construction and threaded through every subsystem that needs
randomness (pool jitter, customer histograms, planner jitter, bidder
appraisal noise). No `Date.now()`, no `Math.random()` reach the engine
core.

## Design principles

- **Parity.** NPCs and the player obey the same physics.
- **Narrate the boundary.** Stock or cash leaving Peckham carries a
  story (estate clearance, dodgy import, named off-map contact).
- **Less fakery, not less variation.** Variation comes from richer
  world state, not RNG knobs.
- **Configurable.** Every threshold, multiplier, footfall curve, and
  weight lives in `EconomicsConfig`.
- **UI-first per stage.** Build the admin view of a new mechanic
  before the mechanic itself.

## Asymmetries to remove

A punch list of where the engine still cheats relative to a human
player. Each is small and surgical.

- **Pool-claim autonomy coin-flips.** Today's `attemptChance: 0.5`
  becomes a function of cash, inventory, knowledge of the pool, and
  customer fit. NPCs decide for reasons, not by flip.
- **`customerMismatchMultiplier` is a stand-in.** Derive from each
  bidder's actual customer base (shop specialties, persona interests).
  The information is in the data; plumb it.
- **Routine travel is free in cash.** Decide: time-cost only (keep
  current) or add per-trip petrol/fare. Either is fine — just be
  deliberate.
- **`sourceActorId` semantics.** Confirm or change to "immediate prior
  speaker" so verification-by-walking-back works. Optionally keep
  `originalSourceActorId` separately for "how old is this story."

## Build order

**Stage 9 — sweep infrastructure.**
Script: takes a config matrix × N seeds, runs headless sims, dumps a
CSV of per-run metrics (wealth distribution, clearance rates, deal
volume, bankruptcy count, heat events). Lets you hammer combinations.
- Engine: thin headless-runner wrapper.
- Viewer: optional — a "compare runs" view down the line.
- Defines: which metrics measure "better gameplay."

## Picking up after a context clear

1. Read this doc + [game.md](game.md) + `todolist.md`. Active work
   lives in todolist.
2. `npm run dev` from `webapp/` (port 6173). `npm test` from the
   repo root.
