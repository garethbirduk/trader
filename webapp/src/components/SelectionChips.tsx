import { useMemo } from "react";
import type { RunDump } from "../types.js";
import type { SelectionItem } from "../lib/selection-set.js";
import { useSelectionSet } from "../lib/selection-set.js";
import { Avatar } from "./Avatar.js";
import { LocationAvatar } from "./LocationAvatar.js";
import { usePov } from "../lib/pov.js";

/**
 * Selection chips row — always present at the top of the RHS
 * (docs/ui.md §6.1). Renders one chip per item in the set; each chip
 * has an `×` button to remove. Bulk-operator aggregates (§7.2) land
 * here later in Phase 3.
 *
 * In player POV, the auto-add-player rule (§7.3) means the row is
 * never visually empty. In admin POV, the empty state is "no selection
 * — viewing the world."
 */
export function SelectionChips({ dump }: { readonly dump: RunDump }) {
  const set = useSelectionSet();
  const { pov } = usePov();

  if (set.items.length === 0) {
    if (pov.kind === "admin") {
      return (
        <div className="selection-chips selection-chips-empty" role="toolbar" aria-label="Selection">
          <span className="selection-chips-hint">No selection — world view.</span>
        </div>
      );
    }
    // Player POV — should be impossible given auto-add, but render a
    // safe fallback rather than nothing.
    return null;
  }

  return (
    <div className="selection-chips" role="toolbar" aria-label="Selection">
      {set.items.map((item) => (
        <SelectionChip key={`${item.kind}:${item.id}`} item={item} dump={dump} />
      ))}
      {set.items.length > 1 ? (
        <button
          type="button"
          className="selection-chips-clear"
          onClick={() => set.clear()}
          title="Clear all"
        >
          × clear all
        </button>
      ) : null}
    </div>
  );
}

function SelectionChip({
  item,
  dump,
}: {
  readonly item: SelectionItem;
  readonly dump: RunDump;
}) {
  const set = useSelectionSet();
  const meta = useChipMeta(item, dump);
  return (
    <span className={`selection-chip selection-chip-${item.kind}`} title={meta.title}>
      {meta.avatar}
      <span className="selection-chip-label">{meta.label}</span>
      <button
        type="button"
        className="selection-chip-remove"
        onClick={() => set.remove(item)}
        aria-label={`Remove ${meta.label}`}
        title="Remove from selection"
      >
        ×
      </button>
    </span>
  );
}

interface ChipMeta {
  readonly label: string;
  readonly title: string;
  readonly avatar: JSX.Element | null;
}

function useChipMeta(item: SelectionItem, dump: RunDump): ChipMeta {
  return useMemo(() => resolveChipMeta(item, dump), [item, dump]);
}

function resolveChipMeta(item: SelectionItem, dump: RunDump): ChipMeta {
  switch (item.kind) {
    case "actor": {
      const a = dump.actors.find((x) => x.id === item.id);
      if (a === undefined) return fallback(item, "actor");
      return {
        label: a.displayName,
        title: `Actor · ${a.displayName}`,
        avatar: (
          <Avatar
            name={a.displayName}
            code={a.code}
            isPlayer={a.id === dump.playerActorId}
            size={18}
          />
        ),
      };
    }
    case "location": {
      const l = dump.locations.find((x) => x.id === item.id);
      if (l === undefined) return fallback(item, "location");
      return {
        label: l.displayName,
        title: `Location · ${l.displayName}`,
        avatar: (
          <LocationAvatar
            displayName={l.displayName}
            code={l.code}
            type={l.type}
            size={18}
          />
        ),
      };
    }
    case "item": {
      const i = dump.items.find((x) => x.id === item.id);
      if (i === undefined) return fallback(item, "item-kind");
      return {
        label: i.displayName,
        title: `Item-kind · ${i.displayName} (${i.category})`,
        avatar: null,
      };
    }
    case "deal":
      return {
        label: `Deal #${item.id}`,
        title: `Deal #${item.id}`,
        avatar: null,
      };
    case "lot":
      return {
        label: `Lot #${item.id}`,
        title: `Auction lot #${item.id}`,
        avatar: null,
      };
    case "pool":
      return {
        label: `Pool #${item.id}`,
        title: `Pool #${item.id}`,
        avatar: null,
      };
  }
}

function fallback(item: SelectionItem, kind: string): ChipMeta {
  return {
    label: `${kind} #${item.id}`,
    title: `${kind} #${item.id} (unresolved)`,
    avatar: null,
  };
}
