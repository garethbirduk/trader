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
 * Apply a single non-travel action to the engine state. Errors are
 * caught and turned into events rather than aborting the tick — one
 * misbehaving policy shouldn't bring down the world.
 *
 * Travel actions are handled separately in `runPoliciesForHour` so we
 * can run a clean "everyone leaves, then everyone arrives" two-phase
 * sweep across all actors before any interactions fire.
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
      // Travel is processed by the two-phase sweep in
      // `runPoliciesForHour`. If a policy somehow gets here with a
      // travel action (e.g. external caller), apply it directly.
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
 * Drive every registered policy for one hour with an explicit
 * **leave → arrive → interact** lifecycle:
 *
 *   1. **Decide & leave** — every actor's policy runs against the
 *      world as it stood at the end of the previous hour. Actors who
 *      decide to travel emit `actor.departed` from their *current*
 *      location toward their destination.
 *   2. **Arrive** — every queued movement is committed:
 *      `setActorLocation(to)` and `actor.travelled` (the arrival
 *      event) fire in the same actor-id order.
 *   3. **Other actions** — non-travel actions (settle, idle) are
 *      applied last so they reflect the post-arrival world.
 *
 * Mid-route interception (Slater spotting someone on the road
 * between leave and arrive) is deferred — for now travel is treated
 * as instantaneous within the hour, but the two-phase emission
 * gives downstream listeners a clean signal of who's on the road
 * during this hour.
 *
 * Iteration order is by actor id so two seeds with the same input
 * produce identical event streams.
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

  // Phase 1: decide actions; queue movements; emit departures.
  interface Pending {
    readonly actorId: number;
    readonly action: Action;
  }
  const movements: Array<{
    actorId: number;
    fromLocationId: number | null;
    toLocationId: number;
  }> = [];
  const otherActions: Pending[] = [];
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
    if (action.type === "travel") {
      const fromLocationId = view.currentLocation?.id ?? null;
      // Skip a no-op travel where the actor is already at the target.
      if (fromLocationId === action.toLocationId) continue;
      movements.push({
        actorId: id,
        fromLocationId,
        toLocationId: action.toLocationId,
      });
      events.emit({
        type: "actor.departed",
        at: clock,
        actorId: id,
        fromLocationId,
        toLocationId: action.toLocationId,
      });
    } else if (action.type !== "idle") {
      otherActions.push({ actorId: id, action });
    }
  }

  // Phase 2: commit arrivals.
  for (const m of movements) {
    setActorLocation(db, m.actorId, m.toLocationId);
    events.emit({
      type: "actor.travelled",
      at: clock,
      actorId: m.actorId,
      toLocationId: m.toLocationId,
    });
  }

  // Phase 3: non-travel actions (settle etc.) run after arrivals so
  // they see the post-move world.
  for (const oa of otherActions) {
    applyAction(db, oa.actorId, oa.action, clock, events);
  }
}
