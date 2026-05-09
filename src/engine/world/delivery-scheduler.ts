import type { World, Unsubscribe } from "../core/world.js";
import {
  getAgreedDealsDueBy,
  getDealLinesByDealId,
} from "../deals/deals-repo.js";
import {
  markDealDefaulted,
  settleDeal,
} from "../deals/settlement.js";
import { getActorById, setActorHome as _unused } from "../actors/actors-repo.js";
import { getStockLotsByOwner } from "../stock/lots-repo.js";
import { getItemKindById } from "../stock/items-repo.js";
import type { ItemSize } from "../stock/types.js";
import type { Actor, TransportCapacity } from "../actors/types.js";
void _unused;

/**
 * Per-actor scheduling info the delivery system needs. The skin assembles
 * these from the actor routine specs and hands them in at registration.
 */
export interface ActorSchedulingInfo {
  /** Hours in 0..23 the actor's routine isn't pinning them anywhere. */
  readonly flexibleHours: ReadonlySet<number>;
  /** The actor's scheduled location for each hour (used to detect that
   *  the actor's already at the pickup or dropoff location and can spare
   *  the time without breaking routine). */
  readonly schedule: ReadonlyMap<number, number>;
  /** Sleep window — start≤end means awake [start, end); end > start
   *  wraps midnight. Deliveries don't fire during sleep. */
  readonly awakeHours: { readonly start: number; readonly end: number };
}

export type GetSchedulingInfoFn = (actorId: number) => ActorSchedulingInfo | null;

export interface DeliveryPlan {
  readonly dealId: number;
  readonly sellerActorId: number;
  readonly buyerActorId: number;
  /** Where the goods physically start (seller's stock location). */
  readonly pickupLocationId: number | null;
  /** Hour the seller is at the pickup location (null if pickup === dropoff). */
  readonly pickupHour: number | null;
  /** Where the goods are being delivered to. */
  readonly dropoffLocationId: number;
  /** Hour the seller arrives at the delivery location and settlement runs. */
  readonly dropoffHour: number;
  readonly day: number;
}

/**
 * Tracks today's planned delivery trips. The policy runner asks this for
 * an override location at each hour-tick before falling back to the
 * actor's regular schedule, so the planned travel actually happens.
 */
export class DeliveryRegistry {
  private plansByDealId = new Map<number, DeliveryPlan>();
  // actorId → hour → planned location id (used by the policy override).
  private overrides = new Map<number, Map<number, number>>();

  set(plan: DeliveryPlan): void {
    this.plansByDealId.set(plan.dealId, plan);
    let perActor = this.overrides.get(plan.sellerActorId);
    if (perActor === undefined) {
      perActor = new Map();
      this.overrides.set(plan.sellerActorId, perActor);
    }
    if (plan.pickupHour !== null && plan.pickupLocationId !== null) {
      perActor.set(plan.pickupHour, plan.pickupLocationId);
    }
    perActor.set(plan.dropoffHour, plan.dropoffLocationId);
  }

  remove(dealId: number): void {
    const plan = this.plansByDealId.get(dealId);
    if (plan === undefined) return;
    this.plansByDealId.delete(dealId);
    const perActor = this.overrides.get(plan.sellerActorId);
    if (perActor !== undefined) {
      if (plan.pickupHour !== null) perActor.delete(plan.pickupHour);
      perActor.delete(plan.dropoffHour);
    }
  }

  /** Wipe all plans (called at day-end / day-start to start fresh). */
  clear(): void {
    this.plansByDealId.clear();
    this.overrides.clear();
  }

  /** Override location for an actor at a given hour, or null if none. */
  getOverride(actorId: number, hour: number): number | null {
    return this.overrides.get(actorId)?.get(hour) ?? null;
  }

  /** Plans whose dropoff is at this hour today. */
  dropoffsAtHour(hour: number): readonly DeliveryPlan[] {
    const out: DeliveryPlan[] = [];
    for (const plan of this.plansByDealId.values()) {
      if (plan.dropoffHour === hour) out.push(plan);
    }
    return out;
  }
}

export interface DailyDeliveryOptions {
  readonly registry: DeliveryRegistry;
  readonly getSchedulingInfo: GetSchedulingInfoFn;
  /** Where settlement procurement proceeds go (mirrors daily-settlement). */
  readonly procurementProceedsActorId?: number | null;
}

/**
 * Day-start: walk every agreed deal due today; plan a delivery trip for
 * each. Hour-tick: when a planned dropoff hour arrives, run settleDeal.
 *
 * Replaces the abstract day-start settlement: instead of stock teleporting
 * at midnight, the seller now physically travels to pickup + dropoff
 * locations during their flexible hours, with the deal settling on
 * arrival. If no flexible window fits the trip, the deal defaults at
 * day-start with reason "no delivery slot".
 */
export function registerDailyDelivery(
  world: World,
  opts: DailyDeliveryOptions,
): Unsubscribe {
  const unsubDay = world.onDayStart((day) => {
    opts.registry.clear();
    const due = getAgreedDealsDueBy(world.db, day);
    for (const deal of due) {
      const seller = getActorById(world.db, deal.sellerActorId);
      if (!seller) continue;
      const lines = getDealLinesByDealId(world.db, deal.id);
      const dropoffLocId = deal.deliveryLocationId;
      if (dropoffLocId === null) {
        // Legacy / pre-location deal. Settle the old way at day-start.
        settleDealOrDefault(world, deal.id, day, opts.procurementProceedsActorId ?? null);
        continue;
      }

      // Determine pickup location and required transport tier.
      const pickupLocId = pickPickupLocation(
        world,
        seller.id,
        lines.map((l) => l.itemKindId),
      );
      const requiredTier = requiredTierForDeal(world, lines.map((l) => l.itemKindId));
      const sched = opts.getSchedulingInfo(seller.id);

      // Try to plan a self-delivered trip. If the seller's transport
      // can't move the items, or no flexible slot fits, fall back to
      // abstract "magic" delivery — Sotheby's ships at a fee. Default
      // only for true failures (no stock, can't pay) which surface
      // inside settleDeal.
      const canSelfDeliver = tierSufficient(seller.transportCapacity, requiredTier);
      let plan: DeliveryPlan | null = null;
      if (canSelfDeliver && sched !== null) {
        const samePlace = pickupLocId === null || pickupLocId === dropoffLocId;
        const slot = pickSlot(
          sched,
          samePlace ? 1 : 2,
          samePlace ? [dropoffLocId] : [pickupLocId!, dropoffLocId],
        );
        if (slot !== null) {
          plan = samePlace
            ? {
                dealId: deal.id,
                sellerActorId: seller.id,
                buyerActorId: deal.buyerActorId,
                pickupLocationId: null,
                pickupHour: null,
                dropoffLocationId: dropoffLocId,
                dropoffHour: slot[0]!,
                day,
              }
            : {
                dealId: deal.id,
                sellerActorId: seller.id,
                buyerActorId: deal.buyerActorId,
                pickupLocationId: pickupLocId,
                pickupHour: slot[0]!,
                dropoffLocationId: dropoffLocId,
                dropoffHour: slot[1]!,
                day,
              };
        }
      }

      if (plan !== null) {
        opts.registry.set(plan);
      } else {
        // Magic delivery: settle abstractly at day-start with the fee.
        magicDelivery(world, deal.id, day, deal.buyerActorId, deal.sellerActorId, opts.procurementProceedsActorId ?? null);
      }
    }
  });

  const unsubHour = world.onHour((clock) => {
    const plans = opts.registry.dropoffsAtHour(clock.hour);
    for (const plan of plans) {
      // Run settlement at the dropoff hour. The actor.travelled events
      // for pickup/dropoff fire from the policy runner via the override.
      try {
        settleDeal(world.db, plan.dealId, clock.day, {
          procurementProceedsActorId: opts.procurementProceedsActorId ?? null,
          events: world.events,
          atClock: clock,
          sellerSelfDelivers: true,
        });
      } catch (e) {
        const reason = (e as Error).message;
        markDealDefaulted(world.db, plan.dealId, clock.day, reason);
        world.events.emit({
          type: "deal.defaulted",
          at: clock,
          dealId: plan.dealId,
          buyerActorId: plan.buyerActorId,
          sellerActorId: plan.sellerActorId,
          reason,
        });
      }
      opts.registry.remove(plan.dealId);
    }
  });

  return () => {
    unsubDay();
    unsubHour();
  };
}

function settleDealOrDefault(
  world: World,
  dealId: number,
  day: number,
  procurementActor: number | null,
): void {
  // Best-effort settle for legacy deals (no delivery_location_id).
  try {
    settleDeal(world.db, dealId, day, {
      procurementProceedsActorId: procurementActor,
      events: world.events,
      atClock: world.clock,
    });
  } catch (e) {
    const reason = (e as Error).message;
    markDealDefaulted(world.db, dealId, day, reason);
    // Buyer/seller ids unknown here — best-effort emit the default.
    world.events.emit({
      type: "deal.defaulted",
      at: world.clock,
      dealId,
      buyerActorId: -1,
      sellerActorId: -1,
      reason,
    });
  }
}

/**
 * Abstract "magic" delivery — used when the seller can't physically do
 * the trip (transport too small, or no flexible window). Sotheby's
 * ships the goods at the seller's transport-tier fee, the deal settles
 * at day-start, and no actor.travelled events fire. The fee path inside
 * settleDeal is gated on `sellerSelfDelivers: false`.
 */
function magicDelivery(
  world: World,
  dealId: number,
  day: number,
  buyerActorId: number,
  sellerActorId: number,
  procurementActor: number | null,
): void {
  try {
    settleDeal(world.db, dealId, day, {
      procurementProceedsActorId: procurementActor,
      events: world.events,
      atClock: world.clock,
      sellerSelfDelivers: false,
    });
  } catch (e) {
    const reason = (e as Error).message;
    markDealDefaulted(world.db, dealId, day, reason);
    world.events.emit({
      type: "deal.defaulted",
      at: world.clock,
      dealId,
      buyerActorId,
      sellerActorId,
      reason,
    });
  }
}

function pickPickupLocation(
  world: World,
  sellerId: number,
  itemKindIds: readonly number[],
): number | null {
  const lots = getStockLotsByOwner(world.db, sellerId);
  // Filter to lots matching the deal's items and pick the location with
  // the most matching units.
  const wanted = new Set(itemKindIds);
  const byLoc = new Map<number, number>();
  for (const lot of lots) {
    if (!wanted.has(lot.itemKindId)) continue;
    if (lot.locationId === null) continue;
    byLoc.set(lot.locationId, (byLoc.get(lot.locationId) ?? 0) + lot.quantity);
  }
  if (byLoc.size === 0) {
    // Fall back to the seller's lockup.
    const seller = getActorById(world.db, sellerId);
    return seller?.lockupLocationId ?? null;
  }
  let best: number | null = null;
  let bestQty = -1;
  for (const [loc, qty] of byLoc) {
    if (qty > bestQty) {
      best = loc;
      bestQty = qty;
    }
  }
  return best;
}

const TIER_RANK: Record<TransportCapacity, number> = {
  none: 0,
  pocket: 1,
  boot: 2,
  van: 3,
  truck: 4,
};

const SIZE_TO_TIER: Record<ItemSize, TransportCapacity> = {
  small: "pocket",
  mid: "boot",
  large: "van",
};

function tierSufficient(have: TransportCapacity, need: TransportCapacity): boolean {
  return TIER_RANK[have] >= TIER_RANK[need];
}

function requiredTierForDeal(
  world: World,
  itemKindIds: readonly number[],
): TransportCapacity {
  let needed: TransportCapacity = "pocket";
  for (const id of itemKindIds) {
    const item = getItemKindById(world.db, id);
    if (!item) continue;
    const tier = SIZE_TO_TIER[item.size];
    if (TIER_RANK[tier] > TIER_RANK[needed]) needed = tier;
  }
  return needed;
}

/**
 * Find a window of `hoursNeeded` consecutive hours within the actor's
 * awake window where each hour's location is either flexible or matches
 * the trip leg's expected location (so being at the pickup with the
 * stock during work hours counts as "free" for the pickup leg).
 *
 * `legLocations[i]` is the expected location at the i-th hour of the
 * window. If the actor's scheduled location for that hour equals the
 * leg's location, the slot is acceptable.
 *
 * Returns the picked hours [h0, h1, ...] or null if no fit.
 */
function pickSlot(
  sched: ActorSchedulingInfo,
  hoursNeeded: number,
  legLocations: readonly number[],
): readonly number[] | null {
  const { start, end } = sched.awakeHours;
  const awake: number[] = [];
  if (start <= end) {
    for (let h = start; h < end; h += 1) awake.push(h);
  } else {
    for (let h = start; h < 24; h += 1) awake.push(h);
    for (let h = 0; h < end; h += 1) awake.push(h);
  }
  const isAvailable = (h: number, legLoc: number): boolean => {
    if (sched.flexibleHours.has(h)) return true;
    const sched_loc = sched.schedule.get(h);
    return sched_loc === legLoc;
  };
  let i = 0;
  while (i + hoursNeeded <= awake.length) {
    let ok = true;
    for (let k = 0; k < hoursNeeded; k += 1) {
      const h = awake[i + k]!;
      const legLoc = legLocations[k]!;
      if (!isAvailable(h, legLoc)) {
        ok = false;
        i += k + 1;
        break;
      }
    }
    if (ok) {
      const pick: number[] = [];
      for (let k = 0; k < hoursNeeded; k += 1) pick.push(awake[i + k]!);
      return pick;
    }
  }
  return null;
}

/** Helper for tests / consumers that just want a quick lookup. */
export function actorIsScheduledForDelivery(
  registry: DeliveryRegistry,
  actor: Actor,
  hour: number,
): number | null {
  return registry.getOverride(actor.id, hour);
}
