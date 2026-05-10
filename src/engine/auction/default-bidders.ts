import type { DB } from "../core/db.js";
import type { SeededRNG } from "../core/rng.js";
import type { AuctionLot } from "./types.js";
import type { AuctionBidder } from "./auction-session.js";
import { getItemKindById } from "../stock/items-repo.js";
import { listActors } from "../actors/actors-repo.js";
import { actorKnowsFlaw } from "../inspection/inspection-repo.js";
import {
  actorHasInspectedLot,
  actorKnowsLot,
} from "./knowledge-repo.js";
import {
  FALLBACK_BIDDER_PROFILE,
  appraiseLot,
  type BidderProfile,
} from "./bidder-profile.js";
import type { FlawType, QualityTier } from "../stock/types.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
} from "../economics/config.js";

export interface BidderOptions {
  /** Per-actor bidder profiles. Actors without one use `fallbackProfile`. */
  readonly profiles?: ReadonlyMap<number, BidderProfile>;
  /** Profile used for actors not present in `profiles`. */
  readonly fallbackProfile?: BidderProfile;
  /** Actors with cash <= this floor are excluded from the bidder pool. */
  readonly minCashToParticipate?: number;
  /** Skipped actor codes (e.g. "auction-house", or the player). */
  readonly excludeActorCodes?: readonly string[];
  /** Multipliers per quality tier. Override per skin if appropriate. */
  readonly tierMultipliers?: Readonly<Record<string, number>>;
  /**
   * If set, only actors whose `current_location_id` matches this id
   * participate as bidders. Models physical attendance — you can't bid
   * at the auction if you're at the pub. Skin schedules then naturally
   * filter who shows up: NPCs whose timetables don't visit the auction
   * room never bid.
   */
  readonly requireActorAtLocationId?: number;
  /**
   * When true, actors must have learned about the lot
   * (`actor_known_lots`) before they can bid. Knowledge is acquired
   * via Sid's paper, the gallery, gossip, or attendance. Defaults
   * `false` for backwards compatibility — tests and legacy single-hour
   * auction setups that don't seed the knowledge table keep working.
   * Production runs that register the listing-knowledge handler should
   * pass `true` to enforce the gating.
   */
  readonly requireKnowledge?: boolean;
  /**
   * Tier assumed when computing valuation for an actor who knows about
   * the lot but hasn't inspected it. The actor doesn't see the real
   * tier on the listing; they bid against a guess. Default 'fair' — the
   * mid-range guess between mint and broken. Inspection (a separate
   * mechanic) reveals the real tier and lets the actor bid accurately.
   */
  readonly assumedTierWhenUninspected?: QualityTier;
  /**
   * Economic tuning bundle. Tier multipliers and other shared knobs
   * are read from here. Defaults to the engine-wide defaults. Skin can
   * pass an override via `resolveEconomicsConfig({...})`.
   */
  readonly economics?: EconomicsConfig;
  /**
   * Actor ids of off-map dealers (the wider trade scene from
   * neighbouring areas). When set, off-map bidders are capped per lot
   * by `economics.offMapAuction.maxBiddersPerLot` — locals are
   * unfiltered. Off-map dealers above the cap are randomly subsampled
   * via the world RNG.
   */
  readonly offMapDealerActorIds?: ReadonlySet<number>;
}

/**
 * The engine's default bidder generator. For each eligible actor:
 *
 *   1. Compute the lot's *true* market value:
 *        baseValue × tierMultiplier × quantity
 *   2. Run it through the actor's appraisal profile to get their perceived
 *      `valuation` — coloured by category skill, RNG-driven appraisal
 *      error, and any lot-specific inspection adjustment they hold.
 *   3. Their effective bid ceiling is `min(valuation, actor.cash)`. They
 *      won't pay more than they think it's worth, even with cash to spare;
 *      and they obviously can't pay more than they have.
 *   4. Bidders whose ceiling falls below the lot's floor drop out.
 *
 * Plug a `BidderProfile` per actor into the skin to get characters who
 * specialise (an electrical specialist, a clueless mug, etc.). Actors
 * without a profile fall back to a passable generalist.
 */
export function makeBidders(
  opts: BidderOptions = {},
): (db: DB, lot: AuctionLot, day: number, rng: SeededRNG) => readonly AuctionBidder[] {
  const economics = opts.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const profiles = opts.profiles ?? new Map<number, BidderProfile>();
  const fallback = opts.fallbackProfile ?? FALLBACK_BIDDER_PROFILE;
  const minCash = opts.minCashToParticipate ?? 100;
  const exclude = new Set(opts.excludeActorCodes ?? ["auction-house"]);
  const tierMult = opts.tierMultipliers ?? economics.tierMultipliers;
  const requireLocation = opts.requireActorAtLocationId;
  const requireKnowledge = opts.requireKnowledge ?? false;
  const assumedTier: QualityTier =
    opts.assumedTierWhenUninspected ?? economics.pubAssumedTier;
  const offMapIds = opts.offMapDealerActorIds ?? null;
  const maxOffMap = economics.offMapAuction.maxBiddersPerLot;

  return (db, lot, _day, rng) => {
    const item = getItemKindById(db, lot.itemKindId);
    if (!item) return [];
    // Two valuations: one against the lot's true tier (used by
    // inspected bidders) and one against the assumed tier (used by
    // un-inspected bidders who still know about the lot).
    const trueLotValue = Math.round(
      item.baseValue * (tierMult[lot.qualityTier] ?? 1) * lot.quantity,
    );
    const guessedLotValue = Math.round(
      item.baseValue * (tierMult[assumedTier] ?? 1) * lot.quantity,
    );

    const bidders: AuctionBidder[] = [];
    for (const a of listActors(db)) {
      if (exclude.has(a.code)) continue;
      if (a.cash <= minCash) continue;
      if (
        requireLocation !== undefined &&
        a.currentLocationId !== requireLocation
      ) {
        continue;
      }
      if (requireKnowledge && !actorKnowsLot(db, a.id, lot.id)) continue;

      // Skip actors who chose to spend this hour inspecting some other
      // lot. Inspection happens before the auction handler runs, and an
      // actor only has one hour per slot — bidding and inspecting are
      // mutually exclusive within the same hour. Only relevant when
      // knowledge gating is on (legacy mode runs all eligible bidders).
      if (
        requireKnowledge &&
        lot.scheduledHour !== null &&
        actorBusyInspectingThisHour(db, a.id, _day, lot.scheduledHour)
      ) {
        continue;
      }

      // When knowledge gating is off, fall back to the legacy
      // behaviour: bidders see the lot's actual tier. Inspection only
      // matters when gating is on.
      const inspected = !requireKnowledge || actorHasInspectedLot(db, a.id, lot.id);
      const baseProfile = profiles.get(a.id) ?? fallback;
      // If the actor has previously learned this item's flaw type
      // (via inspection or by being burned), force their detection to
      // 1.0 for that flaw — they always apply the discount on bids
      // for this item kind.
      const profile =
        item.flawType !== null && actorKnowsFlaw(db, a.id, item.id, item.flawType)
          ? withForcedFlawDetection(baseProfile, item.flawType)
          : baseProfile;
      // Uninspected bidders see the listing (item kind, qty, floor) but
      // not the quality tier; they bid against the assumed-tier guess.
      const lotForAppraisal: AuctionLot = inspected
        ? lot
        : { ...lot, qualityTier: assumedTier };
      const lotValueForAppraisal = inspected ? trueLotValue : guessedLotValue;
      const { valuation } = appraiseLot({
        profile,
        lot: lotForAppraisal,
        category: item.category,
        flawType: item.flawType,
        trueLotValue: lotValueForAppraisal,
        itemTargetCustomers: item.targetCustomers,
        rng,
        economics,
      });
      const ceiling = Math.min(valuation, a.cash);

      if (ceiling < lot.floorPrice) continue;
      bidders.push({ actorId: a.id, ceiling });
    }
    // Cap off-map bidders per lot. Locals are unaffected; if more
    // off-map dealers qualify than `maxOffMap`, pick randomly.
    if (offMapIds !== null && maxOffMap >= 0) {
      const locals: AuctionBidder[] = [];
      const offMap: AuctionBidder[] = [];
      for (const b of bidders) {
        if (offMapIds.has(b.actorId)) offMap.push(b);
        else locals.push(b);
      }
      if (offMap.length > maxOffMap) {
        // Fisher-Yates partial shuffle: pick `maxOffMap` distinct entries.
        for (let i = 0; i < maxOffMap; i += 1) {
          const j = i + Math.floor(rng.next() * (offMap.length - i));
          [offMap[i]!, offMap[j]!] = [offMap[j]!, offMap[i]!];
        }
        offMap.length = maxOffMap;
      }
      return [...locals, ...offMap];
    }
    return bidders;
  };
}

/**
 * Backwards-compatible alias. Kept so existing call sites that don't yet
 * supply profiles continue to work — they now run on the fallback
 * profile, producing slightly noisier valuations than the old direct
 * tier-multiplier formula but in the same general neighbourhood.
 */
export const makeDefaultBidders = makeBidders;

function withForcedFlawDetection(
  profile: BidderProfile,
  flawType: FlawType,
): BidderProfile {
  const merged = new Map(profile.flawTypeDetection);
  merged.set(flawType, 1);
  return {
    ...profile,
    flawTypeDetection: merged,
  };
}

function actorBusyInspectingThisHour(
  db: DB,
  actorId: number,
  day: number,
  hour: number,
): boolean {
  const row = db
    .prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM actor_inspected_lots
        WHERE actor_id = @actor AND inspected_day = @day AND inspected_hour = @hour`,
    )
    .get({ actor: actorId, day, hour });
  return (row?.n ?? 0) > 0;
}
