# Trader — UI migration rules

A checklist of prescriptive rules for the UI migration. Every rule
captures a decision we don't want to relitigate. Architectural narrative
and roadmap live in [ui.md](ui.md) — this file is the punch list to
check work against.

## How to use

- During implementation: skim the relevant section before touching a
  surface for the first time in a session.
- During review: each PR that touches the webapp should be checkable
  against the rules here. If a rule is being deliberately broken, that's
  fine — call it out in the PR description with a reason.
- When a new decision is made: add it here in the format below, in the
  category it fits. If no category fits, add a new one rather than
  forcing it.

## Rule format

Each rule is one numbered statement followed by **Why** and **How to
apply** lines.

```
### N. Lead with the rule as a single declarative sentence.
**Why:** the reason behind it — often a past incident, a constraint, or
a property we're trying to preserve.
**How to apply:** the situations the rule kicks in. Edge cases, what to
do when it conflicts with something else.
```

Keep rules short. If a rule needs more than three lines to state, it's
probably two rules or it belongs in [ui.md](ui.md) as architecture.

---

## Components

Rules about what to build, when to reuse, when to fork. Naming and
boundary decisions for shared components.

### 1. All data presentation is via standard chips.
**Why:** chips are the single canonical surface for every piece of
data the UI displays. Routing all presentation through one component
family keeps formatting, judgement-engine integration, POV behaviour,
and interaction affordances consistent. Inline ad-hoc renderings drift
and break invariants.
**How to apply:** any time you need to show an entity or data point
(actor, stock, location, deal, event, money, …), reach for the
relevant chip. If no chip exists yet for that data type, create one
before shipping the surface — never render inline as a stopgap.

### 2. Chips support one or more detail levels; the display is always a chip.
**Why:** different surfaces need different densities (e.g. a packed
list cell vs. a centre-panel headline), but the *type* of rendering
must stay a chip so the rules above continue to hold.
**How to apply:** when a surface needs a denser or sparser variant,
add a named detail level to the chip (e.g. `full`, `simplified`)
rather than building a parallel component or stripping the chip
wrapper. Specific chip types (ActorChip, BeliefChip, …) inherit this
rule; their per-type specifics live below.

### 3. ActorChip has two detail levels: `full` and `simplified`.
**Why:** actors appear in directory-style surfaces (the POV picker,
the LHS Actors list, profile headers) where the full identity
matters, and in compact in-world reference surfaces (selection chips,
owner pills, mini rows, embedded references in events) where the
nickname is enough. Two named levels keep the rendering paths
predictable.
**How to apply:**
- `detail="full"` — avatar + composed full name (`firstName` + ` ` +
  `lastName`, falling back to `firstName` alone when no `lastName`).
  Use in the POV switcher (both its trigger and its option list), the
  LHS Actors list, and profile headers.
- `detail="simplified"` — avatar + `shortName`. Use everywhere else:
  selection chips, owner pills, mini actor rows, embedded references
  inside event text.
- Default is `simplified`. Anything else must be passed explicitly.

---

## POV / lens

Rules about how the player vs admin lens propagates through the UI.
What components know about POV, what they don't, where the branching
lives.

### 1. Admin is a separate toggle outside the actor list.
**Why:** Admin and "an actor" are different kinds of lens, not peer
options in the same picker. Listing Admin as a dropdown entry conflates
them and makes it awkward to flip in and out of admin while keeping
the underlying actor selection intact.
**How to apply:**
- The POV control has two parts: an Admin toggle (on/off) and an
  actor picker. The actor picker lists actors only — never an "Admin"
  entry.
- When the Admin toggle is ON, the active POV is Admin regardless of
  what's selected in the actor picker. The actor picker's selection
  persists (it's the lens we return to when Admin flips off).
- When the Admin toggle is OFF, the active POV is the actor selected
  in the picker.

---

## Selection

Rules about the selection set — what can be selected, how multi-select
behaves, auto-add rules, default state.

_(no rules yet)_

---

## Time / clock

Rules about the time axis — current vs scrubbed time, "as of when"
semantics, past vs future entries, calendar bounds.

_(no rules yet)_

---

## Data flow

Rules about where state lives, who owns it, how it moves. Engine data
shape, event shapes, live-mode vs baked-events parity.

_(no rules yet)_

---

## Layout / chrome

Rules about the persistent layout — header, LHS, RHS, tab structure,
upper/lower regions. What goes where and what doesn't.

_(no rules yet)_

---

## Naming and display

Rules about display names, short names, chip labels, how entities
present in different surfaces.

_(no rules yet)_

---

## Migration policy

Rules about the migration itself — what to leave alone, what to
actively delete, how to handle deprecations, how the old viewer and the
new one coexist while work is in flight.

### 1. Only code that conforms to this spec is migrated in.
**Why:** the rebuild's whole point is to converge on the arch spec.
Restoring components untouched preserves the drift we're trying to
undo and quietly reintroduces violations of the rules in this doc.
**How to apply:** before bringing a commented-out surface back into
App.tsx — or porting any of the original component files — check it
against the relevant categories above. If it violates a rule, fix the
violation first (refactor, replace inline rendering with the chip,
hoist POV branching to the header lens, etc.); only then migrate it
in. If a rule covering the case isn't yet written, write it before
merging the migration so the bar is recorded for next time.
