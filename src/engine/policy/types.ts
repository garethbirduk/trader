import type { Actor } from "../actors/types.js";
import type { Clock } from "../core/clock.js";
import type { SeededRNG } from "../core/rng.js";
import type { Deal } from "../deals/types.js";
import type { Location } from "../locations/locations.js";
import type { StockLot } from "../stock/types.js";

/**
 * What an actor perceives of the world on a given hour. The view is a
 * value-shaped snapshot — passing it to a policy is safe and the policy
 * can hold onto it without leaking engine state. Built fresh per call.
 *
 * Crucially, this is also the entire surface a policy sees. The engine
 * does not pass an omniscient world reference; if a piece of information
 * isn't in the view, the actor doesn't know it. M5 is permissive
 * (everything visible is true), but later milestones (leads, beliefs)
 * narrow the view to what the actor is *meant* to know.
 */
export interface ActorView {
  readonly actor: Actor;
  readonly clock: Clock;
  readonly currentLocation: Location | null;
  readonly inventory: readonly StockLot[];
  readonly dealsAsBuyer: readonly Deal[];
  readonly dealsAsSeller: readonly Deal[];
  readonly knownLocations: readonly Location[];
}

export type Action =
  | { readonly type: "idle" }
  | { readonly type: "travel"; readonly toLocationId: number }
  | { readonly type: "settle"; readonly dealId: number };

export interface ActorPolicy {
  readonly id: string;
  decide(view: ActorView, rng: SeededRNG): Action;
}
