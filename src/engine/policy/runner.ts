import type { Clock } from "../core/clock.js";
import type { DB } from "../core/db.js";
import type { EventLog } from "../core/events.js";
import type { SeededRNG } from "../core/rng.js";
import { setActorLocation } from "../locations/locations.js";
import { settleDeal } from "../deals/settlement.js";
import type { Action, ActorPolicy } from "./types.js";
import { buildActorView } from "./views.js";

/**
 * Tracks which actors are driven by which policy. The same map can be
 * mutated to swap a policy at runtime — e.g. a human takes over an NPC by
 * registering a HumanInputPolicy in place of the rule-based one.
 */
export class PolicyRegistry {
  private readonly policies = new Map<number, ActorPolicy>();

  register(actorId: number, policy: ActorPolicy): void {
    this.policies.set(actorId, policy);
  }

  unregister(actorId: number): void {
    this.policies.delete(actorId);
  }

  get(actorId: number): ActorPolicy | undefined {
    return this.policies.get(actorId);
  }

  entries(): Iterable<[number, ActorPolicy]> {
    return this.policies.entries();
  }

  size(): number {
    return this.policies.size;
  }
}

/**
 * Apply a single action to the engine state. Errors are caught and turned
 * into events rather than aborting the tick — one misbehaving policy
 * shouldn't bring down the world.
 */
export function applyAction(
  db: DB,
  actorId: number,
  action: Action,
  clock: Clock,
  events: EventLog,
): void {
  switch (action.type) {
    case "idle":
      return;
    case "travel":
      setActorLocation(db, actorId, action.toLocationId);
      events.emit({
        type: "actor.travelled",
        at: clock,
        actorId,
        toLocationId: action.toLocationId,
      });
      return;
    case "settle":
      try {
        const r = settleDeal(db, action.dealId, clock.day);
        events.emit({
          type: "deal.settled",
          at: clock,
          dealId: r.deal.id,
          buyerActorId: r.deal.buyerActorId,
          sellerActorId: r.deal.sellerActorId,
          totalPrice: r.totalPrice,
        });
      } catch (e) {
        events.emit({
          type: "action.failed",
          at: clock,
          actorId,
          actionType: "settle",
          reason: (e as Error).message,
        });
      }
      return;
  }
}

/**
 * Drive every registered policy for one hour. Order is by actor id for
 * determinism. Each actor's view is rebuilt from current state so they see
 * the consequences of earlier-in-tick actions by other actors (good for
 * race-condition realism, e.g. someone else got to a location first).
 */
export function runPoliciesForHour(
  db: DB,
  clock: Clock,
  registry: PolicyRegistry,
  rng: SeededRNG,
  events: EventLog,
): void {
  const sortedIds = [...registry.entries()]
    .map(([id]) => id)
    .sort((a, b) => a - b);
  for (const id of sortedIds) {
    const policy = registry.get(id);
    if (!policy) continue;
    const view = buildActorView(db, id, clock);
    let action: Action;
    try {
      action = policy.decide(view, rng);
    } catch (e) {
      events.emit({
        type: "policy.errored",
        at: clock,
        actorId: id,
        policyId: policy.id,
        reason: (e as Error).message,
      });
      continue;
    }
    applyAction(db, id, action, clock, events);
  }
}
