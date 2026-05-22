import { useMemo } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import type { Selection } from "../App.js";
import { useSelectionSet } from "../lib/selection-set.js";
import { CategoryTag, StockChip } from "./StockChip.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly onSelect: (s: Selection) => void;
}

export function ItemsList({ dump, day, snapshot, onSelect }: Props) {
  const set = useSelectionSet();
  void day;
  void snapshot;

  const sorted = useMemo(() => {
    return [...dump.items].sort((a, b) => {
      const cat = a.category.localeCompare(b.category);
      if (cat !== 0) return cat;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [dump.items]);

  if (sorted.length === 0) {
    return <div className="empty-state">no item kinds in this run</div>;
  }

  return (
    <ul className="items-list">
      {sorted.map((item) => (
        <li key={item.id} className="items-row">
          <CategoryTag
            category={item.category}
            onSelect={(s) => set.toggle(s)}
            selected={set.has({ kind: "category", id: 0, category: item.category })}
          />
          <StockChip
            dump={dump}
            itemKindId={item.id}
            qualityTier={null}
            quantity={null}
            observerActorId={null}
            onSelect={onSelect}
          />
        </li>
      ))}
    </ul>
  );
}
