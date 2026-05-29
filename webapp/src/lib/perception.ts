/**
 * Client-side mirror of the engine's `computePriceBand` (see
 * `src/engine/perception/estimate.ts`). Kept in sync manually — the
 * webapp/engine boundary doesn't import across, so changes to the
 * engine's price-band math need to land here too.
 *
 *   centre = anchor + (truth - anchor) × expertise
 *   spread = 1 - effectiveJ
 *   low    = max(0, centre × (1 - spread))
 *   high   = max(low, centre × (1 + spread))
 *
 * `effectiveJ` applies the same stepped + damped sub-band sharpness
 * as the engine, so j=0.51 and j=0.52 land in the same visible band
 * but a tiny continuous differentiator survives for engine math.
 * The webapp uses centres only (StockChip is a display, not a
 * decision-maker), so the sub-band damping is informationally inert
 * here — kept aligned for parity if a future call site samples.
 */

import type { KnowledgeProfileDump, EconomicsDump, RunDump, RunItem } from "../types.js";

export interface PriceBandResult {
  readonly centre: number;
  readonly low: number;
  readonly high: number;
  readonly expertise: number;
  readonly j: number;
}

const SHARPNESS_DAMPING = 0.05;

/** Mirrors `steppedJ` in the engine. */
function steppedJ(j: number): number {
  const clamped = clamp01(j);
  const scaled = clamped * 10;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  return floor / 10 + frac * SHARPNESS_DAMPING;
}

/**
 * Compute an actor's belief band for a (category, truth) pair.
 *
 *   • `expertise` is sourced from the actor's `priceAccuracy[category]`
 *     (falling back to `defaultPriceAccuracy`).
 *   • `j` reads from the actor's stored `armJ.price` override when
 *     present; otherwise falls back to expertise (matching the
 *     engine's `getActorArmJ ?? expertise` resolution in
 *     `perception/expertise.ts`).
 *   • `anchor` is the per-category prior; callers using tier-adjusted
 *     truth should pre-multiply by `tierMult[perceivedTier]` (see
 *     `tieredAnchorFor` helper).
 */
export function priceBandFor(
  profile: KnowledgeProfileDump,
  category: string,
  truth: number,
  anchor: number,
  /** Optional stored j override for the price arm — usually
   *  `actor.armJ?.price`. */
  storedJ?: number,
): PriceBandResult {
  const expertise = clamp01(
    profile.priceAccuracy[category] ?? profile.defaultPriceAccuracy,
  );
  const j = storedJ !== undefined ? clamp01(storedJ) : expertise;
  return computePriceBand({ truth, anchor, expertise, j });
}

/** Pure variant — same shape as the engine's `computePriceBand`. */
export function computePriceBand(args: {
  readonly truth: number;
  readonly anchor: number;
  readonly expertise: number;
  readonly j: number;
}): PriceBandResult {
  const expertise = clamp01(args.expertise);
  const j = clamp01(args.j);
  const centre = args.anchor + (args.truth - args.anchor) * expertise;
  const effectiveJ = steppedJ(j);
  const spreadFactor = 1 - effectiveJ;
  const low = Math.max(0, centre * (1 - spreadFactor));
  const high = Math.max(low, centre * (1 + spreadFactor));
  return { centre, low, high, expertise, j };
}

/**
 * Resolve the anchor for a category from the dump, falling back to
 * the engine's `DEFAULT_ANCHOR_FALLBACK` (30) when the dump pre-dates
 * the categoryAnchors field or the category isn't seeded.
 */
export function anchorFor(dump: RunDump, category: string): number {
  return dump.categoryAnchors?.[category] ?? 30;
}

/**
 * Resolve the condition-arm anchor for a category — the v2 condition
 * arm's quality-scalar [0, 1] prior. Falls back to the engine's
 * `DEFAULT_CONDITION_ANCHOR_FALLBACK` (0.5) when the dump pre-dates
 * the field or the category isn't seeded. Surfaces that want to
 * show "what tier would a clueless actor expect here by default?"
 * read this.
 */
export function conditionAnchorFor(dump: RunDump, category: string): number {
  return dump.categoryConditionAnchors?.[category] ?? 0.5;
}

/** Tier midpoints on the [0, 1] quality scale — five tiers, midpoints
 *  at 0.1, 0.3, 0.5, 0.7, 0.9. Matches the engine's `TIER_QUALITY`
 *  ordering in `src/engine/perception/arms.ts`. */
const TIER_QUALITY_BY_NAME: Readonly<Record<string, number>> = {
  broken: 0.1,
  shoddy: 0.3,
  fair: 0.5,
  good: 0.7,
  mint: 0.9,
};
const TIER_NAMES_ORDERED: readonly { readonly name: string; readonly q: number }[] = [
  { name: "broken", q: 0.1 },
  { name: "shoddy", q: 0.3 },
  { name: "fair", q: 0.5 },
  { name: "good", q: 0.7 },
  { name: "mint", q: 0.9 },
];

/**
 * Client-side mirror of the engine's `perceivedTierCentre` — the
 * actor's *centre* belief about an item's quality tier, given their
 * expertise. RNG-free (no sample, just the deterministic centre).
 *
 *   truthQ      ← tier midpoint on the [0, 1] quality scale
 *   anchor      ← per-category condition anchor (uninformed prior)
 *   centre      ← anchor + (truthQ − anchor) × expertise
 *   perceived   ← snap centre to nearest tier midpoint
 *
 * Use this whenever the chip wants to show what an actor *thinks* the
 * tier is, rather than the engine-recorded truth. A clueless actor's
 * centre always sits near the category anchor (≈ fair); an expert
 * lands on truth. Returns `null` when the truthTier is null or the
 * actor has no bidder profile (civilians / virtual actors fall back
 * to truth — they don't have a perception arm).
 */
export function perceivedTierFor(
  dump: RunDump,
  observerProfile: KnowledgeProfileDump | undefined,
  category: string,
  truthTier: string | null,
): string | null {
  if (truthTier === null) return null;
  if (observerProfile === undefined) return truthTier;
  const truthQ = TIER_QUALITY_BY_NAME[truthTier] ?? 0.5;
  const anchor = conditionAnchorFor(dump, category);
  const expertise = clamp01(
    observerProfile.priceAccuracy[category] ??
      observerProfile.defaultPriceAccuracy,
  );
  const centre = anchor + (truthQ - anchor) * expertise;
  let best = TIER_NAMES_ORDERED[0]!;
  let bestDist = Math.abs(centre - best.q);
  for (const t of TIER_NAMES_ORDERED) {
    const d = Math.abs(centre - t.q);
    if (d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return best.name;
}

/**
 * Tier-adjusted anchor — `anchor × tierMult[tier]`. Use when the
 * truth value passed to `priceBandFor` is itself tier-adjusted
 * (i.e. `baseValue × tierMult[tier]`). Without this, a clueless
 * actor inspecting a broken item still anchors at the category
 * average and ends up massively over-estimating; with it the anchor
 * scales linearly with perceived condition.
 *
 * Falls back to the category anchor unchanged when tier is null or
 * not in the economics multiplier map (older dumps, exotic tiers).
 */
export function tieredAnchorFor(
  dump: RunDump,
  category: string,
  tier: string | null,
): number {
  const base = anchorFor(dump, category);
  if (tier === null) return base;
  const mult = dump.economics?.tierMultipliers?.[tier];
  if (mult === undefined || !Number.isFinite(mult)) return base;
  return base * mult;
}

/**
 * Resolve the tier-adjusted truth for an item at a quality tier.
 * Returns `null` when economics data is missing (very old dumps).
 */
export function tierTruth(
  item: Pick<RunItem, "baseValue">,
  tier: string | null,
  economics: EconomicsDump | undefined,
): number | null {
  if (economics === undefined) return null;
  if (tier === null) return null;
  const mult = economics.tierMultipliers[tier];
  if (mult === undefined) return null;
  return item.baseValue * mult;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

import type { CompositePayload, PriceArmPayload } from "../types.js";

/**
 * Format the composite (LotValuation) decomposition as a multi-line
 * tooltip — the per-arm chain the doc calls for
 * (docs/judgement.md — "Per-arm decomposition view"). Shows the
 * Condition arm's perceived tier (or "(seller's claim)" when the
 * condition arm was bypassed via override), then the Price arm at
 * that perceived tier, then the flaw + character-arm contribution
 * and customer-fit multipliers stacked onto the final perceived
 * lot value. So a player hovering an auction bidder sees the chain
 * "Trigger thought it was broken (Condition whiffed) AND under-
 * valued the broken tier (Price anchored low) → £40 ceiling on a
 * £1000 lot." Character-arm bonus surfaced inline when non-zero.
 */
export function formatCompositeMath(args: {
  readonly observerName: string;
  readonly itemName: string;
  readonly payload: CompositePayload;
}): string {
  const { observerName, itemName, payload } = args;
  const lines: string[] = [
    `${observerName} · ${itemName} (${payload.category}, truth ${payload.truthTier})`,
    `Composite valuation (Condition → Price → multipliers):`,
    "",
    "── Condition arm ──",
  ];
  if (payload.conditionOverridden) {
    lines.push(
      `  override — uses ${payload.perceivedTier} directly (seller named it / listing hides truth)`,
    );
  } else if (payload.condition !== null) {
    const ePct = (payload.condition.expertise * 100).toFixed(0);
    const jStr = payload.condition.j.toFixed(2);
    const anchorStr = payload.condition.anchor.toFixed(2);
    lines.push(
      `  expertise ${ePct}%, j=${jStr}, anchor q=${anchorStr}`,
      `  → perceived tier: ${payload.perceivedTier}` +
        (payload.perceivedTier === payload.truthTier
          ? " (truth)"
          : ` (truth=${payload.truthTier})`),
    );
  }
  lines.push("");
  lines.push("── Price arm (at perceived tier) ──");
  const p = payload.price;
  const pEpct = (p.expertise * 100).toFixed(0);
  const pJ = p.j.toFixed(2);
  lines.push(
    `  truth   £${Math.round(p.truthUnit)}/u  (baseValue × tierMult ${p.tierMultiplier.toFixed(2)})`,
    `  anchor  £${Math.round(p.anchor)}/u`,
    `  centre = lerp(anchor, truth, ${pEpct}%) = £${Math.round(p.centre)}/u`,
    `  j=${pJ} → band [£${Math.round(p.low)}, £${Math.round(p.high)}]/u`,
    `  sample (RNG)  £${Math.round(p.sample)}/u → perceived unit £${Math.round(payload.perceivedUnitValue)}/u`,
  );
  lines.push("");
  lines.push("── Flaw + multipliers ──");
  if (payload.flaw.itemFlawType !== null) {
    const known = payload.flaw.knownFlawType === payload.flaw.itemFlawType;
    if (known) {
      lines.push(
        `  flaw '${payload.flaw.itemFlawType}' — known from prior burn (forced detect)`,
      );
    } else if (payload.flaw.detectionBonus !== 0) {
      const sign = payload.flaw.detectionBonus >= 0 ? "+" : "";
      const {
        buyerSocial,
        sellerSocial,
        characterArmAlpha,
        baseDetection,
        effectiveDetection,
        roll,
      } = payload.flaw;
      if (
        buyerSocial !== undefined &&
        sellerSocial !== undefined &&
        characterArmAlpha !== undefined
      ) {
        const delta = buyerSocial - sellerSocial;
        const deltaSign = delta >= 0 ? "+" : "";
        lines.push(
          `  flaw '${payload.flaw.itemFlawType}' — character-arm bonus:`,
          `    buyer social ${buyerSocial.toFixed(2)} − seller social ${sellerSocial.toFixed(2)} = ${deltaSign}${delta.toFixed(2)}`,
          `    × α(${characterArmAlpha.toFixed(2)}) = ${sign}${payload.flaw.detectionBonus.toFixed(3)} detection bonus`,
        );
      } else {
        lines.push(
          `  flaw '${payload.flaw.itemFlawType}' — character-arm bonus ${sign}${payload.flaw.detectionBonus.toFixed(3)}`,
        );
      }
      if (
        baseDetection !== undefined &&
        baseDetection !== null &&
        effectiveDetection !== undefined &&
        effectiveDetection !== null &&
        roll !== undefined &&
        roll !== null
      ) {
        const verdict = payload.flaw.detected ? "**spotted**" : "**missed**";
        lines.push(
          `    base ${baseDetection.toFixed(2)} + bonus ${sign}${payload.flaw.detectionBonus.toFixed(3)} → effective ${effectiveDetection.toFixed(2)}, rolled ${roll.toFixed(2)} → ${verdict}`,
        );
      }
    } else {
      lines.push(`  flaw '${payload.flaw.itemFlawType}' — unmodified detection roll`);
      const { baseDetection, effectiveDetection, roll } = payload.flaw;
      if (
        baseDetection !== undefined &&
        baseDetection !== null &&
        effectiveDetection !== undefined &&
        effectiveDetection !== null &&
        roll !== undefined &&
        roll !== null
      ) {
        const verdict = payload.flaw.detected ? "**spotted**" : "**missed**";
        lines.push(
          `    detection ${effectiveDetection.toFixed(2)}, rolled ${roll.toFixed(2)} → ${verdict}`,
        );
      }
    }
    lines.push(
      `  multiplier ×${payload.flaw.multiplier.toFixed(2)}`,
    );
  } else {
    lines.push("  no flaw on this item");
  }
  if (payload.customerFitMultiplier !== 1) {
    lines.push(`  customer-fit ×${payload.customerFitMultiplier.toFixed(2)}`);
  }
  lines.push("");
  lines.push(
    `Final  £${Math.round(payload.perceivedUnitValue)}/u × ${payload.quantity} × multipliers = £${payload.perceivedLotValue} total`,
  );
  return lines.join("\n");
}

/**
 * Format a persisted price-arm payload as a hover tooltip — the
 * counterpart to `formatPriceArmMath` but reading from the audit
 * log rather than re-deriving from the dump. Used by sites that
 * already have a RunJudgement reference (lead seeders, market /
 * shop sellerBelief events).
 */
export function formatPriceArmMathFromPayload(args: {
  readonly observerName: string;
  readonly itemName: string;
  readonly payload: PriceArmPayload;
}): string {
  const { observerName, itemName, payload } = args;
  return formatPriceArmMath({
    observerName,
    itemName,
    category: payload.category,
    truthTier: payload.truthTier,
    truthUnit: payload.truthUnit,
    anchor: payload.anchor,
    band: {
      centre: payload.centre,
      low: payload.low,
      high: payload.high,
      expertise: payload.expertise,
      j: payload.j,
    },
    quantity: payload.quantity ?? 1,
  });
}

/**
 * Format the price-arm derivation as a multi-line string for a
 * browser-native `title` tooltip — the first slice of the judgement
 * audit trail (docs/judgement.md). Walks the same `centre =
 * lerp(anchor, truth, expertise)` and `spread = 1 - effectiveJ`
 * formula `priceBandFor` uses, so what the player reads matches the
 * computed centre exactly. Numbers stay raw (no localisation) to
 * match the engine's pence arithmetic.
 */
export function formatPriceArmMath(args: {
  readonly observerName: string;
  readonly itemName: string;
  readonly category: string;
  /** Tier the price band was computed against — drives the truth
   *  multiplier. Pass `null` for "no tier read" surfaces (the
   *  tooltip omits the tier-mult line in that case). */
  readonly truthTier: string | null;
  readonly truthUnit: number;
  readonly anchor: number;
  readonly band: PriceBandResult;
  readonly quantity: number;
}): string {
  const {
    observerName,
    itemName,
    category,
    truthTier,
    truthUnit,
    anchor,
    band,
    quantity,
  } = args;
  const ePct = (band.expertise * 100).toFixed(0);
  const jStr = band.j.toFixed(2);
  const centreR = Math.round(band.centre);
  const lowR = Math.round(band.low);
  const highR = Math.round(band.high);
  const truthR = Math.round(truthUnit);
  const anchorR = Math.round(anchor);
  const totalR = centreR * quantity;
  const tierLabel = truthTier ?? "—";
  return [
    `${observerName} · ${itemName} (${category}, ${tierLabel})`,
    `Price arm:`,
    `  truth   £${truthR}/u`,
    `  anchor  £${anchorR}/u (category prior × tier mult)`,
    `  centre = lerp(anchor, truth, expertise ${ePct}%) = £${centreR}/u`,
    `  j=${jStr} → band [£${lowR}, £${highR}]/u`,
    `  × ${quantity} = £${totalR} total`,
  ].join("\n");
}
