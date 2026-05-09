import type { World, Unsubscribe } from "../core/world.js";
import { listActors } from "../actors/actors-repo.js";
import { listOpenAuctionLots } from "../auction/auction-repo.js";
import {
  actorHasInspectedLot,
  getKnownLotIdsByActor,
  recordLotInspected,
} from "../auction/knowledge-repo.js";

export interface AuctionInspectionOptions {
  readonly galleryLocationId: number;
  readonly auctionStartHour: number;
  readonly auctionEndHour: number;
  /**
   * Actor ids that participate in inspection autonomy. Civilians and
   * proprietors don't bother. Defaults to every actor; pass a smaller
   * set for production runs.
   */
  readonly inspectingActorIds?: ReadonlySet<number>;
  /**
   * Probability per eligible (actor, hour) slot that an actor chooses to
   * spend the hour inspecting an unknown-quality lot. Default 0.6 — they
   * usually use spare hours productively. Inspections only fire when the
   * actor is at the gallery and isn't currently bidding.
   */
  readonly inspectionChance?: number;
}

/**
 * One-hour-at-a-time lot inspection at Sotheby's. An actor at the
 * gallery during pre-auction hours (gallery-open → auctionStart-1) or
 * during a "non-bidding" auction hour can pick a future, un-inspected
 * lot they know about and spend the hour reviewing it. The result is
 * recorded as `actor_inspected_lots`; later bidder appraisal can use
 * the inspected status to decide whether the actor knows the quality
 * tier.
 *
 * This implementation is intentionally simple — every eligible slot
 * triggers the inspection chance and picks the lowest-id eligible lot.
 * A richer planner can replace it later (decide which lot is most
 * worth inspecting, save inspection slots for high-value lots, etc.).
 */
export function registerAuctionInspection(
  world: World,
  opts: AuctionInspectionOptions,
): Unsubscribe {
  const chance = opts.inspectionChance ?? 0.6;

  return world.onHour((clock) => {
    if (clock.hour > opts.auctionEndHour) return;

    for (const actor of listActors(world.db)) {
      if (
        opts.inspectingActorIds !== undefined &&
        !opts.inspectingActorIds.has(actor.id)
      ) {
        continue;
      }
      if (actor.currentLocationId !== opts.galleryLocationId) continue;

      // Identify the lot currently being bid on (if any) — this hour's
      // scheduled lot can't be inspected because it's actively up.
      const openLots = listOpenAuctionLots(world.db).filter(
        (l) => l.scheduledHour !== null && l.listedDay < clock.day,
      );
      const currentlyBidLotId = openLots.find(
        (l) => l.scheduledHour === clock.hour,
      )?.id;

      // Candidates: known + un-inspected + still on the docket today
      // and not the lot currently being bid on. Prefer future lots
      // (scheduledHour > current hour) — past lots are already gone.
      const knownIds = new Set(getKnownLotIdsByActor(world.db, actor.id));
      const candidates = openLots.filter(
        (l) =>
          knownIds.has(l.id) &&
          l.id !== currentlyBidLotId &&
          (l.scheduledHour ?? -1) > clock.hour &&
          !actorHasInspectedLot(world.db, actor.id, l.id),
      );
      if (candidates.length === 0) continue;
      if (!world.rng.chance(chance)) continue;

      // Pick the soonest upcoming lot to inspect — it gives the actor
      // info before the next bid round.
      const target = candidates.sort(
        (a, b) => (a.scheduledHour ?? 0) - (b.scheduledHour ?? 0),
      )[0]!;
      const inserted = recordLotInspected(world.db, {
        actorId: actor.id,
        lotId: target.id,
        inspectedDay: clock.day,
        inspectedHour: clock.hour,
      });
      if (inserted) {
        world.events.emit({
          type: "auction.lot-inspected",
          at: clock,
          actorId: actor.id,
          auctionLotId: target.id,
        });
      }
    }
  });
}
