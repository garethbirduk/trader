import type { RunActor } from "../types.js";

/**
 * Chip-sized actor label. Returns the actor's `shortName` (nickname)
 * if the engine seed set one; otherwise the full `displayName`.
 *
 * Use on chip / pill surfaces:
 *   • selection chips at the top of the RHS
 *   • mini actor rows under location blocks
 *   • "owned by [Owner]" chips beside stock items
 *
 * Use `actor.displayName` directly in list contexts where you want
 * the full canonical name (LHS Actors list, profile headers, POV
 * dropdown). The dichotomy mirrors how characters are referred to in
 * conversation vs in formal records.
 */
export function chipName(actor: RunActor): string {
  return actor.shortName ?? actor.displayName;
}
