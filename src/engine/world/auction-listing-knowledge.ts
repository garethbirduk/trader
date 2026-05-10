import type { World, Unsubscribe } from "../core/world.js";
import { listActors } from "../actors/actors-repo.js";
import { listOpenAuctionLots } from "../auction/auction-repo.js";
import {
  getKnownLotIdsByActor,
  recordKnownLot,
  type LearnedVia,
} from "../auction/knowledge-repo.js";

export interface AuctionListingKnowledgeOptions {
  /** Locations that carry today's paper — typically Sid's Café plus
   *  any high-street newsagents. Actors present at any of these from
   *  `paperFromHour` onward learn the day's docket. */
  readonly newspaperLocationIds: ReadonlyArray<number>;
  /** Hour of day from which the paper is available. Sid's opens 06:00,
   *  so this is 6. The high-street newsagents open at 9 — the engine
   *  only checks "actor is at a paper-drop location during/after this
   *  hour", so the per-location open-hour gate is enforced upstream by
   *  the location-presence check (actors aren't there before they open). */
  readonly paperFromHour: number;
  /** The auction gallery — Sotheby's. Actors present from
   *  `galleryFromHour` onward learn the day's docket. */
  readonly galleryLocationId: number;
  /** Hour of day from which the gallery's listing is on display. */
  readonly galleryFromHour: number;
  /** First and last hour of the auction window — actors at the gallery
   *  during these hours learn via `attended` rather than `gallery`. */
  readonly auctionStartHour: number;
  readonly auctionEndHour: number;
}

/**
 * Knowledge gating for auction lot listings. An actor only "knows" about
 * a lot once they've seen the listing through one of three channels:
 *
 *   • paper    — actor is at the newspaper location during open hours
 *   • gallery  — actor is at the auction gallery before bidding starts
 *   • attended — actor is at the gallery during the auction itself
 *   • gossip   — actor exchanges info with someone who already knows
 *
 * Without knowledge, an actor cannot plan around a lot: they don't know
 * it exists, what's in it, or what the floor is. Inspection (a separate
 * mechanic) reveals quality tier on top of basic listing data.
 */
export function registerAuctionListingKnowledge(
  world: World,
  opts: AuctionListingKnowledgeOptions,
): Unsubscribe {
  const todaysDocket = (day: number): readonly { id: number }[] => {
    // The day's docket = open lots scheduled for any hour today (set by
    // daily-auction's day-start docket pick). Cleared lots aren't here
    // because listOpenAuctionLots filters them out — once a lot's run,
    // post-auction visitors don't gain knowledge of it (it's gone).
    return listOpenAuctionLots(world.db).filter(
      (l) => l.scheduledHour !== null && l.listedDay < day,
    );
  };

  const newspaperSet = new Set(opts.newspaperLocationIds);

  const unsubHour = world.onHour((clock) => {
    const docket = todaysDocket(clock.day);
    if (docket.length === 0) return;

    for (const actor of listActors(world.db)) {
      const loc = actor.currentLocationId;
      if (loc === null) continue;
      let via: LearnedVia | null = null;
      if (newspaperSet.has(loc) && clock.hour >= opts.paperFromHour) {
        via = "paper";
      } else if (loc === opts.galleryLocationId && clock.hour >= opts.galleryFromHour) {
        via =
          clock.hour >= opts.auctionStartHour && clock.hour <= opts.auctionEndHour
            ? "attended"
            : "gallery";
      }
      if (via === null) continue;

      for (const lot of docket) {
        const inserted = recordKnownLot(world.db, {
          actorId: actor.id,
          lotId: lot.id,
          learnedDay: clock.day,
          learnedHour: clock.hour,
          learnedVia: via,
        });
        if (inserted) {
          world.events.emit({
            type: "auction.knowledge-acquired",
            at: clock,
            actorId: actor.id,
            auctionLotId: lot.id,
            via,
            fromActorId: null,
          });
        }
      }
    }
  });

  // Gossip propagation: when a gossip exchange fires, the visitor and
  // proprietor each share one auction-lot id the other doesn't yet know.
  // We piggyback on the existing gossip event rather than adding a new
  // hook — keeps the social fabric in one place.
  const unsubGossip = world.events.subscribe((e) => {
    if (e.type !== "gossip.exchanged") return;
    propagateLotKnowledge(world, e.visitorActorId, e.proprietorActorId, e.at);
    propagateLotKnowledge(world, e.proprietorActorId, e.visitorActorId, e.at);
  });

  return () => {
    unsubHour();
    unsubGossip();
  };
}

function propagateLotKnowledge(
  world: World,
  fromActorId: number,
  toActorId: number,
  clock: { day: number; hour: number },
): void {
  const fromKnown = getKnownLotIdsByActor(world.db, fromActorId);
  if (fromKnown.length === 0) return;
  const toKnown = new Set(getKnownLotIdsByActor(world.db, toActorId));
  const candidates = fromKnown.filter((id) => !toKnown.has(id));
  if (candidates.length === 0) return;
  // Only share one lot per exchange — gossip is a leaky channel, not
  // a wholesale broadcast. The receiver gets the one most likely to be
  // freshest (highest id ≈ most recently listed).
  const lotId = candidates[candidates.length - 1]!;
  const inserted = recordKnownLot(world.db, {
    actorId: toActorId,
    lotId,
    learnedDay: clock.day,
    learnedHour: clock.hour,
    learnedVia: "gossip",
    learnedFromActorId: fromActorId,
  });
  if (inserted) {
    world.events.emit({
      type: "auction.knowledge-acquired",
      at: { day: clock.day, hour: clock.hour },
      actorId: toActorId,
      auctionLotId: lotId,
      via: "gossip",
      fromActorId,
    });
  }
}
