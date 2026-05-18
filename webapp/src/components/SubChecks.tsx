import { useSelectionSet, type SelectionItem } from "../lib/selection-set.js";

/**
 * Sub-checkbox sub-row (docs/ui.md §5). Sits under each LHS row and
 * lets the user opt in to *related* entities — e.g. "include this
 * actor's home", "include this venue's stock", "select all lots at the
 * auction house".
 *
 * Two flavours:
 *   • single — toggles one related entity in/out of the set.
 *   • bulk   — adds/removes a group. The chip in the selection row
 *              shows the aggregate count.
 *
 * Renders a flat horizontal strip of pill-style checkboxes. Each
 * checkbox reflects current set membership: ticked if every item is
 * already selected, indeterminate (only for bulk) if some are.
 */
export interface SingleCheck {
  readonly kind: "single";
  readonly label: string;
  readonly item: SelectionItem;
  readonly title?: string;
}

export interface BulkCheck {
  readonly kind: "bulk";
  readonly label: string;
  readonly items: readonly SelectionItem[];
  readonly title?: string;
}

export type SubCheck = SingleCheck | BulkCheck;

interface Props {
  readonly checks: readonly SubCheck[];
}

export function SubChecks({ checks }: Props) {
  const set = useSelectionSet();
  if (checks.length === 0) return null;
  return (
    <div className="sub-checks" onClick={(e) => e.stopPropagation()}>
      {checks.map((c, i) => (
        <SubCheckPill key={i} check={c} set={set} />
      ))}
    </div>
  );
}

function SubCheckPill({
  check,
  set,
}: {
  check: SubCheck;
  set: ReturnType<typeof useSelectionSet>;
}) {
  if (check.kind === "single") {
    const on = set.has(check.item);
    return (
      <button
        type="button"
        className={`sub-check ${on ? "sub-check-on" : ""}`}
        title={check.title ?? check.label}
        onClick={() => set.toggle(check.item)}
      >
        <span className="sub-check-tick">{on ? "✓" : "+"}</span>
        <span className="sub-check-label">{check.label}</span>
      </button>
    );
  }
  // Bulk — ticked when every item is present; "some" when partial.
  const presence = check.items.map((i) => set.has(i));
  const all = presence.length > 0 && presence.every((p) => p);
  const some = !all && presence.some((p) => p);
  const klass = all ? "sub-check-on" : some ? "sub-check-some" : "";
  const click = () => {
    if (all) {
      for (const i of check.items) set.remove(i);
    } else {
      for (const i of check.items) set.add(i);
    }
  };
  return (
    <button
      type="button"
      className={`sub-check sub-check-bulk ${klass}`}
      title={check.title ?? check.label}
      onClick={click}
    >
      <span className="sub-check-tick">{all ? "✓" : some ? "·" : "+"}</span>
      <span className="sub-check-label">
        {check.label}
        <span className="sub-check-count"> ({check.items.length})</span>
      </span>
    </button>
  );
}
