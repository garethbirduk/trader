import type {
  BuyerParty,
  SellerParty,
} from "../negotiation/types.js";
import type { ExtractionBand } from "./extraction-band.js";

/**
 * Per-actor strategic anchoring knob. Captures how far above (seller)
 * or below (buyer) the honest belief the party opens — the
 * cinematically visible difference between Boyce (high-anchor
 * strategist) and Trigger (anchors at honest mid).
 *
 * Sellers:
 *   anchorAggression ∈ [0.5, 2.5] — multiplier on belief.high to set
 *     the opening target. 1.0 = honest top of belief; 1.5 = hedges
 *     +50%; 2.0 = wildly hopeful; <1.0 = quick-sale opens low.
 *   floorMultiplier ∈ (0, 1] — multiplier on belief.low to set the
 *     walk-away floor. 1.0 = won't go below their honest low; 0.5 =
 *     desperate seller willing to halve the bottom of their belief.
 *
 * Buyers:
 *   ceilingFraction ∈ (0, 1] — fraction of belief.high they'll pay.
 *     Mirrors today's `pubBuyerCeilingFraction` (default 0.6).
 *   openFraction ∈ (0, 1] — opening offer as fraction of ceiling.
 *     Low = anchor low, force counter rounds.
 *   informedQuietMode — when set, on a seller open that lands well
 *     below the buyer's ceiling, the buyer opens BELOW the seller's
 *     ask rather than at openFraction × ceiling. The "Boyce plays
 *     inside Del's frame" mechanic.
 */
export interface SellerAnchorOptions {
  readonly anchorAggression?: number;
  readonly floorMultiplier?: number;
  readonly concedeRate?: number;
  readonly seedConfidence?: number;
  /**
   * Where in the band to anchor the opening ask.
   *   "high"        — top of the full band (incl. speculative priors).
   *   "quoted-high" — top of combos with matched price quotes only.
   *                   The defensible "I have a number from Mickey
   *                   for this scenario" anchor — used by sellers
   *                   who hedge but don't speculate.
   *   "mid"         — weighted-mean midpoint (honest mid).
   * Defaults to `"quoted-high"` so sellers with price beliefs anchor
   * at the credible top of their quoted knowledge rather than at
   * inflated priors.
   */
  readonly anchorOn?: "high" | "quoted-high" | "mid";
}

export interface BuyerAnchorOptions {
  readonly ceilingFraction?: number;
  readonly openFraction?: number;
  readonly concedeRate?: number;
  readonly informedQuietMode?: boolean;
}

/**
 * Build a SellerParty by anchoring on the seller's own extraction
 * band. Cost basis is *not* read — losing-sale guarding is the
 * caller's job and lives on a different axis ("cut losses or hold?")
 * separate from "what's my honest extraction band?". The aggregator
 * already lowers the band when the seller has bad-news beliefs.
 */
export function makeSellerParty(
  actorId: number,
  band: ExtractionBand,
  opts: SellerAnchorOptions = {},
): SellerParty {
  const aggression = opts.anchorAggression ?? 1.0;
  const floorMult = opts.floorMultiplier ?? 1.0;
  const concedeRate = opts.concedeRate ?? 0.2;
  const anchorOn = opts.anchorOn ?? "quoted-high";

  const anchorValue =
    anchorOn === "high"
      ? band.high
      : anchorOn === "mid"
        ? band.mid
        : band.quotedHigh;

  const targetRaw = anchorValue * aggression;
  // Floor uses the quoted-low when available (a seller's defensible
  // worst case), falling back to the full band low.
  const floorBase =
    anchorOn === "high" || anchorOn === "mid" ? band.low : band.quotedLow;
  const floorRaw = floorBase * floorMult;
  const target = Math.max(1, Math.round(targetRaw));
  // Floor must not exceed target (otherwise the negotiator throws),
  // and must be at least £1 to keep arithmetic well-defined.
  const floor = Math.max(1, Math.min(target, Math.round(floorRaw)));

  return {
    actorId,
    floor,
    target,
    concedeRate,
  };
}

/**
 * Build a BuyerParty from the buyer's own extraction band plus an
 * optional informed-quiet override when a seller's open arrives well
 * below the buyer's honest ceiling.
 *
 * `sellerOpen` is optional — when supplied AND informedQuietMode is
 * on AND sellerOpen < ceiling × informedQuietThreshold, the buyer's
 * opening target snaps to `sellerOpen × informedQuietFraction`,
 * playing inside the seller's frame.
 */
export interface MakeBuyerPartyArgs {
  readonly actorId: number;
  readonly band: ExtractionBand;
  readonly cashCap: number;
  readonly sellerOpen?: number;
  readonly opts?: BuyerAnchorOptions;
}

const INFORMED_QUIET_THRESHOLD = 0.5; // seller open < 50% of ceiling triggers
const INFORMED_QUIET_FRACTION = 0.7; // open at 70% of seller's open

export function makeBuyerParty(args: MakeBuyerPartyArgs): BuyerParty {
  const opts = args.opts ?? {};
  const ceilingFraction = opts.ceilingFraction ?? 0.6;
  const openFraction = opts.openFraction ?? 0.3;
  const concedeRate = opts.concedeRate ?? 0.2;

  const honestCeiling = args.band.high * ceilingFraction;
  const ceiling = Math.max(1, Math.min(args.cashCap, Math.round(honestCeiling)));

  let target: number;
  if (
    opts.informedQuietMode === true &&
    args.sellerOpen !== undefined &&
    args.sellerOpen < ceiling * INFORMED_QUIET_THRESHOLD
  ) {
    target = Math.max(
      1,
      Math.min(ceiling, Math.round(args.sellerOpen * INFORMED_QUIET_FRACTION)),
    );
  } else {
    target = Math.max(1, Math.min(ceiling, Math.round(ceiling * openFraction)));
  }

  return {
    actorId: args.actorId,
    ceiling,
    target,
    concedeRate,
  };
}
