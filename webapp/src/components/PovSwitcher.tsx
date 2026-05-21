import { useEffect, useMemo, useRef, useState } from "react";
import { usePov } from "../lib/pov.js";
import type { RunDump } from "../types.js";
import { ActorChip } from "./ActorChip.js";
import { fullName } from "../lib/actor-names.js";

/**
 * Header POV control (docs/ui.md §4, docs/ui-rules.md POV/lens Rule 1).
 *
 * Two parts:
 *   • Admin toggle — a single button outside the actor list. When ON,
 *     the active POV is Admin regardless of what the actor picker has
 *     selected.
 *   • Actor picker — a custom listbox of `ActorChip` rows. The
 *     currently-selected actor persists while the Admin toggle is ON,
 *     and is the lens we return to when Admin flips OFF.
 *
 * The "Admin in the dropdown" pattern is forbidden — see POV/lens
 * Rule 1. All actor presentation routes through `ActorChip` per
 * Components Rule 1.
 */
const SELECTED_ACTOR_KEY = "trader-pov-selected-actor";

function readPersistedSelectedActorId(): number | null {
  try {
    const raw = localStorage.getItem(SELECTED_ACTOR_KEY);
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writePersistedSelectedActorId(id: number): void {
  try {
    localStorage.setItem(SELECTED_ACTOR_KEY, String(id));
  } catch {
    /* quota / disabled */
  }
}

export function PovSwitcher({ dump }: { readonly dump: RunDump }) {
  const { pov, setPov } = usePov();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Remember the last picked actor across Admin toggles. Seed from
  // current pov when it's an actor, otherwise from persisted state,
  // otherwise default to the player.
  const initialSelectedId = useMemo<number>(() => {
    if (pov.kind === "actor") return pov.actorId;
    const stored = readPersistedSelectedActorId();
    if (stored !== null && dump.actors.some((a) => a.id === stored)) {
      return stored;
    }
    return dump.playerActorId;
  }, [pov, dump.actors, dump.playerActorId]);

  const [selectedActorId, setSelectedActorId] = useState<number>(initialSelectedId);

  const isAdmin = pov.kind === "admin";

  // Sort: real actors by full name. Virtual actors (Sotheby's, off-map
  // market, virtual producers) are institutions / ledger sinks tied to
  // locations, not real characters — they have no viewpoint to inhabit,
  // so they're excluded from the picker. The player isn't given a
  // privileged sort position; they appear alphabetically with everyone
  // else.
  const orderedActors = useMemo(() => {
    return dump.actors
      .filter((a) => a.isVirtual !== true)
      .sort((a, b) => fullName(a).localeCompare(fullName(b)));
  }, [dump.actors]);

  const selectedActor = useMemo(
    () => dump.actors.find((a) => a.id === selectedActorId) ?? null,
    [dump.actors, selectedActorId],
  );

  // Click-outside / Escape to close the popover.
  useEffect(() => {
    if (!open) return undefined;
    const onDocPointer = (e: PointerEvent) => {
      const el = popoverRef.current;
      if (el === null) return;
      if (!el.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggleAdmin = () => {
    if (isAdmin) {
      setPov({ kind: "actor", actorId: selectedActorId });
    } else {
      setPov({ kind: "admin" });
    }
  };

  const pickActor = (id: number) => {
    setSelectedActorId(id);
    writePersistedSelectedActorId(id);
    if (!isAdmin) setPov({ kind: "actor", actorId: id });
    setOpen(false);
  };

  return (
    <div className="pov-switcher">
      <button
        type="button"
        className={`pov-admin-toggle ${isAdmin ? "is-on" : "is-off"}`}
        onClick={toggleAdmin}
        title={
          isAdmin
            ? "Admin lens ON — omniscient view. Click to return to actor lens."
            : "Admin lens OFF — viewing as the selected actor. Click to switch to omniscient view."
        }
        aria-pressed={isAdmin}
      >
        <span className="pov-admin-toggle-label">Admin</span>
        <span className="pov-admin-toggle-state">{isAdmin ? "ON" : "OFF"}</span>
      </button>

      <div
        className={`pov-actor-picker ${isAdmin ? "is-overridden" : ""}`}
        ref={popoverRef}
      >
        {selectedActor !== null ? (
          <ActorChip
            actor={selectedActor}
            dump={dump}
            onClick={() => setOpen((v) => !v)}
            className="pov-actor-trigger"
            suffix={
              <span className="pov-actor-trigger-chevron" aria-hidden="true">
                ▾
              </span>
            }
            title={
              isAdmin
                ? `Actor lens disabled while Admin is ON. Selected actor: ${fullName(selectedActor)}.`
                : `POV: ${fullName(selectedActor)}. Click to change.`
            }
          />
        ) : (
          <button
            type="button"
            className="pov-actor-trigger pov-actor-trigger--empty"
            onClick={() => setOpen((v) => !v)}
          >
            Choose actor ▾
          </button>
        )}

        {open && (
          <ul
            className="pov-listbox"
            role="listbox"
            aria-label="Choose POV actor"
          >
            {orderedActors.map((a) => (
              <li
                key={a.id}
                role="option"
                aria-selected={a.id === selectedActorId}
                className={`pov-listbox-item ${a.id === selectedActorId ? "is-selected" : ""}`}
              >
                <ActorChip
                  actor={a}
                  dump={dump}
                  onClick={() => pickActor(a.id)}
                  size={20}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
