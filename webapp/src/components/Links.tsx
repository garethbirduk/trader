import type { Selection } from "../App.js";
import type { RunDump } from "../types.js";
import { ActorRef, LocationRef } from "./Refs.js";

interface ActorChipProps {
  readonly dump: RunDump;
  readonly actorId: number;
  readonly onSelect: (s: Selection) => void;
  readonly size?: number;
  readonly showName?: boolean;
}

/**
 * Legacy alias for `<ActorRef variant="chip">` (or "avatar" when
 * `showName === false`). Kept so existing call sites keep working
 * while the codebase migrates to <ActorRef>.
 */
export function ActorChip({
  dump,
  actorId,
  onSelect,
  size = 18,
  showName = true,
}: ActorChipProps) {
  return (
    <ActorRef
      dump={dump}
      id={actorId}
      onSelect={onSelect}
      variant={showName ? "chip" : "avatar"}
      size={size}
    />
  );
}

interface LocationLinkProps {
  readonly dump: RunDump;
  readonly locationId: number;
  readonly onSelect: (s: Selection) => void;
}

/**
 * Legacy alias for `<LocationRef variant="inline">`. Kept so existing
 * call sites keep working while the codebase migrates to <LocationRef>.
 */
export function LocationLink({ dump, locationId, onSelect }: LocationLinkProps) {
  return (
    <LocationRef
      dump={dump}
      id={locationId}
      onSelect={onSelect}
      variant="inline"
    />
  );
}
