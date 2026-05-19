import { useEffect, useRef, useState } from "react";
import { LocationChip } from "./LocationChip.js";

/**
 * Chip-styled replacement for a native <select> over a location list.
 * The closed-state button shows the current selection as a proper chip
 * (avatar + name), and the popover lists every option as a chip too
 * (grouped by location type via <optgroup>-style headers).
 *
 * Native <select> options can only contain plain text — so to honour
 * the "all data presentation is a chip" UI rule for location pickers
 * we render a custom popover instead. Keyboard nav is intentionally
 * minimal here (Esc + click-to-select); add as it becomes painful.
 */

export interface LocationOption {
  readonly code: string;
  readonly displayName: string;
  readonly type?: string;
}

export interface LocationOptGroup {
  readonly label: string;
  readonly items: readonly LocationOption[];
}

export interface LocationPickerProps {
  readonly value: string;
  readonly groups: readonly LocationOptGroup[];
  readonly placeholder?: string;
  readonly nullable?: boolean;
  readonly onChange: (code: string) => void;
}

export function LocationPicker({
  value,
  groups,
  placeholder = "— none —",
  nullable = false,
  onChange,
}: LocationPickerProps) {
  const [open, setOpen] = useState(false);
  const [popRect, setPopRect] = useState<{ top: number; left: number; minWidth: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Resolve the selected option to display in the button.
  const allItems = groups.flatMap((g) => g.items);
  const selected = allItems.find((l) => l.code === value);

  // Position the popover under the button using viewport coordinates so
  // it can escape ancestor `overflow: hidden` / `overflow: auto`
  // containers (the RHS body, the household card). Recomputed on open;
  // we close on outside scroll rather than chase the button around.
  useEffect(() => {
    if (!open) return;
    const btn = btnRef.current;
    if (btn === null) return;
    const r = btn.getBoundingClientRect();
    setPopRect({ top: r.bottom + 2, left: r.left, minWidth: r.width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const root = rootRef.current;
      const pop = popRef.current;
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (root !== null && root.contains(t)) return;
      if (pop !== null && pop.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScroll = (e: Event) => {
      // Scrolling outside the popover invalidates its anchor — close
      // rather than try to keep it stuck to a moving button.
      const pop = popRef.current;
      if (pop !== null && e.target instanceof Node && pop.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", () => setOpen(false));
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const pick = (code: string) => {
    onChange(code);
    setOpen(false);
  };

  return (
    <span className="loc-picker" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className={`loc-picker-btn ${open ? "loc-picker-btn-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={selected?.displayName ?? placeholder}
      >
        {selected !== undefined ? (
          <LocationChip loc={selected} size={14} className="loc-picker-chip" />
        ) : (
          <span className="loc-picker-empty muted">{placeholder}</span>
        )}
        <span className="loc-picker-caret muted">▾</span>
      </button>
      {open && popRect !== null ? (
        <div
          ref={popRef}
          className="loc-picker-popover"
          role="listbox"
          style={{
            position: "fixed",
            top: popRect.top,
            left: popRect.left,
            minWidth: popRect.minWidth,
          }}
        >
          {nullable ? (
            <button
              type="button"
              className={`loc-picker-option ${value === "" ? "is-selected" : ""}`}
              onClick={() => pick("")}
            >
              <span className="loc-picker-empty muted">{placeholder}</span>
            </button>
          ) : null}
          {groups.map((g) => (
            <div key={g.label} className="loc-picker-group">
              <div className="loc-picker-group-label muted">{g.label}</div>
              {g.items.map((l) => (
                <LocationChip
                  key={l.code}
                  loc={l}
                  detail="full"
                  size={14}
                  onClick={() => pick(l.code)}
                  state={l.code === value ? "on" : "off"}
                  className="loc-picker-option"
                />
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </span>
  );
}
