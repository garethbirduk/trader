import type { Selection } from "../App.js";
import type { RunDump } from "../types.js";
import { Avatar } from "./Avatar.js";

interface ActorChipProps {
  readonly dump: RunDump;
  readonly actorId: number;
  readonly onSelect: (s: Selection) => void;
  readonly size?: number;
  readonly showName?: boolean;
}

/**
 * Compact clickable representation of an actor — used in location
 * diaries to cross-link to that actor's profile.
 */
export function ActorChip({ dump, actorId, onSelect, size = 18, showName = true }: ActorChipProps) {
  const a = dump.actors.find((x) => x.id === actorId);
  if (a === undefined) return null;
  const isPlayer = a.id === dump.playerActorId;
  return (
    <button
      type="button"
      className="actor-chip"
      onClick={() => onSelect({ kind: "actor", id: actorId })}
      title={a.displayName}
    >
      <Avatar name={a.displayName} code={a.code} isPlayer={isPlayer} size={size} />
      {showName ? <span>{a.displayName}</span> : null}
    </button>
  );
}

interface LocationLinkProps {
  readonly dump: RunDump;
  readonly locationId: number;
  readonly onSelect: (s: Selection) => void;
}

/**
 * Inline clickable location name. Renders as a button styled like a
 * link so it sits naturally inside diary rows.
 */
export function LocationLink({ dump, locationId, onSelect }: LocationLinkProps) {
  const loc = dump.locations.find((l) => l.id === locationId);
  if (loc === undefined) return <span className="muted">loc {locationId}</span>;
  return (
    <button
      type="button"
      className="location-link"
      onClick={() => onSelect({ kind: "location", id: locationId })}
    >
      {loc.displayName}
    </button>
  );
}
