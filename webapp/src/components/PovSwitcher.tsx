import { useMemo } from "react";
import { Avatar } from "./Avatar.js";
import { usePov } from "../lib/pov.js";
import type { RunDump } from "../types.js";

/**
 * Header POV control (docs/ui.md §4). Lists every actor plus Admin.
 * Shows the active POV's avatar + label. One click to switch; no
 * confirmation. The active POV is the most-prominent thing in the
 * header so the user never has to wonder "which lens am I wearing".
 */
export function PovSwitcher({ dump }: { readonly dump: RunDump }) {
  const { pov, setPov, actor, label } = usePov();

  // Sort actors: player first, then by displayName. Virtual / ledger
  // actors (Sotheby's, off-map producers) are deprioritised but kept
  // available for admin debugging.
  const orderedActors = useMemo(() => {
    return [...dump.actors].sort((a, b) => {
      const aPlayer = a.id === dump.playerActorId ? 0 : 1;
      const bPlayer = b.id === dump.playerActorId ? 0 : 1;
      if (aPlayer !== bPlayer) return aPlayer - bPlayer;
      const aVirtual = a.isVirtual === true ? 1 : 0;
      const bVirtual = b.isVirtual === true ? 1 : 0;
      if (aVirtual !== bVirtual) return aVirtual - bVirtual;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [dump.actors, dump.playerActorId]);

  return (
    <label className={`pov-switcher pov-${pov.kind}`} title="POV — whose eyes are you looking through?">
      <span className="pov-switcher-label">POV</span>
      <span className="pov-switcher-current">
        {actor !== null ? (
          <Avatar
            name={actor.displayName}
            code={actor.code}
            isPlayer={actor.id === dump.playerActorId}
            size={20}
          />
        ) : (
          <span className="pov-admin-glyph" aria-hidden="true">
            *
          </span>
        )}
        <span className="pov-switcher-name">{label}</span>
      </span>
      <select
        className="pov-switcher-select"
        value={pov.kind === "admin" ? "admin" : `actor:${pov.actorId}`}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "admin") {
            setPov({ kind: "admin" });
          } else if (v.startsWith("actor:")) {
            const id = Number.parseInt(v.slice("actor:".length), 10);
            if (Number.isFinite(id)) setPov({ kind: "actor", actorId: id });
          }
        }}
        aria-label="Select POV"
      >
        <option value="admin">Admin (omniscient)</option>
        {orderedActors.map((a) => {
          const isPlayer = a.id === dump.playerActorId;
          const virtTag = a.isVirtual === true ? " (virtual)" : "";
          const playerTag = isPlayer ? " — player" : "";
          return (
            <option key={a.id} value={`actor:${a.id}`}>
              {a.displayName}
              {playerTag}
              {virtTag}
            </option>
          );
        })}
      </select>
    </label>
  );
}
