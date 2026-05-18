# Trader — UI architecture

This is the locked-in architecture for the trader webapp's next-generation
UI. The current viewer (state captured by the surrounding commits to
`webapp/`) is a transitional surface; this document is the target shape.

The intent is that a cleared context can pick up implementation one piece
at a time by following the *Roadmap* at the end.

---

## 1. Purpose and audience

The viewer serves two distinct users with opposite needs:

- **Developer / admin** — wants the engine laid bare. Truth visible
  everywhere. Time scrubbable. Audit trails. Filters. Spot a cash leak,
  verify a pool flushed correctly, see why bidder X bid £Y.
- **Player** — wants a character's perspective. Limited information.
  Forward-looking. Decisions to make. Sees the world the way someone
  living in it sees it — partial, biased, with a clock running toward
  Friday rent.

These two jobs pull in opposite directions. The viewer today is
admin-first with a thin player layer bolted on; the player layer leaks
truth, the admin layer obscures decisions. The new architecture treats
them as first-class peers, sharing chrome and components but differing
in lens.

For the player-facing semantics of the world (what the game *is*), see
[game.md](game.md). For the engine that produces it, see
[design.md](design.md). This doc covers only how the UI surfaces both.

---

## 2. Core concepts — three orthogonal axes

Every pixel in the new UI is shaped by three independent settings. They
do not collapse into one another. Conflating them is what makes today's
viewer fuzzy.

### 2.1 POV — "through whose eyes am I looking"

A persistent header control. Choices are:

- **Admin** — omniscient lens; sees ground truth across all actors.
- **One actor (the player)** — perceptual lens; sees only what that
  actor knows / has witnessed / has been told.

Switching POV does not change engine state. It relenses the player-facing
panels. Admin tabs (Editor, raw event debug) survive POV changes
unchanged.

Default-on-boot: implementation-time = Admin (debugging-first); once the
game ships = the configured player (probably Del).

### 2.2 Selection — "what entities am I examining"

A multi-element set. Possible members:

- **Actors** — anyone in the world.
- **Locations** — places.
- **Stock items** — specific lots, deal lines, pool stock, auction lots.
- **Item kinds** — generic categories (e.g., "Books" across the whole
  world).

The set drives the RHS. Every RHS tab aggregates content across the
selection via union: calendar merges timelines, map highlights all
selected positions, inventory lists stock from all selected entities,
gossip filters to anything touching a selected entity.

### 2.3 Time — "as of when"

The current header slider, unchanged. For admin, time scrubs freely. For
player mode, time is conceptually forward-only but the slider remains
available for replay / inspection.

Crucially, **state in the RHS upper is rendered as the player believed it
at t**, not as it is in truth-now. Scrubbing forward replays how the
actor's understanding evolved.

---

## 3. Top-level layout

Three structural regions, plus an optional debug drawer.

```
┌─────────────────────────────────────────────────────────────────┐
│  HEADER                                                          │
│  ┌──────────────────────────────────────────────────────────────┤
│  │ time controls · POV switcher · seed + event count           │
│  └──────────────────────────────────────────────────────────────┤
├─────────────────┬───────────────────────────────────────────────┤
│                 │  RHS                                          │
│   LHS           │                                                │
│                 │  ╭─ active selection chips ───────────────────╮│
│   3 tabs:       │  │ [Del] [Bob] [Toy Shop +stock] [×clear all] ││
│   Actors        │  ╰───────────────────────────────────────────╯│
│   Locations     │  ╭─ tab nav ──────────────────────────────────╮│
│   Stock         │  │ Map | Inv | Gossip | Deals | Diary | …    ││
│                 │  ╰───────────────────────────────────────────╯│
│                 │                                                │
│                 │  ┌─ upper: time-independent knowledge ─┐      │
│                 │  │   (state at t — what's believed)    │      │
│                 │  └─────────────────────────────────────┘      │
│                 │  ┌─ lower: this-hour scene ───────────┐      │
│                 │  │   (events firing right now)        │      │
│                 │  └─────────────────────────────────────┘      │
└─────────────────┴───────────────────────────────────────────────┘

(optional collapsible debug drawer along the bottom, admin-only)
```

The cumulative tally / run-totals strip that currently lives on the right
side of the viewer is admin-only data. It moves into an admin-mode
"Run summary" tab on the RHS rather than being a persistent rail.

---

## 4. Header

Controls:

1. **Time slider + day/hour stepper** — unchanged from today.
2. **POV switcher** — a dropdown next to the time controls. Lists every
   actor plus an "Admin" entry. Shows the active POV with the actor's
   avatar + name (or "Admin"). Switching is one click; no confirmation.
3. **Seed + event count** — informational, as today.

Visual signposting requirement: the active POV must be **obvious at all
times**. Admin mode should look distinct (subtle chrome difference —
e.g., neutral border) from player mode (player's actor colour as accent).
The user must never wonder "which lens am I wearing".

Persistence: POV is sticky across reload.

---

## 5. LHS — the selector

Three tabs, each a panel listing entities of one type. Each tab supports
multi-select, search/filter, and per-row sub-checkboxes that add
*related* entities to the selection.

### 5.1 Actors tab

Lists every actor known to the current POV.

- Admin: everyone.
- Player mode: actors the player has witnessed, traded with, heard
  gossip about, or otherwise discovered. New leads incrementally reveal
  actors — a real game-feel beat.

Each actor row:

```
☐ Mike Fisher (publican, the Nag's Head)
  ☐ include his home / current location
  ☐ include his stock
  ☐ include his contacts (people he gossips with)
```

Clicking the row's primary chip toggles the actor in the selection set.
Sub-checkboxes opt-in to *related* entities (each is equivalent to
multi-selecting the related entity manually).

The player-actor is pinned at the top in player mode, pre-selected on
boot. The user can deselect the player to view other actors' diaries
cleanly; the auto-add-player rule (§7.3) re-adds them only when the
selection set fully empties.

### 5.2 Locations tab

Lists every location, with the stock held at each nested below.

```
▾ The Nag's Head
  ☐ include proprietor (Mike Fisher)
  ☐ include stock here
  ... stock items below ...

▾ Auction House
  ☐ include proprietor (Sotheby's)
  ☐ include all lots here          ← bulk operator
  [Jeans 100x £10 = £1000]  Lot 2, scheduled D3 12:00
  [Books 80x £8 = £640]      Lot 4, scheduled D3 14:00
  ...
```

Locations are always visible (initial design — discovery layer added
later). The user can browse to anywhere without first learning of it,
matching real-world common knowledge of place.

Stock items housed at a venue appear nested under that venue's row. Each
stock row has its own sub-checkboxes (see Stock tab §5.3) — the same row
is available from both the Locations and Stock tabs, just grouped
differently.

Bulk operators ("select all lots here") are convenience macros for
multi-selection. They render as an aggregate chip in the selection
chips row (see §7.2).

### 5.3 Stock tab

Lists every stock instance known to the current POV. Two groupings,
toggled via a segmented control at the top of the panel:

- **By owner** — every owner's stock listed under their name.
- **By location** — every venue's stock listed under that venue.

Each stock row:

```
[Hi-fi systems 12x £80 = £960 [Fair]]  at Mickey & Jevon's flat
  ☐ select Mickey
  ☐ select Jevon
  ☐ select Mickey & Jevon's flat
  ☐ select Boyce  (inferred from recent gossip)
```

Clicking the stock chip itself adds the stock item to the selection set.
The sub-checkboxes are launchers into related actors / locations.

Stock includes:

- **Inventory lots** — owned by an actor, held at a location.
- **Deal lines** — stock in flight under a contract.
- **Pool stock** — wholesale supply (with the producer as related-entity).
- **Auction lots** — listed lots, owned by Sotheby's, held at the auction.

Future extension (not v1): a sub-filter `Show: ☐ inventory ☐ deal lines
☐ pool ☐ auction lots` lets the user narrow further.

### 5.4 Stock can be selected directly

Per the explicit user decision: ticking a stock-item chip filters all
RHS tabs to "just this stock" — its life across map, calendar, deals,
gossip. This is consistent with item-kinds being selectable; the only
difference is granularity (item-kind = all books in the world; stock
item = these 100 specific books).

### 5.5 Item-kind selection

Item-kinds are selectable in *both* modes (admin and player). Use case:
Del wants to source Books to resell, so he selects the "Books" item-kind
and the RHS becomes a "Books across the world I know about" dashboard —
who has them, where they are, what auction lots, what gossip, what deals.

Item-kinds appear:

- As the chip's underlying entity (clicking a stock chip's *name*
  navigates to the item-kind profile — already today).
- Possibly as a small fourth selector tab in the LHS (`Items`) or as
  filters within the Stock tab. To be confirmed during implementation.

### 5.6 Context affordances slot (future)

When the player becomes commit-able (post-current-scope), the LHS gains
a context-actions section listing what's available given the player's
current state. Examples:

- At home → "phone a known contact" (opens deal/gossip channel with an
  off-site actor).
- At a café/newsagent → "read the morning paper".
- At the auction during inspection window → "inspect a lot".
- Co-located with another actor → "try a deal" / "have a chat".

Design the slot now (an empty section at the top of the LHS); populate
when actions land.

---

## 6. RHS — the main view

### 6.1 Selection chips row

Always present at the top of the RHS. Shows every entity in the active
selection set as a chip, each removable via an `×`.

Bulk-select operators (e.g., "all lots at Auction House") render as a
single aggregate chip — `Auction House: 12 lots ▾ [×]` — with hover/click
to expand if individual control is needed. Removing the aggregate removes
the whole group.

If selection drops to empty *and* current POV is a player, the player
auto-adds back. There is never a truly empty selection in player mode.
Admin mode may rest at empty (view = "world").

### 6.2 Tab navigation

Tabs cover the persistent kinds of facts the user wants to inspect about
any selection. Each tab is rendered in two stripes (§6.3, §6.4).

Initial tab list (subject to refinement):

| Tab | Player mode | Admin mode | Notes |
|---|---|---|---|
| Map | known positions, last-seen | actual positions | zoom to selection if one is picked |
| Inventory | stock the player knows about, beliefs | actual stock + RRP chips | the truth/POV layering applies inside |
| Gossip | the player's lead bag (or about-selected) | full gossip stream | replaces today's "Knows" + admin gossip view |
| Deals | deals the player knows of involving selection | every deal involving selection | RHS-lower = deals in progress this hour |
| Diary | unified calendar past+future from the player's POV | actor's actual plan + history | the asymmetry surface (§8) |
| Notebook | the player's own sell/buy rows | actor's notebook | player tab — same in both modes |
| Relations | trust scores the player knows | full trust matrix | |
| Profile | what the player knows about the selection | full state | redacted in player mode |
| Editor | n/a | always-on | admin-only tab |
| Debug | n/a | always-on | raw event JSON / engine internals |

Tab persistence: when selection changes, the active tab stays. (Don't
reset to default — keep the user's context.)

### 6.3 Upper region — time-independent knowledge

What the user (admin or player POV) *believes* is true at the current
time slider position. State, not stream.

- Inventory tab upper: stock held now.
- Gossip tab upper: the player's full lead ledger as of t.
- Deals tab upper: deals outstanding + recently-settled.
- Diary tab upper: calendar — past + planned future (see §8).
- Notebook tab upper: the player's current notebook rows.
- Relations tab upper: trust matrix as of t.
- Profile tab upper: cards summarising the selection.
- Map tab upper: known positions.

This region evolves with t but is not a stream of events. It is the
state at this instant. Examples of its dynamism:

- At t=0900 Del's diary says 17:00 = "Nag's Head (planner)".
- At t=1100 Del agrees a deal with deadline 17:00; the diary now says
  17:00 = "deliver deal #14 at Sparks Electrical".

The same row changed because the underlying state changed. Both
renderings are correct *at their respective times*.

### 6.4 Lower region — the scene happening now

Time-anchored events firing this hour. Today's SceneDeck content slots
in here, organised under whichever tab is active.

- Inventory tab lower: market sales, shop sales, pub-deal lines moving
  stock this hour.
- Gossip tab lower: exchanges happening right now (today's SceneDeck
  Gossip scene).
- Deals tab lower: pub-deal in progress this hour (with the existing
  pubdeal replay machinery).
- Diary tab lower: events involving the selected entities this hour
  (witness moments, clashes, arrivals).
- Map tab lower: actor movement events this hour.

At night this region empties because nothing is firing. During an
auction hour it's full. The Lower is a derived view of the event stream
filtered by selection.

### 6.5 Aggregation across multi-select

When the selection set contains multiple entities, every RHS region
*unions* the content. Calendar merges timelines across all selected
entities; map highlights all selected positions; gossip shows any
exchange involving any selected entity.

Conflicts and overlaps become visible naturally: if Del and Trigger both
expect to be at the Nag's at 17:00, the calendar row at 17:00 shows
both avatars and the player sees "they'll be in the same room".

That overlap-detection *is the value* of multi-select.

---

## 7. Selection model — detailed rules

### 7.1 Selectable types

Four. Actors, locations, stock items, item-kinds. Each can be in the
set; the set is a heterogeneous mix.

Stock items, deals, lots, pools are descriptive entities — they exist
through their owners and venues. Selecting them filters the RHS to
"life of this stock". Sub-checkboxes on each row let the user opt into
the related actors/locations.

### 7.2 Bulk operators

Some sub-checkboxes are bulk operators — they add a group rather than
a single entity. Examples:

- "Select all lots at Auction House" — adds every lot to the set.
- "Select all of Bob's stock" — adds every Bob-owned stock item.
- "Select all visitors today" — adds every actor expected at the venue.

These render in the selection chips row as aggregate chips (one chip
per bulk operation), expandable, removable as a group. Partial-individual
deselection within a group is allowed and updates the aggregate label
(`Auction House: 9 of 12 lots ▾`).

### 7.3 Auto-add player rule

If the current POV is a player (not admin) and the selection set is
fully empty, the player auto-adds. Player mode therefore never settles
on an empty set.

Admin mode allows empty (view = "world overview").

To view another actor cleanly without the player overlay: deselect the
player explicitly *after* selecting the other. If you deselect everyone
including the player, the auto-add fires and you're back to `{player}`.

This is a minor interaction wart; if it grates, refine later by
distinguishing "implicit player" (auto-added, visually muted) from
"explicit player" (user-ticked, visually solid).

### 7.4 Default behaviours

- **Click chip on a row** → add that entity to the set (or remove if
  already in). Single click toggles.
- **Click a sub-checkbox** → toggle the related entity.
- **Click an entity chip embedded in the RHS** (e.g., an actor avatar
  in a deal line) → add to selection (replacing the previous selection
  if held without modifier; adding if held with shift/cmd). Confirm
  modifier semantics during implementation.
- **`×` on a chip in the selection row** → remove that entity from the
  set.
- **"clear all"** → empty the set (in player mode, immediately
  re-triggers auto-add-player).

---

## 8. Calendar / Diary semantics

Diary = calendar. One tab for the whole game arc.

### 8.1 Future entries come from three sources

1. **Planner picks** — engine predicts hours per actor based on weights
   (cash pressure, inventory, lot-interest, schedule, jitter). These
   are speculative; soft-rendered.
2. **Deal commitments** — collection deadlines, drop windows. Hard;
   bold-rendered.
3. **Calendar fixtures** — rent days, market days, auction days,
   weekly closures. Persistent background.

All three coexist on the same calendar with visual distinction.

### 8.2 Calendar bounds

Nominally forever. Bounded by run length (14 days, 30 days, etc.). Week-
by-week navigation with next/previous controls.

### 8.3 Future entries can change

As new events fire, future rows update. Examples:

- An empty 17:00 slot fills when a deal's struck ("deliver deal #14").
- A planner-picked "Nag's" slot is overwritten when a deal deadline
  forces "Sparks Electrical" instead.
- A row vanishes when its cause is invalidated.

When the user scrubs time backward, the calendar re-renders from
*state as of that earlier time* — you see what was projected then, not
what's projected now.

### 8.4 Asymmetric diaries — the gold

Two actors' calendars can disagree:

> Del agrees a new deal at 1100; his 1700 plan rewrites to "Mickey's".
> Trigger doesn't witness it. Trigger's diary still says "Del at Nag's".
> At 1700 Trigger walks into the Nag's expecting Del. Stand-up moment.

Multi-select calendar (Del + Trigger overlaid) makes the mismatch
visible.

### 8.5 No-shows are events

If actor A expects actor B at location L at hour H and B isn't there,
the engine emits an `actor.expectation-unmet` event (or equivalent).
The event:

- Appears in the events list / debug stream.
- Appears in the Diary tab lower (current-hour scene) at H.
- May carry useful payload (trust delta, rep delta).

The UI just renders what the engine emits.

---

## 9. Auction = location, not actor

The auction is fundamentally a *place* where lots are listed and
bidders gather. The "Sotheby's-as-actor" representation in the engine
is a ledger device — bookkeeping for cash flows, not a player-meaningful
identity.

Implications:

- Auction lots appear under the auction-house location in the Locations
  tab.
- Selecting the auction-house location → Inventory tab shows lots
  (chips with enrichment per player knowledge); Diary tab shows the
  docket schedule.
- The Sotheby's *actor* is hidden in player mode, shown with a "virtual"
  tag in admin mode. Players engage with the place, not the bookkeeping.

Generalisation: any pseudo-actor that's actually a location proxy or
ledger device (Sotheby's, Off-map Market, virtual producers) is either
hidden in player mode or visibly tagged in admin mode.

---

## 10. Stock chip — locked rules (recap)

Single canonical chip for all stock references. Format:

```
[(optional avatar) Name Nx £unit = total Tier]
```

Behaviours:

- One boxed pill per chip. Click anywhere → navigates to item-kind
  profile.
- Category-coloured border (electrical = cyan, vehicles = blue,
  furniture = brown, etc.).
- POV chips: avatar prefix denotes whose POV; unit value driven by
  the judgement engine (`priceBandFor`).
- RRP / admin chips: no avatar, unit value = truth (`tierTruth`).
- Tier badge appears whenever caller passes `qualityTier`. Caller is
  responsible for passing `null` when the actor lacks condition
  knowledge (e.g., gossip headline without detail unlock).
- `unitPriceOverride` lets transactional chips display the agreed
  / realised price instead of perceived value.

Layering rule for centre/admin panels with multiple POVs visible:

- RRP chip first, then one judgement chip per actor in the event.
- Transactions add a `SOLD [seller POV] to [buyer POV]` pair (3
  chips for market, 4 for deals).

Sidebar (player-eye) panels: single POV chip per row.

For details see `webapp/src/components/BeliefChip.tsx` and the layering
pattern saved in user memory (`feedback_chip_layering_pattern.md`).

---

## 11. Engine-side requirements

Some of the UI work depends on data the engine doesn't currently
surface. Worth flagging upfront so engine and webapp work can be
sequenced:

1. **Witness state.** For each actor, which events did they witness?
   Currently the engine knows who's at a location at any hour but the
   witness mapping (event X seen by actors Y, Z) isn't materialised.
   Needed for: redacted Diary in player POV; Profile fields the player
   can/can't see; gossip propagation accuracy.

2. **Diary projection.** The engine plans actors hour-by-hour via the
   planner but doesn't materialise the *projected* schedule as a
   queryable structure. The UI's Diary upper needs this — "what does
   this actor's planned future look like, projected from current
   state?".

3. **No-show events.** `actor.expectation-unmet` (or similar) not
   currently emitted. Needed for the Diary lower's "Trigger flaked"
   surface.

4. **Perceived tier per actor.** Engine has `perceivedTierCentre`
   (`src/engine/perception/arms.ts`). Webapp now has a client-side
   mirror (`webapp/src/lib/perception.ts:perceivedTierFor`). Already
   plumbed for Inventory; extend to all POV chip surfaces.

5. **Inferred contacts / relations.** "Mickey's recent pub-deal
   counterparty" — useful as a sub-checkbox suggestion in the LHS Stock
   row. Currently derivable from events; might want a precomputed
   roll-up.

6. **Player-known entity filter.** What does this player know exists
   (actors, locations)? Needed for the LHS filter in player mode.
   Initially permissive (everyone knows everyone/everywhere); discovery
   layer added later.

These are flagged for the engine roadmap; the UI can stub them with
"closest available" data until the engine catches up.

---

## 12. Out of scope (for now)

- **Player commit actions.** UI remains read-only. Action surface
  (commit hours, queue deals, etc.) deferred until the engine supports
  player-driven inputs.
- **Discovery layer.** Initially all actors and locations known to
  everyone. The discovery mechanic ("a new actor appears in your list
  when you first hear of them") is part of the model but switched off
  for v1.
- **Multi-player / two-screen play.** One player perspective at a time.
- **What-if previews.** Hover an action → expected outcome distribution.
  Comes with the commit surface.
- **Run comparison.** Two seeds side-by-side. Tuning aid, future.

---

## 13. Roadmap — implementation order

The architecture is large. Build it in slices that each ship something
visible.

### Phase 0 — preserve current functionality

The current viewer must keep working through the transition. No mass
deletes; add the new structure alongside until parity is reached.

### Phase 1 — header POV switcher

Add the actor / Admin dropdown to the header. Wire it into a single
global "active POV" context. Components opt in to consuming it as
they're rewritten. Initial behaviour: no rendering change yet (just the
control exists and broadcasts changes).

### Phase 2 — selection set as a first-class context

Replace the existing single-selection model (one selection at a time)
with a multi-entity selection set. Persist in the URL or local state.
Render the active selection chips row at the top of the RHS.

Initial parity: when set has one entity, behaves as today. Multi-select
is enabled but unused.

### Phase 3 — LHS restructure

Build the three-panel LHS (Actors, Locations, Stock). Locations
includes nested stock-at-each-venue. Stock has the by-owner / by-
location grouping toggle.

Sub-checkboxes per row are wired to the selection set.

Bulk operators ("all lots at Auction House") emit aggregate chips.

The current LHS lower (Profile / Diary / Knows / Notebook / Inventory /
Relations tabs) is preserved but the data flow shifts: those tabs read
from the selection set, not from "the one selected actor". For a
single-selection set this is identical behaviour.

### Phase 4 — RHS split into upper + lower per tab

Add the upper/lower split inside each RHS tab. Lower = the existing
SceneDeck content, restructured to per-tab.

Per-tab specs need writing (deferred — see §14).

### Phase 5 — POV semantics across components

Rewire every existing component to respect the active POV:

- Player mode: redact private fields; filter to "what the player
  knows"; use POV-chip layouts (single chip per row, with avatar).
- Admin mode: show truth; use RRP + per-actor POV chip layering.

This is the largest phase. Take one component at a time.

### Phase 6 — Diary as unified calendar

Build the Diary tab to the spec in §8. Past entries from event stream,
future from planner projection + deal commitments + fixtures. Asymmetric
diaries fall out automatically.

This needs engine support (diary projection, no-show events) — flag and
stub as needed.

### Phase 7 — Gossip tab unification

Replace today's "Knows" three-views-three-implementations with one
canonical row component reading from the player's lead bag. Three views
(Timeline / By Item / By Person) become groupings of the same row
component.

Add the admin "Gossip" tab on the RHS showing the run-wide gossip
stream (3 chips per exchange: RRP / speaker / receiver).

### Phase 8 — Context affordances slot

Empty placeholder section at the top of the LHS where future
context-actions will live ("phone home contact" etc.). No content yet;
just the slot.

### Phase 9 — Polish

- Visual signposting of POV (chrome accent).
- Aggregate chip ergonomics (hover expand, partial deselect).
- Empty states ("you don't know this person") per tab.
- Pagination on the calendar.
- Tab persistence across selection.

---

## 14. What's NOT yet locked

The next design pass needs to settle:

### 14.1 Per-tab RHS specs

For each tab × each mode (player/admin) × upper/lower, the precise
content and rendering rules. Sketched for Diary in §8 and Inventory in
the existing patterns; full grid needs writing.

### 14.2 Aggregation rules per tab

When the selection set has 5 entities, exactly how does each tab
aggregate? Sketched in §6.5 as "union across entities" but the rules
need refining per tab — especially conflict highlighting on Diary,
multi-actor Profile, and what "stock-item selected" means on Map.

### 14.3 Engine data shape additions

What new fields / events does the engine need to emit? Listed in §11
but each needs a concrete shape and migration plan.

### 14.4 Empty-state design

Every tab needs a meaningful empty state ("you have no information
about their stock", "you've never met this person"). The empty state
is content — it tells the player something.

### 14.5 Modifier-key interactions

Single-click selects vs. shift-click adds vs. cmd-click extends —
needs deciding before implementation.

### 14.6 Mobile / narrow viewport

Out of scope until desktop works, but worth noting the three-region
layout will need a stacking strategy for narrow screens.

---

## 15. References

- `docs/design.md` — engine architecture
- `docs/game.md` — player-facing game description
- `webapp/src/components/BeliefChip.tsx` — canonical stock chip
- `webapp/src/lib/perception.ts` — client-side judgement helpers
  (`priceBandFor`, `perceivedTierFor`)
- `src/engine/perception/arms.ts` — engine condition arm
  (`perceivedTierCentre` etc.)
- User memory `feedback_chip_layering_pattern.md` — chip rendering rules

---

*Last updated alongside the StockChip rollout commits. The viewer at
those commits is the transitional surface; this document is the target.*
