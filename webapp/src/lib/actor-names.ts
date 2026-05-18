import type { RunActor } from "../types.js";

/**
 * Chip-sized actor label — the nickname / short form.
 * Returns `actor.shortName` if the engine seed set one; otherwise
 * falls back to the full `displayName`. This is what `ActorChip`
 * renders at `detail="simplified"` (the default).
 *
 * See docs/ui-rules.md → Components Rule 3 for the chip detail levels.
 */
export function chipName(actor: RunActor): string {
  return actor.shortName ?? actor.displayName;
}

/**
 * Full / directory-style actor label. Composed `firstName + " " +
 * lastName` when both are available; otherwise falls back to the
 * legacy `displayName` (which the seed currently sets to the composed
 * form already). Used by `ActorChip` at `detail="full"` — the POV
 * dropdown, the LHS Actors list, profile headers.
 *
 * Tolerates `RunActor` records that don't yet carry firstName /
 * lastName (older events.json dumps) so the chip degrades cleanly
 * during the rebuild.
 */
export function fullName(actor: RunActor): string {
  const first = actor.firstName;
  const last = actor.lastName;
  if (first !== undefined && last !== undefined && last !== null && last.length > 0) {
    return `${first} ${last}`;
  }
  if (first !== undefined && first.length > 0) return first;
  return actor.displayName;
}
