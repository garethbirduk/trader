import type { World, Unsubscribe } from "../core/world.js";
import type { BidderProfile } from "../auction/bidder-profile.js";
import { getStockLotsByOwner } from "../stock/lots-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import { getActorById } from "../actors/actors-repo.js";
import { listOpenAuctionLots } from "../auction/auction-repo.js";
import { getKnownLotIdsByActor } from "../auction/knowledge-repo.js";
import {
  DEFAULT_ECONOMICS_CONFIG,
  type EconomicsConfig,
  type PlannerCandidateKind,
} from "../economics/config.js";
import { isWeekend } from "../core/calendar.js";
import { estimatePriceBand } from "../perception/estimate.js";
import { deriveKnowledgeProfile } from "../knowledge/skin-seed.js";

/**
 * Per-actor, per-(day, hour) destination override decided by the
 * planner. The actor's policy callback consults `getOverride` to pick
 * the actor's location each hour, falling through to base schedule
 * when no override is present.
 */
export class PlannerRegistry {
  private readonly overrides = new Map<number, Map<number, Map<number, number>>>();
  private readonly kinds = new Map<number, Map<number, Map<number, PlannerCandidateKind>>>();

  setHourOverride(
    actorId: number,
    day: number,
    hour: number,
    locId: number,
    kind: PlannerCandidateKind,
  ): void {
    let perActorLoc = this.overrides.get(actorId);
    if (perActorLoc === undefined) {
      perActorLoc = new Map();
      this.overrides.set(actorId, perActorLoc);
    }
    let perDayLoc = perActorLoc.get(day);
    if (perDayLoc === undefined) {
      perDayLoc = new Map();
      perActorLoc.set(day, perDayLoc);
    }
    perDayLoc.set(hour, locId);

    let perActorKind = this.kinds.get(actorId);
    if (perActorKind === undefined) {
      perActorKind = new Map();
      this.kinds.set(actorId, perActorKind);
    }
    let perDayKind = perActorKind.get(day);
    if (perDayKind === undefined) {
      perDayKind = new Map();
      perActorKind.set(day, perDayKind);
    }
    perDayKind.set(hour, kind);
  }

  getOverride(actorId: number, day: number, hour: number): number | null {
    return this.overrides.get(actorId)?.get(day)?.get(hour) ?? null;
  }

  getKind(
    actorId: number,
    day: number,
    hour: number,
  ): PlannerCandidateKind | null {
    return this.kinds.get(actorId)?.get(day)?.get(hour) ?? null;
  }
}

/**
 * A location the planner may choose. Each carries its kind (drives
 * scoring), open hours (filters out closed venues), world position
 * (used for travel-cost penalty), and — for shops — the categories
 * the resident shopkeeper specialises in (drives "matched stock"
 * bonus).
 */
export interface CandidateLocation {
  readonly locId: number;
  readonly code: string;
  readonly kind: PlannerCandidateKind;
  readonly position: { readonly x: number; readonly y: number } | null;
  readonly openHours: { readonly start: number; readonly end: number } | null;
  /** For `shop` candidates only — the item categories the keeper rates
   *  highly (e.g. {electrical, tools} for Sparks Electrical). */
  readonly specialties?: ReadonlySet<string>;
}

export interface ActorPlannerOptions {
  /** Actor ids the planner runs for each hour. Fixed-job actors stay
   *  out — their schedules are authoritative. */
  readonly flexibleActorIds: ReadonlySet<number>;
  /** Per-actor bidder profile — used for category interest in lots. */
  readonly bidderProfiles: ReadonlyMap<number, BidderProfile>;
  /** Each actor's awake-hour window. Outside this range the planner
   *  forces their home location ("go to sleep"). */
  readonly awakeHoursByActor: ReadonlyMap<number, { start: number; end: number }>;
  /** Per-actor flex-hour set. Hours outside this set are "fixed" and
   *  the planner doesn't override them. */
  readonly flexibleHoursByActor: ReadonlyMap<number, ReadonlySet<number>>;
  /** Each actor's home location id (override fallback when nothing
   *  scores positively). */
  readonly homeLocationByActor: ReadonlyMap<number, number>;
  /** All candidate locations the planner may choose. */
  readonly candidates: ReadonlyArray<CandidateLocation>;
  /** Where the planner writes its decisions; the policy reads from
   *  here via the run-sim hourOverrideForActor wiring. */
  readonly registry: PlannerRegistry;
  /** Economic tuning bundle — pulls weights from `economics.planner`. */
  readonly economics?: EconomicsConfig;
}

const TRAVEL_FALLBACK_DIST = 200;

/**
 * Per-hour planner. At each hour H, for each flexible actor:
 *
 *   1. Determine the next (day, hour) we're planning for. At H=23
 *      that rolls into hour 0 of day+1.
 *   2. Skip if next hour is outside the actor's flex window — fixed
 *      hours stay fixed.
 *   3. If the actor will be asleep next hour, force home.
 *   4. Score every candidate location (open at next hour, eligible
 *      for the actor's situation), apply weekend modifier, subtract
 *      travel cost, add jitter.
 *   5. Pick argmax and write to the registry; emit `actor.planned`.
 *
 * The actor's policy callback reads the override at the next hour
 * tick and travels there.
 *
 * Register AFTER the auction listing-knowledge handler so docket
 * knowledge gained this hour informs next-hour's plan.
 */
export function registerActorPlanner(
  world: World,
  opts: ActorPlannerOptions,
): Unsubscribe {
  const economics = opts.economics ?? DEFAULT_ECONOMICS_CONFIG;
  const cfg = economics.planner;
  // Track each actor's last-emitted choice so we only fire the event
  // when the destination *changes*. Cuts trace volume by ~10×.
  const lastChoice = new Map<number, number>();

  return world.onHour((clock) => {
    const nextHour = clock.hour === 23 ? 0 : clock.hour + 1;
    const nextDay = clock.hour === 23 ? clock.day + 1 : clock.day;
    const weekend = isWeekend(nextDay);

    for (const actorId of opts.flexibleActorIds) {
      const flexHours = opts.flexibleHoursByActor.get(actorId);
      if (flexHours === undefined || !flexHours.has(nextHour)) continue;

      const homeId = opts.homeLocationByActor.get(actorId) ?? null;

      // Outside awake window? Force home.
      const awake = opts.awakeHoursByActor.get(actorId);
      if (
        awake !== undefined &&
        (nextHour < awake.start || nextHour >= awake.end)
      ) {
        if (homeId !== null) {
          opts.registry.setHourOverride(actorId, nextDay, nextHour, homeId, "home");
          maybeEmit(world, lastChoice, actorId, nextDay, nextHour, homeId, "home", 0);
        }
        continue;
      }

      const actor = getActorById(world.db, actorId);
      if (actor === null) continue;

      const profile = opts.bidderProfiles.get(actorId);

      // Inventory snapshot.
      const lots = getStockLotsByOwner(world.db, actorId);
      let totalStock = 0;
      const stockCategories = new Map<string, number>();
      for (const lot of lots) {
        totalStock += lot.quantity;
        const item = getItemKindById(world.db, lot.itemKindId);
        if (item !== null) {
          stockCategories.set(
            item.category,
            (stockCategories.get(item.category) ?? 0) + lot.quantity,
          );
        }
      }

      // Today's docket + what this actor knows about it.
      const docket = listOpenAuctionLots(world.db).filter(
        (l) => l.scheduledHour !== null && l.listedDay < nextDay,
      );
      const knownIds = new Set(getKnownLotIdsByActor(world.db, actorId));
      const knownDocketLots = docket.filter((l) => knownIds.has(l.id));
      // "Interesting lot" = the actor's perceived per-lot value (via
      // the judgement engine's price arm) >= floor × ratio. The
      // listing hides the tier, so we assume `pubAssumedTier` —
      // matches the uninspected-bidder path in default-bidders.ts.
      // estimatePriceBand is RNG-free, so the hourly planner doesn't
      // shimmer or consume RNG draws.
      let interestingCount = 0;
      if (profile !== undefined) {
        const knowledgeProfile = deriveKnowledgeProfile(profile);
        const assumedTier = economics.pubAssumedTier;
        const assumedMult = economics.tierMultipliers[assumedTier];
        for (const lot of knownDocketLots) {
          const item = getItemKindById(world.db, lot.itemKindId);
          if (item === null) continue;
          const truthUnit = item.baseValue * assumedMult;
          const band = estimatePriceBand({
            db: world.db,
            actorId,
            category: item.category,
            truth: truthUnit,
            tierMultiplier: assumedMult,
            profileOverride: knowledgeProfile,
          });
          const perceivedLotValue = band.centre * lot.quantity;
          if (perceivedLotValue >= lot.floorPrice * cfg.interestValueToFloorRatio) {
            interestingCount += 1;
          }
        }
      }

      const currentLocId = actor.currentLocationId;
      const currentPos =
        currentLocId !== null
          ? opts.candidates.find((c) => c.locId === currentLocId)?.position ?? null
          : null;

      let bestScore = -Infinity;
      let bestLocId: number | null = null;
      let bestKind: PlannerCandidateKind = "home";

      // Home is a per-actor candidate (each actor's own home, not a
      // shared list). Score it inline before the shared candidates so
      // it competes properly. Always-open by convention.
      if (homeId !== null) {
        let homeScore =
          (cfg.baseWeights.home ?? 0) + (cfg.weekendModifier.home ?? 0);
        // Travel cost from current position.
        const homePos =
          opts.candidates.find((c) => c.locId === homeId)?.position ?? null;
        if (currentPos !== null && homePos !== null) {
          homeScore -=
            Math.hypot(homePos.x - currentPos.x, homePos.y - currentPos.y) *
            cfg.travelCostWeight;
        }
        if (cfg.jitter > 0) {
          homeScore += (world.rng.next() - 0.5) * 2 * cfg.jitter;
        }
        bestScore = homeScore;
        bestLocId = homeId;
        bestKind = "home";
      }

      for (const cand of opts.candidates) {
        if (cand.kind === "home") continue; // homes handled per-actor above
        // Closed at the planning hour? Skip (home is always-open by
        // convention — its openHours is null).
        if (cand.openHours !== null) {
          const { start, end } = cand.openHours;
          if (nextHour < start || nextHour >= end) continue;
        }

        let score = cfg.baseWeights[cand.kind] ?? 0;
        score += cfg.weekendModifier[cand.kind] ?? 0;
        if (weekend && !cand.openHours) {
          // Home gets the weekend boost regardless of openHours-null vs set.
        }

        switch (cand.kind) {
          case "auction": {
            score += interestingCount * cfg.lotInterestWeight;
            if (knownDocketLots.length === 0 && docket.length > 0) {
              score += cfg.speculativeAuctionWeight;
            }
            // Skint dealers can't bid; strip auction.
            if (actor.cash <= 0) continue;
            break;
          }
          case "market": {
            score += totalStock * cfg.inventoryFullDrive;
            if (actor.cash < cfg.cashLowThreshold) score += cfg.cashLowDrive;
            if (totalStock < cfg.inventoryEmptyThreshold) {
              score += cfg.inventoryEmptyDrive;
            }
            break;
          }
          case "shop": {
            // Bonus for matched-category stock. Without matching stock,
            // there's no reason to deliberately go.
            let matched = 0;
            if (cand.specialties !== undefined) {
              for (const cat of cand.specialties) {
                matched += stockCategories.get(cat) ?? 0;
              }
            }
            if (matched === 0) continue;
            score += matched * cfg.shopSpecialtyMatchWeight;
            if (actor.cash < cfg.cashLowThreshold) score += cfg.cashLowDrive;
            break;
          }
          case "newspaper": {
            // Only useful if there's a docket the actor doesn't fully know.
            if (docket.length === 0) continue;
            if (knownDocketLots.length >= docket.length) continue;
            score += cfg.newspaperRunWeight;
            // If they're potentially auction-interested, paper run gets
            // an extra pull (they want to find out what's on).
            if (profile !== undefined) {
              const wouldGoToAuction =
                cfg.baseWeights.auction + cfg.speculativeAuctionWeight > 0;
              if (wouldGoToAuction) {
                score += cfg.speculativeAuctionWeight * 0.5;
              }
            }
            break;
          }
          case "pub":
            // Base weight + weekend modifier already applied.
            break;
        }

        // Travel cost.
        if (currentPos !== null && cand.position !== null) {
          const dist = Math.hypot(
            cand.position.x - currentPos.x,
            cand.position.y - currentPos.y,
          );
          score -= dist * cfg.travelCostWeight;
        } else if (currentLocId !== null && currentLocId !== cand.locId) {
          score -= TRAVEL_FALLBACK_DIST * cfg.travelCostWeight;
        }

        if (cfg.jitter > 0) {
          score += (world.rng.next() - 0.5) * 2 * cfg.jitter;
        }

        if (score > bestScore) {
          bestScore = score;
          bestLocId = cand.locId;
          bestKind = cand.kind;
        }
      }

      const chosenLocId = bestLocId ?? homeId;
      if (chosenLocId === null) continue;

      opts.registry.setHourOverride(
        actorId,
        nextDay,
        nextHour,
        chosenLocId,
        bestKind,
      );
      maybeEmit(
        world,
        lastChoice,
        actorId,
        nextDay,
        nextHour,
        chosenLocId,
        bestKind,
        bestScore,
      );
    }
  });
}

function maybeEmit(
  world: World,
  lastChoice: Map<number, number>,
  actorId: number,
  targetDay: number,
  targetHour: number,
  locationId: number,
  kind: PlannerCandidateKind,
  score: number,
): void {
  if (lastChoice.get(actorId) === locationId) return;
  lastChoice.set(actorId, locationId);
  world.events.emit({
    type: "actor.planned",
    at: world.clock,
    actorId,
    targetDay,
    targetHour,
    locationId,
    kind,
    score: Math.round(score * 100) / 100,
  });
}
