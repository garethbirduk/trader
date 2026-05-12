import type { DB } from "../core/db.js";

/**
 * Per-(actor, clearance_listing) knowledge — mirrors the auction's
 * `actor_known_lots`. An actor only knows about a listing if they
 * picked it up via paper / gossip / overhearing a booking call.
 */

export type ClearanceLearnedVia = "paper" | "gossip" | "overheard";

export interface ActorKnownClearance {
  readonly actorId: number;
  readonly listingId: number;
  readonly learnedDay: number;
  readonly learnedHour: number;
  readonly learnedVia: ClearanceLearnedVia;
  readonly learnedFromActorId: number | null;
}

interface Row {
  actor_id: number;
  listing_id: number;
  learned_day: number;
  learned_hour: number;
  learned_via: string;
  learned_from_actor_id: number | null;
}

function rowTo(r: Row): ActorKnownClearance {
  if (r.learned_via !== "paper" && r.learned_via !== "gossip" && r.learned_via !== "overheard") {
    throw new Error(`invalid learned_via: ${r.learned_via}`);
  }
  return {
    actorId: r.actor_id,
    listingId: r.listing_id,
    learnedDay: r.learned_day,
    learnedHour: r.learned_hour,
    learnedVia: r.learned_via,
    learnedFromActorId: r.learned_from_actor_id,
  };
}

export function recordClearanceKnowledge(
  db: DB,
  args: {
    actorId: number;
    listingId: number;
    learnedDay: number;
    learnedHour: number;
    learnedVia: ClearanceLearnedVia;
    learnedFromActorId?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO actor_known_clearance_listings
       (actor_id, listing_id, learned_day, learned_hour, learned_via,
        learned_from_actor_id)
     VALUES (@actor, @listing, @day, @hour, @via, @from)
     ON CONFLICT (actor_id, listing_id) DO NOTHING`,
  ).run({
    actor: args.actorId,
    listing: args.listingId,
    day: args.learnedDay,
    hour: args.learnedHour,
    via: args.learnedVia,
    from: args.learnedFromActorId ?? null,
  });
}

export function actorKnowsClearance(
  db: DB,
  actorId: number,
  listingId: number,
): boolean {
  const row = db
    .prepare<{ n: number }>(
      `SELECT COUNT(*) AS n FROM actor_known_clearance_listings
         WHERE actor_id = @actor AND listing_id = @listing`,
    )
    .get({ actor: actorId, listing: listingId });
  return (row?.n ?? 0) > 0;
}

export function getKnownClearanceIdsForActor(
  db: DB,
  actorId: number,
): number[] {
  return db
    .prepare<{ listing_id: number }>(
      `SELECT listing_id FROM actor_known_clearance_listings
         WHERE actor_id = @actor`,
    )
    .all({ actor: actorId })
    .map((r) => r.listing_id);
}

export function getKnownClearancesForActor(
  db: DB,
  actorId: number,
): ActorKnownClearance[] {
  return db
    .prepare<Row>(
      `SELECT * FROM actor_known_clearance_listings
         WHERE actor_id = @actor
         ORDER BY learned_day ASC, learned_hour ASC, listing_id ASC`,
    )
    .all({ actor: actorId })
    .map(rowTo);
}
