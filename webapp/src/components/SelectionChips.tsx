import type { RunDump } from "../types.js";
import type { SelectionItem } from "../lib/selection-set.js";
import { useSelectionSet } from "../lib/selection-set.js";
import { LocationAvatar } from "./LocationAvatar.js";
import { ActorChip } from "./ActorChip.js";
import { usePov } from "../lib/pov.js";

/**
 * Selection chips row — always present at the top of the RHS
 * (docs/ui.md §6.1). Renders one chip per item in the set; each chip
 * has an `×` button to remove. Bulk-operator aggregates (§7.2) land
 * here later in Phase 3.
 *
 * Actor chips delegate to the canonical `ActorChip` so every actor
 * reference in the app renders the same way (avatar + nickname).
 * Locations / item-kinds / deals / lots / pools still have their own
 * small inline pill until they grow their own canonical chip.
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

  // Remove button is shared across kinds — built once.
  const removeBtn = (
    <button
      type="button"
      className="selection-chip-remove"
      onClick={(e) => {
        e.stopPropagation();
        set.remove(item);
      }}
      aria-label="Remove from selection"
      title="Remove from selection"
    >
      ×
    </button>
  );

  // Actor → canonical ActorChip with the × as a suffix.
  if (item.kind === "actor") {
    const actor = dump.actors.find((x) => x.id === item.id);
    if (actor === undefined) {
      return <UnresolvedChip kind="actor" id={item.id} suffix={removeBtn} />;
    }
    return (
      <ActorChip
        actor={actor}
        dump={dump}
        size={18}
        suffix={removeBtn}
        className="actor-chip-selection"
      />
    );
  }

  // Non-actor kinds — small inline pill, no canonical chip yet.
  const meta = nonActorMeta(item, dump);
  return (
    <span className={`selection-chip selection-chip-${item.kind}`} title={meta.title}>
      {meta.avatar}
      <span className="selection-chip-label">{meta.label}</span>
      {removeBtn}
    </span>
  );
}

interface ChipMeta {
  readonly label: string;
  readonly title: string;
  readonly avatar: JSX.Element | null;
}

function nonActorMeta(item: SelectionItem, dump: RunDump): ChipMeta {
  switch (item.kind) {
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
      return { label: `Deal #${item.id}`, title: `Deal #${item.id}`, avatar: null };
    case "lot":
      return { label: `Lot #${item.id}`, title: `Auction lot #${item.id}`, avatar: null };
    case "pool":
      return { label: `Pool #${item.id}`, title: `Pool #${item.id}`, avatar: null };
    case "actor":
      // Unreachable — actor case is handled above; this case keeps the
      // switch exhaustive for the type-checker.
      return { label: `Actor #${item.id}`, title: `Actor #${item.id}`, avatar: null };
  }
}

function fallback(item: SelectionItem, kind: string): ChipMeta {
  return {
    label: `${kind} #${item.id}`,
    title: `${kind} #${item.id} (unresolved)`,
    avatar: null,
  };
}

function UnresolvedChip({
  kind,
  id,
  suffix,
}: {
  kind: string;
  id: number;
  suffix: JSX.Element;
}) {
  return (
    <span className={`selection-chip selection-chip-${kind}`} title={`${kind} #${id} (unresolved)`}>
      <span className="selection-chip-label">{kind} #{id}</span>
      {suffix}
    </span>
  );
}
