import { useEffect, useMemo, useState } from "react";
import { LocationChip } from "./LocationChip.js";
import { deriveRoutineFromVenue } from "../lib/routine-from-hours.js";

/**
 * Editor for per-day opening hours on every venue that has them
 * (business / pub / auction / civic). One row per venue, seven day
 * columns; each cell takes an open hour + a close hour. Empty = the
 * venue is closed that day. Save serialises back to `openSessions[]`
 * in `locations.json`, grouping days with identical hours.
 *
 * `openHours` + `openDaysOfWeek` are not authored here on save — the
 * editor always emits `openSessions[]` because it's the canonical
 * per-day shape the engine reads first. Existing files with the older
 * compact form continue to load (the parser handles both).
 */

const HOUR_PRINT = (h: number) => (Number.isFinite(h) ? String(h) : "");

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Common day patterns. Picking one + an hour preset + Apply overwrites
 *  the whole row — selected days get the hours, others become closed. */
const DAY_PRESETS: readonly { id: string; label: string; days: readonly number[] }[] = [
  { id: "mf", label: "M–F", days: [1, 2, 3, 4, 5] },
  { id: "ms", label: "M–S", days: [1, 2, 3, 4, 5, 6] },
  { id: "fs", label: "F–S", days: [5, 6] },
  { id: "fss", label: "F–S–S", days: [5, 6, 7] },
];

const HOUR_PRESETS: readonly { id: string; label: string; open: number; close: number }[] = [
  { id: "9-17", label: "9–17", open: 9, close: 17 },
  { id: "9-18", label: "9–18", open: 9, close: 18 },
  { id: "8-16", label: "8–16", open: 8, close: 16 },
  { id: "20-24", label: "20–00", open: 20, close: 24 },
];

/** Types whose venues have meaningful opening hours. Homes / abstract
 *  are excluded. Order roughly matches the LocationPicker categories. */
const HOURS_TYPES = ["business", "pub", "auction", "civic"];
const TYPE_LABEL: Record<string, string> = {
  business: "Business",
  pub: "Pub",
  auction: "Auction",
  civic: "Service",
};

interface LocationRecord {
  readonly code: string;
  readonly displayName: string;
  readonly type?: string;
  readonly openHours?: { start: number; end: number } | null;
  readonly openSessions?: ReadonlyArray<{
    daysOfWeek: readonly number[];
    start: number;
    end: number;
  }>;
  readonly openDaysOfWeek?: readonly number[];
  // Pass-through for anything else (id, code, etc. on the engine side).
  readonly [key: string]: unknown;
}

/** Per-venue grid model — 7 cells (Mon..Sun), each null (closed) or an
 *  `{open, close}` window. Hours are integers; `close > 24` allowed for
 *  past-midnight windows (matches the engine's wrap semantics). */
interface DayWindow {
  open: number;
  close: number;
}
type Grid = (DayWindow | null)[]; // length 7, index 0 = Mon

function parseLocationToGrid(loc: LocationRecord): Grid {
  const out: Grid = Array.from({ length: 7 }, () => null);
  if (loc.openSessions !== undefined && loc.openSessions.length > 0) {
    for (const s of loc.openSessions) {
      for (const d of s.daysOfWeek) {
        if (d >= 1 && d <= 7) out[d - 1] = { open: s.start, close: s.end };
      }
    }
    return out;
  }
  if (loc.openHours !== null && loc.openHours !== undefined) {
    const days =
      loc.openDaysOfWeek !== undefined ? loc.openDaysOfWeek : [1, 2, 3, 4, 5, 6, 7];
    for (const d of days) {
      if (d >= 1 && d <= 7) {
        out[d - 1] = { open: loc.openHours.start, close: loc.openHours.end };
      }
    }
    return out;
  }
  return out;
}

/** Group days with identical (open, close) tuples into a single
 *  openSessions entry. Days that are null (closed) get omitted. */
function gridToSessions(grid: Grid): {
  daysOfWeek: number[];
  start: number;
  end: number;
}[] {
  const byKey = new Map<string, { days: number[]; start: number; end: number }>();
  for (let i = 0; i < 7; i += 1) {
    const w = grid[i];
    if (w === null || w === undefined) continue;
    const key = `${w.open}|${w.close}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.days.push(i + 1);
    } else {
      byKey.set(key, { days: [i + 1], start: w.open, end: w.close });
    }
  }
  return [...byKey.values()]
    .map((g) => ({ daysOfWeek: g.days.sort((a, b) => a - b), start: g.start, end: g.end }))
    .sort((a, b) => a.daysOfWeek[0]! - b.daysOfWeek[0]!);
}

type Status =
  | { kind: "loading" }
  | { kind: "ready"; dirty: boolean }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export function BusinessHoursEditor() {
  const [raw, setRaw] = useState<readonly LocationRecord[] | null>(null);
  const [grids, setGrids] = useState<Record<string, Grid>>({});
  const [presets, setPresets] = useState<Record<string, { day?: string; hour?: string }>>({});
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/__data?file=locations.json");
        if (!res.ok) throw new Error(`load failed (${res.status})`);
        const locs = (await res.json()) as readonly LocationRecord[];
        if (cancelled) return;
        setRaw(locs);
        const initial: Record<string, Grid> = {};
        for (const l of locs) {
          if (l.type !== undefined && HOURS_TYPES.includes(l.type)) {
            initial[l.code] = parseLocationToGrid(l);
          }
        }
        setGrids(initial);
        setStatus({ kind: "ready", dirty: false });
      } catch (e) {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-derive `dirty` whenever grids change so the save button updates.
  const dirtyCodes = useMemo(() => {
    if (raw === null) return new Set<string>();
    const out = new Set<string>();
    for (const l of raw) {
      const g = grids[l.code];
      if (g === undefined) continue;
      const original = parseLocationToGrid(l);
      if (gridsEqual(g, original)) continue;
      out.add(l.code);
    }
    return out;
  }, [raw, grids]);

  useEffect(() => {
    if (status.kind === "ready" || status.kind === "saved") {
      setStatus({ kind: "ready", dirty: dirtyCodes.size > 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtyCodes.size]);

  const setCell = (code: string, day: number, field: "open" | "close", value: string) => {
    setGrids((prev) => {
      const cur = prev[code] ?? Array.from({ length: 7 }, () => null);
      const idx = day - 1;
      const next = cur.slice();
      const trimmed = value.trim();
      if (trimmed === "") {
        // Empty either field → day becomes closed.
        next[idx] = null;
      } else {
        const n = Number.parseFloat(trimmed);
        if (!Number.isFinite(n)) return prev;
        const existing = next[idx] ?? { open: 9, close: 17 };
        next[idx] = { ...existing, [field]: n };
      }
      return { ...prev, [code]: next };
    });
  };

  const setPreset = (code: string, field: "day" | "hour", value: string) => {
    setPresets((prev) => {
      const cur = prev[code] ?? {};
      const next = { ...cur };
      // Click again to deselect.
      if (cur[field] === value) delete next[field];
      else next[field] = value;
      return { ...prev, [code]: next };
    });
  };

  const applyPreset = (code: string) => {
    const ps = presets[code];
    if (ps === undefined || ps.day === undefined || ps.hour === undefined) return;
    const dp = DAY_PRESETS.find((d) => d.id === ps.day);
    const hp = HOUR_PRESETS.find((h) => h.id === ps.hour);
    if (dp === undefined || hp === undefined) return;
    setGrids((prev) => {
      const next: Grid = Array.from({ length: 7 }, () => null);
      for (const d of dp.days) {
        if (d >= 1 && d <= 7) next[d - 1] = { open: hp.open, close: hp.close };
      }
      return { ...prev, [code]: next };
    });
  };

  const onRevert = () => {
    if (raw === null) return;
    const reset: Record<string, Grid> = {};
    for (const l of raw) {
      if (l.type !== undefined && HOURS_TYPES.includes(l.type)) {
        reset[l.code] = parseLocationToGrid(l);
      }
    }
    setGrids(reset);
  };

  const onSave = async () => {
    if (raw === null) return;
    setStatus({ kind: "saving" });
    try {
      const updated: LocationRecord[] = raw.map((l) => {
        const g = grids[l.code];
        if (g === undefined) return l;
        const sessions = gridToSessions(g);
        const next: Record<string, unknown> = { ...l };
        if (sessions.length === 0) {
          delete next.openSessions;
          delete next.openHours;
          delete next.openDaysOfWeek;
        } else {
          next.openSessions = sessions;
          // We don't author the compact form alongside; the engine
          // prefers openSessions when present so leaving the old fields
          // would be misleading.
          delete next.openHours;
          delete next.openDaysOfWeek;
        }
        return next as LocationRecord;
      });
      // Save locations.json first.
      const res = await fetch("/__data?file=locations.json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);

      // Cascade hour changes to actor routines: every actor whose
      // `worksAt` references a venue we just changed gets their
      // schedule + weekendSchedule regenerated from the new hours.
      const changedVenues = new Map<string, LocationRecord>();
      for (const l of updated) {
        if (dirtyCodes.has(l.code)) changedVenues.set(l.code, l);
      }
      if (changedVenues.size > 0) {
        const actorsRes = await fetch("/__data?file=actors.json");
        if (actorsRes.ok) {
          const actorsRaw = (await actorsRes.json()) as Array<Record<string, unknown>>;
          let touched = 0;
          for (const a of actorsRaw) {
            const worksAt = typeof a.worksAt === "string" ? a.worksAt : "";
            if (worksAt.length === 0) continue;
            const venue = changedVenues.get(worksAt);
            if (venue === undefined) continue;
            const r = deriveRoutineFromVenue(worksAt, venue);
            a.schedule = r.schedule;
            if (r.weekendSchedule.length > 0) {
              a.weekendSchedule = r.weekendSchedule;
            } else {
              delete a.weekendSchedule;
            }
            touched += 1;
          }
          if (touched > 0) {
            const cascadeRes = await fetch("/__data?file=actors.json", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(actorsRaw),
            });
            if (!cascadeRes.ok) {
              throw new Error(`actors.json cascade failed (${cascadeRes.status})`);
            }
          }
        }
      }

      setRaw(updated);
      setStatus({ kind: "saved" });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  };

  const groups = useMemo(() => {
    if (raw === null) return [];
    const byType = new Map<string, LocationRecord[]>();
    for (const l of raw) {
      if (l.type === undefined || !HOURS_TYPES.includes(l.type)) continue;
      const list = byType.get(l.type) ?? [];
      list.push(l);
      byType.set(l.type, list);
    }
    return HOURS_TYPES.filter((t) => byType.has(t)).map((t) => ({
      type: t,
      label: TYPE_LABEL[t] ?? t,
      items: byType
        .get(t)!
        .slice()
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }));
  }, [raw]);

  if (status.kind === "loading") {
    return <div className="char-editor-status muted">Loading venues…</div>;
  }
  if (status.kind === "error") {
    return <div className="char-editor-status error">Error: {status.message}</div>;
  }

  const dirty = dirtyCodes.size > 0;

  return (
    <section className="biz-editor">
      <header className="char-editor-bar">
        <span className="char-editor-title">Business hours</span>
        <span className="char-editor-stats muted">
          {Object.keys(grids).length} venues
        </span>
        <span className="char-editor-spacer" />
        {status.kind === "saved" && !dirty ? (
          <span className="char-editor-saved">
            Saved. Run <code>npm run sim -- --out webapp/public/events.json</code> then reload.
          </span>
        ) : null}
        <button
          type="button"
          className="char-editor-revert"
          onClick={onRevert}
          disabled={!dirty}
        >
          Revert
        </button>
        <button
          type="button"
          className="char-editor-save"
          onClick={onSave}
          disabled={!dirty || status.kind === "saving"}
        >
          {status.kind === "saving"
            ? "Saving…"
            : dirty
              ? `Save (${dirtyCodes.size})`
              : "Saved"}
        </button>
      </header>
      <div className="biz-editor-body">
        <table className="biz-table">
          <thead>
            <tr>
              <th className="biz-th-venue">Venue</th>
              {DAY_LABELS.map((d) => (
                <th key={d} className="biz-th-day" colSpan={2}>
                  {d}
                </th>
              ))}
              <th className="biz-th-preset">Quick apply</th>
            </tr>
            <tr className="biz-th-subrow">
              <th />
              {DAY_LABELS.flatMap((d) => [
                <th key={`${d}-open`}>open</th>,
                <th key={`${d}-close`}>close</th>,
              ])}
              <th />
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <BizGroup
                key={g.type}
                label={g.label}
                items={g.items}
                grids={grids}
                presets={presets}
                dirtyCodes={dirtyCodes}
                onChange={setCell}
                onPresetChange={setPreset}
                onApplyPreset={applyPreset}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BizGroup({
  label,
  items,
  grids,
  presets,
  dirtyCodes,
  onChange,
  onPresetChange,
  onApplyPreset,
}: {
  label: string;
  items: readonly LocationRecord[];
  grids: Record<string, Grid>;
  presets: Record<string, { day?: string; hour?: string }>;
  dirtyCodes: ReadonlySet<string>;
  onChange: (code: string, day: number, field: "open" | "close", value: string) => void;
  onPresetChange: (code: string, field: "day" | "hour", value: string) => void;
  onApplyPreset: (code: string) => void;
}) {
  return (
    <>
      <tr className="biz-group-row">
        <td colSpan={16} className="biz-group-label">
          {label}
        </td>
      </tr>
      {items.map((l) => {
        const grid = grids[l.code] ?? Array.from({ length: 7 }, () => null);
        const isDirty = dirtyCodes.has(l.code);
        const ps = presets[l.code] ?? {};
        return (
          <tr key={l.code} className={`biz-row ${isDirty ? "biz-row-dirty" : ""}`}>
            <td className="biz-td-venue">
              <LocationChip
                loc={{ code: l.code, displayName: l.displayName, ...(l.type !== undefined ? { type: l.type } : {}) }}
                size={14}
              />
            </td>
            {grid.map((w, i) => (
              <DayCell
                key={i}
                code={l.code}
                day={i + 1}
                window={w}
                onChange={onChange}
              />
            ))}
            <td className="biz-td-preset">
              <PresetControls
                code={l.code}
                selectedDay={ps.day}
                selectedHour={ps.hour}
                onPresetChange={onPresetChange}
                onApplyPreset={onApplyPreset}
              />
            </td>
          </tr>
        );
      })}
    </>
  );
}

function PresetControls({
  code,
  selectedDay,
  selectedHour,
  onPresetChange,
  onApplyPreset,
}: {
  code: string;
  selectedDay: string | undefined;
  selectedHour: string | undefined;
  onPresetChange: (code: string, field: "day" | "hour", value: string) => void;
  onApplyPreset: (code: string) => void;
}) {
  const canApply = selectedDay !== undefined && selectedHour !== undefined;
  return (
    <div className="biz-preset">
      <div className="biz-preset-group" role="group" aria-label="Days">
        {DAY_PRESETS.map((d) => (
          <button
            key={d.id}
            type="button"
            className={`biz-preset-btn ${selectedDay === d.id ? "biz-preset-btn-on" : ""}`}
            onClick={() => onPresetChange(code, "day", d.id)}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div className="biz-preset-group" role="group" aria-label="Hours">
        {HOUR_PRESETS.map((h) => (
          <button
            key={h.id}
            type="button"
            className={`biz-preset-btn ${selectedHour === h.id ? "biz-preset-btn-on" : ""}`}
            onClick={() => onPresetChange(code, "hour", h.id)}
          >
            {h.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="biz-preset-apply"
        onClick={() => onApplyPreset(code)}
        disabled={!canApply}
        title={canApply ? "Apply selected days + hours, closing other days" : "Pick a days preset and an hours preset first"}
      >
        Apply
      </button>
    </div>
  );
}

function DayCell({
  code,
  day,
  window,
  onChange,
}: {
  code: string;
  day: number;
  window: DayWindow | null;
  onChange: (code: string, day: number, field: "open" | "close", value: string) => void;
}) {
  const closed = window === null;
  return (
    <>
      <td className={`biz-td-hour ${closed ? "biz-td-closed" : ""}`}>
        <input
          className="biz-hour-input"
          type="number"
          min={0}
          max={30}
          step={1}
          value={window !== null ? HOUR_PRINT(window.open) : ""}
          placeholder="—"
          onChange={(e) => onChange(code, day, "open", e.target.value)}
        />
      </td>
      <td className={`biz-td-hour ${closed ? "biz-td-closed" : ""}`}>
        <input
          className="biz-hour-input"
          type="number"
          min={0}
          max={30}
          step={1}
          value={window !== null ? HOUR_PRINT(window.close) : ""}
          placeholder="—"
          onChange={(e) => onChange(code, day, "close", e.target.value)}
        />
      </td>
    </>
  );
}

function gridsEqual(a: Grid, b: Grid): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    if (x === null && y === null) continue;
    if (x === null || y === null) return false;
    if (x.open !== y.open || x.close !== y.close) return false;
  }
  return true;
}
