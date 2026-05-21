import type { RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { LocationRef } from "./Refs.js";

interface LocationLinkProps {
  readonly dump: RunDump;
  readonly locationId: number;
  readonly onSelect: (s: Selection) => void;
}

/**
 * Legacy alias for `<LocationRef variant="chip">`. Kept so existing
 * call sites keep working while the codebase migrates to <LocationRef>.
 * Now renders as a chip (square avatar + name) — matches the standard
 * for entity references across the app.
 */
export function LocationLink({ dump, locationId, onSelect }: LocationLinkProps) {
  return (
    <LocationRef
      dump={dump}
      id={locationId}
      onSelect={onSelect}
      variant="chip"
      size={14}
    />
  );
}
