/**
 * StockChip — the one true rendering of any stock reference in the UI.
 *
 * Format:  `Name Nx £unit = total [Tier]`
 *   • "Bookcases 1x £56 = 56 [Fair]"        — known qty, tier, observer
 *   • "Lego sets 2x £30 = 60"                — known qty, unknown tier
 *   • "Lego sets"                            — qty / price / tier all unknown (e.g. headline-only gossip)
 *
 * Modes:
 *   • observerActorId = number  → unit-price is *that actor's POV* belief
 *     via the judgement engine (`priceBandFor` centre at the perceived
 *     tier). Used on sidebar surfaces showing a specific actor's
 *     inventory, gossip, notebook, etc.
 *   • observerActorId = null    → "truth mode" — equivalent to a
 *     100%-judgement observer; unit-price is the seeded truth
 *     (`tierTruth`). Used on omniscient main pages (Inventory tab,
 *     deal book, lot/pool profiles, event records).
 *
 * The tier badge palette is still gated by the player's perceiver-j
 * (docs/judgement.md), so a low-j player sees a coarser tier read.
 */

import type { RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { Avatar } from "./Avatar.js";
import { colourFor, resolvePerceiverJ } from "../lib/palette.js";
import {
  tieredAnchorFor,
  priceBandFor,
  tierTruth,
  formatPriceArmMath,
} from "../lib/perception.js";

const TIER_ORDER: readonly string[] = ["broken", "shoddy", "fair", "good", "mint"];

interface Props {
  readonly dump: RunDump;
  readonly itemKindId: number;
  /** The tier the row is about. `null` = unknown condition — tier badge
   *  is omitted and the chip uses the category's "good"-tier truth as
   *  the fallback basis for any displayed unit value. */
  readonly qualityTier: string | null;
  /** Units of stock in this reference. `null` = unknown (e.g. gossip
   *  headline pre-detail-unlock) — the chip renders just the item
   *  name (plus tier badge if known). */
  readonly quantity: number | null;
  /** Whose POV drives the unit value. `null` = truth mode (a
   *  100%-judgement reading). When set, the chip routes through
   *  `priceBandFor` against that actor's category expertise + arm-j.
   *  Ignored when `unitPriceOverride` is provided. */
  readonly observerActorId: number | null;
  /** Optional override for the per-unit price. When provided, this
   *  replaces the computed value (truth / POV) and is used as-is for
   *  the chip's £/u and the total. Use for transactional contexts
   *  (deal lines, sold market lots) where the chip represents an
   *  agreed / realised price rather than a perceived value. */
  readonly unitPriceOverride?: number;
  /** Override the perceiver whose j gates the tier badge palette
   *  resolution. Defaults to the player-actor's j. */
  readonly perceiverJ?: number;
  readonly onSelect: (s: Selection) => void;
}

export function BeliefChip({
  dump,
  itemKindId,
  qualityTier,
  quantity,
  observerActorId,
  unitPriceOverride,
  perceiverJ,
  onSelect,
}: Props) {
  const item = dump.items.find((i) => i.id === itemKindId);
  if (item === undefined) {
    return <span className="muted">[unknown item]</span>;
  }

  // Truth basis for value: use the row's tier when known, otherwise
  // anchor on "good" so a tier-less row still renders a plausible
  // unit price (matches the chip's "uninspected stock looks OK" prior).
  const truthTier = qualityTier ?? "good";
  const truth = tierTruth(item, truthTier, dump.economics);

  let unitValue: number | null = null;
  let hoverMath: string | undefined;

  if (quantity !== null && unitPriceOverride !== undefined) {
    // Transactional override — fixed agreed / realised price.
    unitValue = Math.max(0, Math.round(unitPriceOverride));
  } else if (quantity !== null && truth !== null) {
    if (observerActorId === null) {
      // Truth mode: the centre equals truth (100% judgement actor).
      unitValue = Math.max(0, Math.round(truth));
    } else {
      const observer = dump.actors.find((a) => a.id === observerActorId);
      const profile = observer?.bidderProfile;
      if (profile !== undefined) {
        const anchor = tieredAnchorFor(dump, item.category, truthTier);
        const band = priceBandFor(
          profile,
          item.category,
          truth,
          anchor,
          observer?.armJ?.price,
        );
        unitValue = Math.max(0, Math.round(band.centre));
        hoverMath = formatPriceArmMath({
          observerName:
            observer?.displayName ?? observer?.code ?? `actor#${observerActorId}`,
          itemName: item.displayName,
          category: item.category,
          truthTier,
          truthUnit: truth,
          anchor,
          band,
          quantity,
        });
      } else {
        // Observer with no bidder profile (civilian) — show truth.
        unitValue = Math.max(0, Math.round(truth));
      }
    }
  }

  const total = unitValue !== null && quantity !== null ? unitValue * quantity : null;
  const j = perceiverJ ?? resolvePerceiverJ(dump);

  // POV badge — when the chip's value is from a specific actor's
  // viewpoint (not RRP truth), prefix with that actor's avatar so
  // the reader can tell at a glance whose belief this is. Truth-mode
  // chips have no avatar (the value is the universal RRP).
  const povActor = observerActorId !== null
    ? dump.actors.find((a) => a.id === observerActorId) ?? null
    : null;

  return (
    <button
      type="button"
      className={`stock-chip stock-chip-cat-${item.category}`}
      onClick={() => onSelect({ kind: "item", id: itemKindId })}
      {...(hoverMath !== undefined ? { title: hoverMath } : {})}
    >
      {povActor !== null ? (
        <Avatar
          name={povActor.displayName ?? povActor.code}
          code={povActor.code}
          isPlayer={povActor.code === "player"}
          size={14}
          title={`${povActor.displayName ?? povActor.code}'s POV`}
        />
      ) : null}
      <span className="stock-chip-name">{item.displayName}</span>
      {quantity !== null ? (
        <>
          <span className="stock-chip-qty">{quantity}x</span>
          {unitValue !== null ? (
            <>
              <span className="stock-chip-unit">£{unitValue}</span>
              {total !== null ? (
                <>
                  <span className="stock-chip-sep">=</span>
                  <span className="stock-chip-total">{total}</span>
                </>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      {qualityTier !== null ? (
        <TierTag tier={qualityTier} perceiverJ={j} />
      ) : null}
    </button>
  );
}

/**
 * Palette-coloured tier badge. Tier-as-ordinal mapped to [0,1] then
 * through `colourFor` with `invert: true` so broken=red, mint=blue.
 * Perceiver-j gates the visible band count. Exported for surfaces
 * that want the tier glyph without the full StockChip wrapping.
 */
export function TierTag({
  tier,
  perceiverJ,
}: {
  readonly tier: string;
  readonly perceiverJ: number;
}) {
  const idx = TIER_ORDER.indexOf(tier);
  const label = capitalize(tier);
  if (idx < 0) {
    return <span className="stock-chip-tier muted">{label}</span>;
  }
  const value = (idx + 0.5) / TIER_ORDER.length;
  const stop = colourFor(value, perceiverJ, { invert: true });
  return (
    <span
      className={`stock-chip-tier palette-stop-${stop}`}
      title={`condition: ${tier}`}
    >
      {label}
    </span>
  );
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
