import type { RunActor } from "../types.js";

/**
 * The composed full name — `firstName + " " + lastName`, falling back
 * to `firstName` alone when there's no `lastName`, and finally to the
 * legacy `displayName` for records that don't carry firstName at all.
 * Per ui-rules.md Components Rule 3 this is the chip's hover tooltip;
 * it's not rendered as visible text.
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

/**
 * The visible label on an `ActorChip` — `shortName` when set, otherwise
 * the composed full name (Rule 3). Never falls back to `displayName`
 * directly; `fullName()` handles its own degradation for older dumps.
 */
export function chipName(actor: RunActor): string {
  if (actor.shortName !== undefined && actor.shortName !== null && actor.shortName.length > 0) {
    return actor.shortName;
  }
  return fullName(actor);
}
