import type { FlawType } from "../stock/types.js";
import type { AuctionLot } from "./types.js";
import { DEFAULT_ECONOMICS_CONFIG } from "../economics/config.js";

/**
 * A bidder's appraisal profile — what an actor knows about a category
 * (`appraisalAccuracy`), what flaws they spot (`flawTypeDetection`),
 * which customer archetypes they sell onward to (`customerTypes`).
 *
 * This shape predates the judgement engine (docs/judgement.md) and is
 * still the in-memory carrier the skin uses to declare per-character
 * skill. The judgement engine's `deriveKnowledgeProfile` converts a
 * `BidderProfile` to a `KnowledgeProfile` at call-site boundaries —
 * the auction, pubdeal, market, and shop call sites do this once per
 * iteration and pass the derived profile to `estimateLotValue` /
 * `estimatePriceBand`.
 *
 *   • `appraisalAccuracy[itemCategory]` ∈ [0, 1]. Drives both the
 *     condition arm (read the tier off the lot) and the price arm
 *     (£ given a kindId + tier) when derived into the new shape.
 *
 *   • `flawTypeDetection[flawType]` ∈ [0, 1]. Base detection
 *     probability for the per-flaw coin toss; the character arm's
 *     social-delta bonus adds (or subtracts) on top at pub-deal entry.
 *     Flaw types not listed fall back to `defaultFlawTypeDetection`.
 *
 *   • `inspectionAdjustment(lot)` returns an additional multiplier on
 *     the appraised value, modelling lot-specific knowledge picked up
 *     via a paid expert inspection or earned reputation. Defaults to
 *     1.0. Not yet wired through `estimateLotValue` — a future hook.
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
 * still have onward niche markets.
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
 */
export const FLAW_DISCOUNT: Readonly<Record<FlawType, number>> =
  DEFAULT_ECONOMICS_CONFIG.flawDiscount;
