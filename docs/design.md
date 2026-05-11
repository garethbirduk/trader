# trader — design notes

A skin-agnostic simulation engine for buy-low / sell-high trading games.
The engine models a living market — world supply pools, autonomous NPCs,
forward-sold deals with deadlines, a ledger of leads and trust, and an
auction house that catches anything that doesn't clear privately. The
player is one actor among many; the world runs whether anyone is
watching or not.

This document describes what is currently built. The "Planned work"
section at the end is a placeholder for the milestone plan.

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

Source size today: ~8.5k LoC engine, ~8.6k LoC webapp. 30 test files,
237 tests; full suite ~54 s including a 3-seed 14-day invariant run.

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

Schema is built by 18 ordered migrations in
`src/engine/core/migrations/`. `applyMigrations(db, ALL_MIGRATIONS)`
brings any DB up to head; the caller decides when to run it (the
browser path skips re-migration when reopening an existing DB).

The rest of the engine is driver-agnostic — entry points pick.

### Subsystems registered on the world

All of these live in `src/engine/world/` and attach via
`registerXxx(world, opts)`:

| File | Role |
|------|------|
| `policy-tick.ts` | Leave/arrive (steps 1 + 2 of the tick) |
| `delivery-scheduler.ts` | Daily physical-delivery trips; settles on arrival |
| `pool-expiry.ts` | Removes pools past their expiry day |
| `location-gossip.ts` | Visitor ↔ proprietor lead exchange |
| `auction-listing-knowledge.ts` | Newspaper drop + gallery viewing → docket awareness |
| `auction-inspection.ts` | At-gallery inspection unlocks flaw spotting |
| `daily-auction.ts` | Per-hour auction docket within the auction window |
| `actor-planner.ts` | Per-hour next-destination picker for flexible actors |
| `pool-claim-autonomy.ts` | NPC traders claim from open pools through warm leads |
| `pub-deal-autonomy.ts` | Pub-and-shop haggling — registered twice (pubs, shops) |
| `market-sale.ts` | Hourly market stall sales by customer-persona histogram |
| `off-map-resale.ts` | End-of-day liquidation for off-map dealers |
| `trust-reactions.ts` | Event-driven trust updates |
| `heat-reactions.ts` | Event-driven heat updates |
| `heat-decay.ts` | Day-scoped heat falloff |
| `authority-sweep.ts` | Day-scoped raids on hot actors |
| `lead-decay.ts` | Day-scoped lead confidence decay |

Pool spawning is wired in by the skin
(`src/skins/placeholder/pool-spawner.ts`).

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

## Webapp (~8.6k LoC)

React + Vite. Tab-based main panel, resizable sidebar, scene deck.

**Tabs:** Events · Inventory · Deals · Pools · Map · Editor (dev only).
**Sidebar:** Actors / Locations top tabs; Profile / Diary / Knows /
Inventory lower tabs.
**Header:** browser-style back/forward over selection history,
TimeStepper, PlaybackControls, seed + event count.

**Components (~25 total):** ActorDiary, ActorInventory, ActorKnows,
ActorProfile, Avatar, DealBook, DealProfile, EventList,
InventoryView, ItemProfile, Links, LocationDiary, LocationProfile,
LotProfile, MapEditor, MapGraph, PlaybackControls, PoolBoard,
PoolProfile, Refs, SceneDeck, Sidebar, Summary, TimeStepper,
map-shared, renderEvent.

**Helpers (`webapp/src/lib/`):** auction-window, bid-ladder, calendar,
retail-estimate, selection-history.

## Deployment

`.github/workflows/deploy.yml` on push to `main`:

1. Runs the headless sim to produce `events.json`.
2. Builds the webapp with `BASE_URL=/trader/`.
3. Deploys `webapp/dist/` to GitHub Pages.

Both modes are served from the same static bundle.

## Testing

30 test files, 237 tests, all passing.

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

## Planned work

The engine has the core mechanics working — actors, deals, pools,
auctions, gossip, heat, trust, deliveries, the planner, the dual DB
drivers, the viewer. The next phase pushes toward two related goals:

1. **NPC / player parity.** NPCs and the player must obey the same
   physics. Where the engine takes shortcuts today (synthetic accounts,
   attempt-chance coin flips, auctions that go quiet on slow days), the
   world becomes illogical from a human perspective. Removing those is
   the foundation.

2. **A richer information layer.** The OFAH / Minder texture lives in
   *who-knows-whom*. The engine already has gossip and leads as
   primitives; the work is extending those into a full information
   game — named external producers, brokers, reputation, mutation as
   info hops, and an admin/player UI that lets you see your own
   knowledge.

Held throughout: no change should require a mega-rewrite. Each item
below is surgical against the existing schema and subsystems. Every
numeric knob stays in `EconomicsConfig` so combinations can be swept
later.

### Already in place (shipped alongside Stage 1)

These exist today — don't re-do, but lean on them for the next
stages.

**Engine:**
- `location-gossip.ts` skips identical retransmissions — only emits
  a lead when the receiver doesn't already hold the same fact
  verbatim. Different qty/price still goes through as a refinement.
- Per-location opening schedules with multi-session support. Each
  location can ship `openSessions: { daysOfWeek, start, end }[]` —
  multiple windows on different weekdays, `end > 24` wraps past
  midnight. Used by the viewer's open/closed dimming.
- Random-per-day lunch destinations for employed civilians.
  `ActorSpec.lunchSlot: { hours, daysOfWeek, candidateCodes }`
  rolled once per (actor, day) in `setup.ts` using the world RNG.
  Wired in `hourOverrideForActor` between delivery and planner.
  Currently applied to Cassandra and Alan Parry.

**Viewer:**
- Stage 1 gossip ledger viewer (`ActorKnows`): Timeline / By item /
  By person views, conflict highlighting on diverging qty/price for
  the same subject, source chain (immediate prior + hop +
  confidence) in the meta line.
- Entity-reference chip standardisation. Every actor/location/item/
  deal/lot/pool reference renders as a single clickable hyperlink
  (avatar/icon + name). Actors get circular `<Avatar>`, locations
  get rounded-square `<LocationAvatar>` (type-coloured fill — pub
  amber, home green, business blue, auction purple, civic grey).
- Open/closed dimming. Locations dim across map + chips + profile
  header when closed at the current viewer hour, respecting per-day
  schedules. See `webapp/src/lib/location-open.ts`.
- Shared `<StockLine fact={...} meta={...} />` component (and
  `<StockValue divergent={...} />`) — the visual mould for any
  "subject + qty + item(tier) + price + meta" row. Used by
  inventory (ground truth) and gossip (claimed values). Gossip rows
  show receiver-perspective retail estimate based on the receiver's
  bidder profile and the claimed tier. Future inspection mechanics
  refine the estimate without touching the layout.
- `CurrentTimeProvider` context exposes `{day, hour}` to any leaf
  component that needs it (LocationRef chip, LocationProfile
  header). Avoids prop-drilling.
- Map: location nodes render as rounded squares with initials,
  type-coloured; actors orbit around them (including solo actors
  and transit-arriving actors, so single-actor venues don't get
  obscured by the avatar landing on the node).
- Player display name is "Del Boy" — the cast now reads OFAH
  consistently. Internal code stays `"player"` (load-bearing).
- Dev server pinned to port 6173 with `strictPort: true` to avoid
  silent fallback when another project is on 5173.

### Design principles

- **Parity.** Anything an NPC does, a player can do with the same time
  and cash cost. Anything a player sees, an NPC's policy can also
  consult.
- **Narrate the boundary.** Where stock or cash crosses into "outside
  Peckham," it carries a story (estate clearance, dodgy import, named
  off-map contact). Magic numbers wrapped in flavour aren't a cheat.
- **Less fakery, not less variation.** Variation should come from
  richer world state (who has cash, who's hot, who saw the docket)
  rather than from RNG knobs.
- **Configurable.** Every threshold, multiplier, footfall curve, and
  weight stays in `EconomicsConfig` for sweep iteration.
- **UI-first per stage.** Build the admin view of each new mechanic
  before the mechanic itself. Visible state = debuggable state.

### Conceptual extensions

**One "outside Peckham" ledger node.** All boundary crossings — auction
proceeds, fines, delivery fees, market sales, off-map resale — unify
under a single conceptual account. Today's `auctionHouseActorId` and
the synthetic off-map account are the same entity wearing two hats.

**Named external producers and consumers.** Off-map supply gets a
face: *Trader Bob has 200 fair Nikes at £7/u*. Bob is a virtual actor
— no routine, no home, doesn't tick — but he owns a pool and is
referenced by existing gossip leads via `counterpartyActorId`.
Symmetric on the buyer side (*Wholesaler Cyril takes Hi-Fi*). Today's
synthetic off-map dealers become named whales with finite daily
budgets.

**Access ≠ information.** Knowing about Bob via a lead doesn't mean you
can transact with him. Either:
- you go through a broker who has the relationship,
- you take a multi-hour off-map trip to meet him direct,
- or you pay the broker to arrange a temporary face-to-face at the pub.

Brokerage becomes a first-class role distinct from buy-and-resell.

**Gossip as the reputation system.** No global rep score. "Boyce
stitched Trigger" enters the world as a *warning lead* about a
person — sibling to today's commodity leads, same hop / confidence /
decay machinery. Brokers consult their own ledger before vouching;
counterparties consult theirs before showing up. The cinematic moment
— Bob walking into the Nag's, clocking Del, walking out — falls out of
this naturally.

**Information mutates as it hops.** Numeric drift always (±jitter per
hop), categorical slip occasionally (tier shifts), role reversal
rarely but catastrophically (Boyce burned Trigger ↔ Trigger burned
Boyce). One pure function inside the gossip handler; existing lead
schema covers every field. Both versions persist — Mickey keeps
peddling the wrong story until someone corrects him directly.

**Interaction mechanics with hour-cost.** Co-location ≠ exchange.

| Action | Hour cost | Effect |
|--------|-----------|--------|
| Enter a location | passive | Proprietor exchange (1 drive-by lead — exists today) |
| Try a deal | 1 hour | Negotiation + 1 gossip each side (on agreed *or* walked) |
| Have a chat | 1 hour | +3 new gossips each + 4 clarification queries each |

The hour budget is the player's central resource: an evening at the
Nag's is a decision tree of who to spend each hour with.

**Information-trader archetype.** A handful of skin-coded actors —
Denzil (mobile), Mike (Nag's), Sid (café), Albert (Legion) — have
outsized lead capacity per encounter and a location-flavoured gossip
slant. Chatting with them yields more leads / better clarifications.
Their value is the relationship, not their stock.

**Clarification as detective work.** When the player has lead L and
asks informant X about it, X surfaces *their* lead on the same
subject: values, confidence, hop count, immediate prior speaker. Both
versions persist in the player's table. Player walks the chain by
going actor-to-actor — the existing `sourceActorId` field (made
"immediate prior" rather than "original") supports this directly.

### Asymmetries to remove

A punch list of where the engine cheats relative to a human player.
Each is small and surgical.

- **Auction goes quiet on slow days.** Fix: regional-clearance lots
  flow in every auction-open day on their own schedule, priced
  restrictively. Locals engage on the affordable ones; whales clear
  the rest. Sotheby's is always busy.
- **Off-map dealers are bottomless.** Fix: daily budget per whale,
  replenishing from their own off-map resale revenue with a lag. Real
  finite appetite means whales can be outbid, sit out a day, or run
  short.
- **Pool-claim autonomy coin-flips.** Today's `attemptChance: 0.5`
  becomes a function of cash, inventory, knowledge of the pool, and
  customer fit. NPCs decide for reasons, not by flip.
- **`customerMismatchMultiplier` is a stand-in.** Derive from each
  bidder's actual customer base (shop specialties, persona interests).
  The information is in the data; plumb it.
- **Routine travel is free in cash.** Decide: time-cost only (keep
  current) or add per-trip petrol/fare. Either is fine — just be
  deliberate.
- **Shop accumulation.** Verify shops actually move bought stock back
  out via a household customer histogram. If they don't, they are
  infinite sinks pretending to consume.
- **Stock has no write-off channel.** Add a "skip it" sink for stock
  too broken even for auction — small fee, stock leaves the world.
  Stops dealers hoarding rubbish.
- **`sourceActorId` semantics.** Confirm or change to "immediate prior
  speaker" so verification-by-walking-back works. Optionally keep
  `originalSourceActorId` separately for "how old is this story."

### Build order — Path A, UI-first

Each stage is a small addition with a visible debugging surface.
Engine work and viewer work move together.

**Stage 1 — gossip ledger viewer.** ✅ Done.
Shipped as the grouped `ActorKnows` (Timeline / By item / By
person) with conflict highlighting and the source chain. Surfaced
that gossip was identically retransmitting; that engine fix shipped
alongside (`location-gossip.ts` novelty filter). See the "Already
in place" list above for the broader UI work that landed in the
same window.

**Stage 2 — visitor-to-visitor interaction.** ✅ Done.
Shipped as `src/engine/world/visitor-chat.ts` (visitor↔visitor pair
trials at pubs / market / Sid's / newsagents) and
`src/engine/world/pub-deal-gossip.ts` (deal-adjacent gossip on both
`pubdeal.agreed` and `pubdeal.walked`). The `gossip.exchanged` event
gained a `kind` discriminator (`proprietor | chat | deal`) and now
carries `participantActorIds` rather than the legacy
visitor/proprietor pair. Diary, scene deck, and event list label
each gossip event with its kind. Info-trader actors
(Denzil/Mike/Sid/Albert) are flagged in the placeholder skin and
get the boosted per-encounter lead yield through
`infoTraderChatYield`. Shared novelty/freshness filter lives in
`src/engine/leads/gossip-utils.ts` (warm-first selection).

**Stage 3 — information mutation.** ✅ Done.
Shipped as `src/engine/leads/mutation.ts` — one pure function,
called from `shareLead` via an optional mutator hook. Numeric
jitter on `estimatedQuantity` and `estimatedUnitPrice` is always
applied; tier slip (±1 step in `QUALITY_TIERS`) fires per
`tierSlipChance`; side flip (supply↔demand) per `sideFlipChance`
and also drops `subjectPoolId` so a category-confused lead can no
longer over-count the original pool. All four knobs live in
`EconomicsConfig.gossipMutation`. The three gossip handlers
(location-gossip, visitor-chat, pub-deal-gossip) build the mutator
once at registration and pass it on every `shareLead` call;
embedded `GossipExchange` entries now carry the post-mutation
values so the event stream and the receiver's bag agree on what
was actually said. Conflicts now visibly emerge in the existing
`ActorKnows` ledger view (Stage 1 already wired the divergent-value
highlight).

**Stage 4 — clarification action.**
"Ask X about lead L" reads X's matching lead and surfaces metadata.
Both versions persist in the asker's table. The chain becomes
walkable.
- Engine: new action verb, lookup against target's table.
- Viewer: clarification UI, chain visualisation.

**Stage 5 — reputation leads.**
Warning leads about people as a sibling lead-kind. Brokers and
counterparties consult own ledger before vouching / showing up. The
"Bob walks into the Nag's and leaves" event.
- Engine: lead-kind extension, broker check, counterparty check, new
  abort-on-sight event.
- Viewer: rep leads under the person view; the walk-out as a
  scene-deck moment.

**Stage 6 — named external producers and consumers.**
Trader Bob, Wholesaler Cyril, et al. as virtual actors attached to
pools. Pool `provenance` field for narrative. Broker-or-direct access.
Producer personalities (small profile, 5–6 axes). Temporary
materialisation when a face-to-face is brokered.
- Engine: virtual-actor flag, broker mechanic, optional
  materialisation, provenance on pools.
- Viewer: external-actor pages, broker-fee surface, materialisation
  events.

**Stage 7 — boundary unification + auction always-on.**
Unify the "outside Peckham" ledger node. Regional-clearance lot
schedule flowing into the auction independent of local pool flushes.
Whales with finite budgets.
- Engine: budget on whale actors, regional-clearance scheduler,
  ledger unification.
- Viewer: budget display on whale pages, distinct lot provenance in
  docket.

**Stage 8 — shop turnover, write-off, routine travel cost.**
Close the remaining asymmetries. Shop customer histogram. "Skip it"
sink for unsellable rubbish. Decide on routine travel petrol/fare.
- Engine: shop-side market-sale handler, write-off mechanic, optional
  travel-cost.
- Viewer: shop turnover surface; write-off events.

**Stage 9 — sweep infrastructure.**
Script: takes a config matrix × N seeds, runs headless sims, dumps a
CSV of per-run metrics (wealth distribution, clearance rates, deal
volume, bankruptcy count, heat events). Lets you hammer combinations.
- Engine: thin headless-runner wrapper.
- Viewer: optional — a "compare runs" view down the line.
- Defines: which metrics measure "better gameplay."

Stages 1–4 are largely independent of each other once Stage 1 lands
and can be parallelised if useful. Stage 5 onward composes on the
earlier work.

### Picking up after a context clear

1. Read this doc top to bottom — the "Already in place" subsection
   is the load-bearing one for "what exists right now."
2. Working tree is clean and pushed; current `main` is what's
   running locally and on Pages.
3. Next engine work is **Stage 4 — clarification action**. Spec
   above. The player (and policy-driven NPCs) ask a target X about
   a held lead L; X surfaces their matching lead on the same
   subject. Both versions persist in the asker's table —
   `sourceActorId` already means "immediate prior speaker," so
   chain-walking falls out of the existing schema. New verb +
   handler against the target's lead table; new viewer surface
   on `ActorKnows` to launch a clarification and visualise the
   resulting chain. No schema changes expected.
4. Smaller follow-ups parked outside the stages:
   - Opening hours for Sotheby's (explicit Mon-Fri), Transworld
     depot, council yard, Starlight Rooms, Shamrock Club, Police
     Station. The mechanism is `openSessions` — see Cassandra's
     bank or the 111 Club for the pattern.
   - Loose root-level data files (`more character routines.txt`,
     `profiles.json`, `eastereggs.json`) are OFAH source material
     not yet integrated into the skin.
5. Dev: `npm run dev` from `webapp/` (port 6173). `npm test` from
   the repo root (30 files, 237 tests, ~55s).
