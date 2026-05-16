/**
 * BeliefChip — "stock proposition from an observer's POV." One
 * component that subsumes every surface where we used to render
 * ad-hoc "Item × qty × £price" lines (gossip leads, notebook rows,
 * deal lines, the retail-estimate table). The chip routes everything
 * through the judgement engine's perception model so the same lot
 * of jeans reads £100 to clueless Denzil and £50 to Elsie the
 * clothing specialist, with the colour of the [tier] tag gated by
 * the player's perceiver-j (docs/judgement.md).
 *
 * Renders: `qty × [item] @ £centre/u = £total [tier?]`
 *
 *   • centre is the observer's belief centre from `priceBandFor` —
 *     truth and anchor lerp gated by their per-category expertise.
 *   • tier tag is rendered only when `qualityTier !== null` (the
 *     observer has a perception of the condition — either inspected
 *     or claimed-by-gossip). Colour uses the inverted palette so
 *     broken=red, mint=blue. Band resolution gated by perceiver-j.
 *
 * Non-candidates (don't use this chip): the player's own inventory
 * (ground truth, no belief gap), objective lot/pool metadata, event
 * records, settled deal-line ground truth. See todolist's BeliefChip
 * entry for the surface-by-surface rationale.
 */

import type { RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { ItemRef } from "./Refs.js";
import { colourFor, resolvePerceiverJ } from "../lib/palette.js";
import {
  tieredAnchorFor,
  priceBandFor,
  tierTruth,
} from "../lib/perception.js";

/** Canonical tier order from worst to best, matching the engine's
 *  `QUALITY_TIERS` constant. Used to map a tier name to a [0,1]
 *  palette value for the tier-tag colour. */
const TIER_ORDER: readonly string[] = ["broken", "shoddy", "fair", "good", "mint"];

interface Props {
  readonly dump: RunDump;
  readonly itemKindId: number;
  /** The tier the observer thinks/sees. `null` = no condition read
   *  (uninspected, no gossip claim). When `null` the chip omits the
   *  tier tag entirely and falls back to "good" for the truth-basis
   *  of the price belief (a reasonable uninformed default). */
  readonly qualityTier: string | null;
  readonly quantity: number;
  /** Whose belief is being rendered — the actor whose perception
   *  shapes the centre. For "Denzil thinks jeans are worth £X" pass
   *  Denzil's id; for a gossip lead about Boyce's supply, pass the
   *  *receiver* (the actor whose lead bag the row lives in). */
  readonly observerActorId: number;
  /** Override the perceiver whose j gates the tier tag colour.
   *  Defaults to the player-actor's j via `resolvePerceiverJ`. */
  readonly perceiverJ?: number;
  /** Hide the per-unit and total. Useful for compact contexts where
   *  the price isn't the headline — keeps the item + tier tag. */
  readonly priceless?: boolean;
  readonly onSelect: (s: Selection) => void;
}

export function BeliefChip({
  dump,
  itemKindId,
  qualityTier,
  quantity,
  observerActorId,
  perceiverJ,
  priceless,
  onSelect,
}: Props) {
  const item = dump.items.find((i) => i.id === itemKindId);
  if (item === undefined) {
    return <span className="muted">[unknown item]</span>;
  }
  const observer = dump.actors.find((a) => a.id === observerActorId);
  const profile = observer?.bidderProfile;

  // Truth basis for the price belief. Use the observed tier when
  // present; fall back to "good" when unknown (matches the chip's
  // implicit assumption that uninspected stock looks plausibly OK).
  const truthTier = qualityTier ?? "good";
  const truth = tierTruth(item, truthTier, dump.economics);

  const anchor = tieredAnchorFor(dump, item.category, truthTier);
  const band =
    profile !== undefined && truth !== null
      ? priceBandFor(profile, item.category, truth, anchor, observer?.armJ?.price)
      : null;

  const unitPrice = band !== null ? Math.max(0, Math.round(band.centre)) : null;
  const total = unitPrice !== null ? unitPrice * quantity : null;

  const j = perceiverJ ?? resolvePerceiverJ(dump);

  return (
    <span className="belief-chip">
      <span className="belief-chip-qty">{quantity}</span>
      <span className="muted"> × </span>
      <ItemRef dump={dump} id={itemKindId} onSelect={onSelect} variant="chip" />
      {priceless !== true && unitPrice !== null ? (
        <>
          <span className="muted"> @ </span>
          <span className="belief-chip-unit">£{unitPrice}</span>
          <span className="muted">/u</span>
          {total !== null ? (
            <>
              <span className="muted"> = </span>
              <span className="belief-chip-total">£{total}</span>
            </>
          ) : null}
        </>
      ) : null}
      {qualityTier !== null ? (
        <>
          {" "}
          <TierTag tier={qualityTier} perceiverJ={j} />
        </>
      ) : null}
    </span>
  );
}

/**
 * Palette-coloured tier badge. Tier-as-ordinal mapped to [0,1] then
 * through `colourFor` with `invert: true` so broken=red, mint=blue.
 * Perceiver-j gates the visible band count. Exported for surfaces
 * that want the tier glyph without the full BeliefChip wrapping
 * (notebook rows, gossip-lead rows, etc — places where the price
 * is already perception-mediated via gossip seeding and the chip's
 * `priceBandFor` computation would override rather than augment).
 */
export function TierTag({
  tier,
  perceiverJ,
}: {
  readonly tier: string;
  readonly perceiverJ: number;
}) {
  const idx = TIER_ORDER.indexOf(tier);
  // Unknown tier — render with no palette colour rather than guessing.
  if (idx < 0) {
    return <span className="belief-chip-tier muted">[{tier}]</span>;
  }
  // Map ordinal to band-midpoint in [0,1]. Five tiers → midpoints
  // 0.1, 0.3, 0.5, 0.7, 0.9.
  const value = (idx + 0.5) / TIER_ORDER.length;
  const stop = colourFor(value, perceiverJ, { invert: true });
  return (
    <span
      className={`belief-chip-tier palette-stop-${stop}`}
      title={`perceived condition: ${tier}`}
    >
      [{tier}]
    </span>
  );
}
