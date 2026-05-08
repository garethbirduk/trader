import type { World, Unsubscribe } from "../core/world.js";
import type { PolicyRegistry } from "../policy/runner.js";
import { runPoliciesForHour } from "../policy/runner.js";

/**
 * Wire a PolicyRegistry into the world so that every hour tick drives
 * each registered actor's policy. This is the single line that turns a
 * passive world into one with autonomous NPCs.
 */
export function registerPolicyHourTick(
  world: World,
  registry: PolicyRegistry,
): Unsubscribe {
  return world.onHour((clock) => {
    runPoliciesForHour(world.db, clock, registry, world.rng, world.events);
  });
}
