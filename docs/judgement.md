# Judgement — architectural design

A unified model for how every actor in the world *perceives* every
numerical quantity they care about. Today's engine models perception
piecemeal: bidder profiles carry an `appraisalAccuracy` per category, a
separate `flawTypeDetection` for noticing scams, and a `customerTypes`
list for onward-market fit. These are coherent in isolation but don't
compose, don't separate "what they think" from "how sure they are",
and have no shared way of *displaying* a perceived value to the player.

This document is the architectural commitment for replacing those
piecemeal knobs with a single composable framework. None of it is
built yet — that work is tracked in `todolist.md` under "Implement the
judgement model (see docs/judgement.md)".

---

## The two-knob core

Every numerical belief in the world is a **band**, not a point. Two
orthogonal knobs shape that band:

1. **Centre** ← *expertise*. With perfect expertise, the centre sits
   on the truth. With zero expertise, the centre sits on a **generic
   anchor** for that category — the "uninformed prior" a member of the
   public on the street would guess. Lerp between them by expertise:
   `centre = lerp(genericAnchor, truth, expertise)`.

   This means a low-expertise actor isn't just *uncertain* — they are
   *confidently wrong*, anchored on the generic guess. Boyce knows
   nothing about electronics; his belief for a £1000 video recorder is
   centred near the "average electronics item" anchor (say £80), not
   noisily-around-£1000.

2. **Spread** ← *judgement j*. j is a per-actor scalar in [0, 1].
   High j = narrow band, low j = wide band. j is the actor's
   *decisiveness* — how willing they are to commit to a number versus
   say "could be anything in this range."

A third related concept governs **where in the band a single sample
lands**: the sample distribution is mixture-shaped. With probability
j the actor draws from a tight kernel near centre; with probability
(1 − j) they draw uniformly from across the full range. The peak is
sharper for high j; the distribution flattens for low j. This produces
the realistic shape "usually I'm right, but occasionally I have a wild
miss" — distinct from today's uniform-jitter model where every draw is
equally likely anywhere in the band.

### The four cases

The orthogonality of expertise and j gives four behavioural cases:

| Case | Expertise | j | Behaviour |
|---|---|---|---|
| 1a | low | high | confidently wrong — sharp peak in the wrong place |
| 1b | high | high | confidently right — sharp peak on truth |
| 2a | low | low | haphazardly wrong — wide flat band, overlaps truth by accident |
| 2b | high | low | hesitantly right — wide band around truth, never commits |

Case 1a (confidently wrong) is the pathology today's model *can't
express*: today, low accuracy always reads as "uncertain", never as
"committed to the wrong answer."

---

## The four perception arms

A "valuation" is not one belief; it is a *composition* of independent
sub-beliefs. Each runs the same two-knob machinery on its own
expertise and j:

| Arm | What's being estimated | Existing engine surface |
|---|---|---|
| **Identity** | "Is this a Rolex or a Rulex?" | `knowledge/confusable-pairs-repo.ts` |
| **Condition** | "Mint or fair?" | `flawTypeDetection`, plus tier-perception (today implicit) |
| **Price** | "What does a mint Rolex go for?" | `appraisalAccuracy[category]` |
| **Character** | "Will this person honour the deal?" | **new** — no current surface |

The character arm is genuinely new. Today the engine has *historical*
trust (`TrustPair` scores from settled / defaulted deals) and *rep
leads* (gossip warnings), but no on-the-fly belief about a stranger.
Mike-the-publican meets an unknown punter and immediately reads "this
is a wrong'un"; Trigger meets the same punter and trusts him with
both pockets full. That asymmetry isn't modellable today — adding the
character arm fixes it.

### Composition

Estimates from the arms chain multiplicatively into a final valuation:

```
perceived_value = price_estimate(perceived_identity, perceived_condition)
```

Compound uncertainty: a novice on watches gets all three arms wrong and
ends up at £30 on a £1000 watch (wrong identity → wrong tier → wrong
price). A specialist gets all three close and lands within ±10%.
There's no separate "higher-level judgement" combining the arms —
composition naturally produces the final estimate's accuracy as the
product of the arms' accuracies.

### Which arms apply where

Different decisions consume different subsets:

| Decision | Identity | Condition | Price | Character |
|---|---|---|---|---|
| Auction lot appraisal | ✓ | ✓ | ✓ | — |
| Pub-deal counterparty | ✓ | ✓ | ✓ | ✓ |
| Market hour pricing | ✓ | ✓ | ✓ | — |
| Notebook sell-side row | ✓ | ✓ | ✓ | ✓ |
| Clearance booking | — | ✓ | ✓ | — |
| Pool claim decision | — | — | ✓ | — |

One helper per arm; call sites pick which to consult.

---

## The character arm — bidirectional reading

The character arm is special because it's a **two-way mirror**.
Whoever has the higher social score in an interaction has the
perceptual upper hand:

- **As buyer**: bonus to detecting that the seller is hiding something.
  A buyer's effective flaw-detection becomes
  `base + α × (buyer_social − seller_social)`. Mike spots tells;
  Trigger doesn't. Fencing SCAM_BAIT to a high-social buyer is much
  harder than fencing it to a low-social one, beyond what
  `flawTypeDetection` already captures.
- **As seller**: a high-social seller suppresses the buyer's
  tell-reading by smoothly concealing the dodginess and pitching to the
  buyer's blind spots. A low-social seller radiates shiftiness even
  when their goods are fine.

The **delta** drives the effect: same-score parties cancel out;
asymmetric pairings produce the interesting outcomes. This naturally
unblocks future mechanics that depend on reading another actor — the
Driscolls intimidate-pubdeal item is the obvious one, where a
high-social Driscoll reads the dealer's fear (knows when to push) and
a low-social one mis-times the menace and gets refused.

---

## Display — band-collapsed colour palette

Perception is also a rendering concern. Every belief-mediated number
in the UI uses a shared **10-stop palette** running blue (low) →
green (mid) → red (high). The palette is the universal ruler. *Which*
of those ten colours a given perceiver can distinguish is gated by
their j:

- **Band count** = `max(1, floor(j × 10))`. j = 1.0 → 10 bands;
  j = 0.5 → 5 bands; j = 0.1 → 1 band.
- A perceiver's band collapses their continuous belief to the
  band-midpoint (their visible "rating"), which then maps to the
  closest palette stop.
- The same value renders the same colour to everyone *within their
  band* — 0.95 and 0.96 are visually identical to a perceiver with j
  high enough to distinguish them, but 0.95 and 0.85 are visually
  identical to a perceiver at j = 0.2 (both fall in their upper band).

### Sub-band sharpness (engine only)

Within a band, the continuous fractional part of `j × 10` is used by
engine math as a "sharpness" scalar, with **damped** weight (≈ 0.05,
not the full 0.10 step). j = 0.51 and j = 0.52 visibly identical (same
palette stop) but the j = 0.52 actor makes marginally better decisions
hundreds of times per day; the gap shows in their cash curve, not
their colour swatches.

The damping is critical: if sharpness gets the full 0.10 weight, the
formula `floor(j × 10)/10 + frac(j × 10) × 0.1` algebraically equals
`j` and the band model collapses back to a flat continuous multiplier.
At ~0.05 damping, crossing a band boundary is a meaningful step-up
that sharpness can only partially compensate for within the previous
band.

### Perceiver lens

The colour helper takes both a value and a **perceiver j**:
`colourFor(value, perceiverJ) → paletteIndex`. The perceiver is
usually the player-actor (driving what the UI shows). Admin / dev
mode passes `perceiverJ = 1.0` and gets the full 10-band view plus
numeric tooltips. In-game, the player only sees as much resolution as
their character's j allows — playing Trigger (j ≈ 0.3) grains the
entire UI down to 3 colours; playing Boyce (j ≈ 0.8) shows 8.

This is where the player-vs-character skill split lives: low-j
characters force the human to compensate from outside-the-character
knowledge (notes, memory). Two characters, two genuinely different
game experiences from the same engine state.

---

## Per-arm dials

Each actor carries, per arm:

- `expertise` — per-category (Identity, Condition, Price) or
  per-archetype (Character). Scalar in [0, 1].
- `j` — per-arm scalar in [0, 1]. Each arm has its own j: Mike has
  high character-j (good people-reader), low price-j on electronics
  (a mug for flashy gear). Trigger has low j on every arm.

Arms are **nominally independent** but typically correlated within a
category. Skin defaults set them equal per category for most actors;
authors deviate where the character demands it (sharp-eyed appraiser
who doesn't follow auction prices; charming dealer with no eye for
condition; etc).

This is a meaningful schema expansion. Today's bidder profile carries
`appraisalAccuracy + flawTypeDetection + customerTypes`. The new model
adds per-arm expertise per category × 4 arms + 4 j values. For ~20
trading actors and ~6 categories that's ~28 dials per actor.
Mitigation: sensible defaults shared across most actors, override only
where character distinctiveness lives.

---

## The generic anchor table

The new piece of world data this all needs is a **per-category
generic anchor** — a number (or modest distribution) representing
"what does someone with zero expertise in this category guess things
are worth?"

- A small table on the world: one row per category.
- Used as the floor of the lerp toward truth when expertise is low.
- Set in the skin seed; tuned by the same play-testing loop as the
  rest of the economics knobs.
- Could later be made per-archetype (a yuppie's "average electronics"
  anchor differs from a market trader's), but the v1 table is
  category-wide.

---

## Why this matters

The framework unifies four otherwise-disparate engine concerns:

1. The valuation noise model (currently uniform jitter, will become
   centred-and-mixture).
2. The flaw-detection probability (currently independent of
   counterparty social score).
3. The trust / character-judgement gap (currently has no on-the-fly
   layer between trust ledger and rep leads).
4. The UI's belief-display problem (currently has arbitrary
   colour-coded badges with no perceiver lens).

Each of those four could be patched individually, but they share the
same underlying shape: *an actor producing a band of belief about a
quantity, where centre and width come from different attributes of
the actor.* Building the framework once, then routing the four
problems through it, is the architectural win.

It also fits cleanly with the future "play as any NPC" item: switching
the player to Trigger automatically grains the entire UI down to his
j, and routes every perception decision through his per-arm expertise
+ j. No per-component refactor needed at that point — the framework
handles it.

---

## Implementation order (sketched, not committed)

When this gets built, the most likely order is:

1. **Single helper module**: `engine/perception.ts` exporting
   `estimate(actor, arm, target, rng) → number` and
   `colourFor(value, perceiverJ) → paletteIndex`. Pure functions.
2. **Schema expansion** on the bidder profile or new
   `actor_perception` table: per-arm expertise + j. Skin-seeded.
3. **Generic anchor table** seeded by the skin.
4. **Migrate `appraiseLot` first** — that's the highest-leverage call
   site, drives all auction behaviour. Existing tests pin down current
   behaviour; new model goes in behind a flag, then flag flips when
   numbers settle.
5. **Migrate pub-deal autonomy, market sale, shop sale** — each call
   site swaps `appraisalAccuracy[category]` for `estimate(...)`.
6. **Add character arm** — new field, used at pub-deal entry to
   modify the flaw-detection roll on the counterparty's offered goods.
7. **UI colour helper**: replace the 5 `badge-{tier}` rules with the
   10-stop palette + perceiver-j-band collapse. Three sites in
   `ActorProfile.tsx`, plus a coloured dot in `ActorNotebook.tsx`.
8. **`tests/judgement-scenario.test.ts`** (currently skipped) gets
   un-skipped and turned into a snapshot — drift in those numbers
   would mean the new model has shifted behaviour, which we'd want to
   catch.

Each step is independently shippable. The framework can stand up
across two or three milestones rather than landing as one fat PR.
