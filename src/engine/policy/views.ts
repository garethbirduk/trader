import { getActorById } from "../actors/actors-repo.js";
import type { Clock } from "../core/clock.js";
import type { DB } from "../core/db.js";
import {
  getDealsByBuyer,
  getDealsBySeller,
} from "../deals/deals-repo.js";
import type { Deal } from "../deals/types.js";
import {
  getLocationById,
  listLocations,
} from "../locations/locations.js";
import { getStockLotsByOwner } from "../stock/lots-repo.js";
import type { ActorView } from "./types.js";

/**
 * Compose an ActorView from current DB state. M5 produces a permissive
 * view — every location is "known" and every deal involving the actor is
 * surfaced. Later milestones narrow this down (e.g. only locations the
 * actor has visited, only deals they remember).
 */
export function buildActorView(
  db: DB,
  actorId: number,
  clock: Clock,
): ActorView {
  const actor = getActorById(db, actorId);
  if (!actor) throw new Error(`actor ${actorId} not found`);

  const currentLocation =
    actor.currentLocationId !== null
      ? getLocationById(db, actor.currentLocationId)
      : null;

  const inventory = getStockLotsByOwner(db, actorId);

  const dealsAsBuyer = filterOpenDeals(getDealsByBuyer(db, actorId));
  const dealsAsSeller = filterOpenDeals(getDealsBySeller(db, actorId));

  const knownLocations = listLocations(db);

  return {
    actor,
    clock,
    currentLocation,
    inventory,
    dealsAsBuyer,
    dealsAsSeller,
    knownLocations,
  };
}

function filterOpenDeals(deals: readonly Deal[]): Deal[] {
  return deals.filter(
    (d) => d.state === "agreed" || d.state === "proposed",
  );
}
