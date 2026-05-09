import type { SeededRNG } from "../core/rng.js";
import type { FlawType } from "../stock/types.js";
import type { AuctionLot } from "./types.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";

/**
 * A bidder's appraisal profile — how good they are at estimating the value
 * of items, and how good they are at *spotting flaws*. The engine uses
 * this to compute a *valuation* ceiling (what they think the lot is
 * worth), distinct from their *liquidity* ceiling (what they have in cash).
 *
 *   • `appraisalAccuracy[itemCategory]` ∈ [0, 1]. 1.0 = always pegs the
 *     true market value exactly; 0.0 = wild guess uniformly distributed
 *     in [0×, 2×] of true value. Categories not listed fall back to
 *     `defaultAppraisalAccuracy`.
 *
 *   • `flawTypeDetection[flawType]` ∈ [0, 1] is the probability that the
 *     bidder *spots* a flaw of the given type when valuing a lot tagged
 *     with it. If they spot it, they apply the standard discount for
 *     that flaw type (see `FLAW_DISCOUNT`). If they don't, they pay full
 *     price for the broken/dodgy goods. Flaw types not listed fall back
 *     to `defaultFlawTypeDetection`. A clueless mug: low detection across
 *     the board. A category specialist: high detection inside their
 *     speciality, low outside it.
 *
 *   • `inspectionAdjustment(lot)` returns an additional multiplier on the
 *     appraised value, modelling lot-specific knowledge picked up via a
 *     paid expert inspection or earned reputation. Defaults to 1.0.
 *
 * v1 carries profiles in memory and the skin assigns them. A future
 * milestone may persist appraisal_skill / known_inspections tables.
 */
export interface BidderProfile {
  readonly appraisalAccuracy: ReadonlyMap<string, number>;
  readonly defaultAppraisalAccuracy: number;
  readonly flawTypeDetection: ReadonlyMap<FlawType, number>;
  readonly defaultFlawTypeDetection: number;
  /**
   * Customer-archetype tags this bidder's onward market consists of
   * (e.g. `["yuppies", "businesses"]` for a high-end car dealer). If an
   * item's `targetCustomers` doesn't overlap with the bidder's customer
   * types, the bidder applies a strong discount — they don't have
   * buyers for it. Empty/missing sets mean no preference (universal).
   */
  readonly customerTypes?: readonly string[];
  readonly inspectionAdjustment?: (lot: AuctionLot) => number;
}

/**
 * Discount applied to a bidder's valuation when an item's target
 * customers don't overlap with their own. Calibrated so a poor-fit item
 * values at ~40% — significant but not catastrophic, since some items
 * still have onward niche markets. Re-exported from the economics
 * config so legacy call sites keep working.
 */
export const CUSTOMER_MISMATCH_MULTIPLIER =
  DEFAULT_ECONOMICS_CONFIG.customerMismatchMultiplier;

/**
 * The fallback profile used for actors who don't have one yet — they're
 * passable generalists who notice flaws roughly half the time. Skins
 * should override this for known characters.
 */
export const FALLBACK_BIDDER_PROFILE: BidderProfile = {
  appraisalAccuracy: new Map(),
  defaultAppraisalAccuracy: 0.7,
  flawTypeDetection: new Map(),
  defaultFlawTypeDetection: 0.5,
};

/**
 * Discount applied to a bidder's valuation when they *spot* a flaw of the
 * given type. Calibrated so the comedy lands: a clueless bidder pays full
 * price for SCAM_BAIT goods (which a clued-in bidder values at zero); a
 * sharp bidder won't touch DANGEROUS stock at any reasonable price.
 * Re-exported from the economics config so legacy call sites keep working.
 */
export const FLAW_DISCOUNT: Readonly<Record<FlawType, number>> =
  DEFAULT_ECONOMICS_CONFIG.flawDiscount;

export interface AppraisalResult {
  /** What the bidder thinks this lot is worth, in pounds (total). */
  readonly valuation: number;
  /** Components, useful for debugging / future UI tooltips. */
  readonly accuracy: number;
  readonly errorFactor: number;
  readonly flawDetected: boolean;
  readonly flawMultiplier: number;
  readonly inspectionMultiplier: number;
  readonly customerFitMultiplier: number;
}

/**
 * Compute a bidder's perceived value of a lot given the true market value
 * and their profile. Pure function — given the same RNG draws, returns
 * the same valuation. Two RNG draws are made when the lot has a flaw
 * type: one for the appraisal jitter, one for the flaw-detection coin
 * toss.
 */
export function appraiseLot(args: {
  profile: BidderProfile;
  lot: AuctionLot;
  category: string;
  flawType: FlawType | null;
  trueLotValue: number;
  /** Item's target customers; empty = universal item. */
  itemTargetCustomers?: readonly string[];
  rng: SeededRNG;
  /** Optional config override. Defaults to engine defaults. */
  economics?: EconomicsConfig;
}): AppraisalResult {
  const economics = args.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const accuracyRaw =
    args.profile.appraisalAccuracy.get(args.category) ??
    args.profile.defaultAppraisalAccuracy;
  const accuracy = clamp01(accuracyRaw);
  const errorRange = 1 - accuracy;
  const errorFactor = Math.max(0, 1 + (args.rng.next() - 0.5) * 2 * errorRange);

  let flawDetected = false;
  let flawMultiplier = 1;
  if (args.flawType !== null) {
    const detectionRaw =
      args.profile.flawTypeDetection.get(args.flawType) ??
      args.profile.defaultFlawTypeDetection;
    const detection = clamp01(detectionRaw);
    flawDetected = args.rng.next() < detection;
    if (flawDetected) {
      flawMultiplier = economics.flawDiscount[args.flawType];
    }
  }

  const inspectionMultiplier =
    args.profile.inspectionAdjustment?.(args.lot) ?? 1;

  const customerFitMultiplier = computeCustomerFit(
    args.itemTargetCustomers ?? [],
    args.profile.customerTypes ?? [],
    economics.customerMismatchMultiplier,
  );

  const valuation = Math.max(
    0,
    Math.round(
      args.trueLotValue *
        errorFactor *
        flawMultiplier *
        inspectionMultiplier *
        customerFitMultiplier,
    ),
  );
  return {
    valuation,
    accuracy,
    errorFactor,
    flawDetected,
    flawMultiplier,
    inspectionMultiplier,
    customerFitMultiplier,
  };
}

function computeCustomerFit(
  itemTargets: readonly string[],
  buyerTypes: readonly string[],
  mismatchMultiplier: number,
): number {
  if (itemTargets.length === 0) return 1; // universal item — no preference
  if (buyerTypes.length === 0) return 1; // bidder unaligned — no penalty
  for (const t of itemTargets) {
    if (buyerTypes.includes(t)) return 1;
  }
  return mismatchMultiplier;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
