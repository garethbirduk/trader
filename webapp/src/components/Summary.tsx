import { useEffect, useMemo, useRef, useState } from "react";
import type { DaySnapshot, RunDump, RunEvent, SnapshotDeal } from "../types.js";
import type { Selection } from "../App.js";
import { renderEvent } from "./renderEvent.js";
import { ItemRef, LocationRef } from "./Refs.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly onSelect: (s: Selection) => void;
}

interface CategorySpec {
  readonly key: string;
  readonly label: string;
  readonly types: readonly string[];
  readonly warn?: boolean;
}

const CATEGORIES: readonly CategorySpec[] = [
  { key: "pool.spawned", label: "Pool spawns", types: ["pool.spawned"] },
  { key: "pool.claimed", label: "Pool claims", types: ["pool.claimed"] },
  { key: "pool.flushed", label: "Pool flushes", types: ["pool.flushed"] },
  { key: "auction.cleared", label: "Auctions cleared", types: ["auction.cleared"] },
  { key: "auction.unsold", label: "Auctions unsold", types: ["auction.unsold"] },
  { key: "auction.written_off", label: "Auctions written off", types: ["auction.written_off"] },
  { key: "deal.settled", label: "Deals settled", types: ["deal.settled"] },
  { key: "deal.defaulted", label: "Deals defaulted", types: ["deal.defaulted"], warn: true },
  { key: "pubdeal.attempted", label: "Pubdeals attempted", types: ["pubdeal.attempted"] },
  { key: "pubdeal.agreed", label: "· agreed", types: ["pubdeal.agreed"] },
  { key: "pubdeal.walked", label: "· walked", types: ["pubdeal.walked"] },
  { key: "pubdeal.trust-blocked", label: "· trust-blocked", types: ["pubdeal.skipped-low-trust"] },
  { key: "gossip.exchanged", label: "Gossip exchanges", types: ["gossip.exchanged"] },
  { key: "heat.raised", label: "Heat raises", types: ["heat.raised"] },
  { key: "authority.raid", label: "🚨 Raids", types: ["authority.raid"], warn: true },
];

const LOWER_HEIGHT_KEY = "trader-rightpanel-lower-px";
const DEFAULT_LOWER_PX = 300;
const MIN_LOWER_PX = 120;
const MIN_UPPER_PX = 140;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Deal events carry only ids and totals — look up the actual line
 *  items from the snapshot so the detail panel shows what was sold. */
function renderDealEnrichment(
  event: RunEvent,
  dump: RunDump,
  snapshot: DaySnapshot | null,
  onSelect: (s: Selection) => void,
) {
  if (event.type !== "deal.settled" && event.type !== "deal.defaulted") {
    return null;
  }
  if (snapshot === null) return null;
  const dealId = event.dealId as number | undefined;
  if (typeof dealId !== "number") return null;
  const deal: SnapshotDeal | undefined = snapshot.deals.find(
    (d) => d.id === dealId,
  );
  if (deal === undefined || deal.lines.length === 0) return null;
  return (
    <div className="right-detail-deal">
      <div className="muted">
        agreed D{deal.agreedDay} · deadline D{deal.deadlineDay}
        {deal.deliveryLocationId !== null ? (
          <>
            {" · drop @ "}
            <LocationRef
              dump={dump}
              id={deal.deliveryLocationId}
              onSelect={onSelect}
              variant="inline"
            />
          </>
        ) : null}
      </div>
      <ul className="right-detail-deal-lines">
        {deal.lines.map((line, i) => (
          <li key={i}>
            <span className="cat-child-stamp">{line.quantity}</span>
            <span>
              <ItemRef
                dump={dump}
                id={line.itemKindId}
                onSelect={onSelect}
                variant="inline"
                qualityTier={line.qualityTier}
              />{" "}
              <span className="muted">@ £{line.unitPrice}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Summary({ dump, day, snapshot, onSelect }: Props) {
  // Index events into per-category buckets, filtered to "as of day".
  // We carry the original event index so detail clicks can re-render
  // identically even after sorting or filtering.
  const grouped = useMemo(() => {
    const m = new Map<string, { event: RunEvent; idx: number }[]>();
    for (const c of CATEGORIES) m.set(c.key, []);
    dump.events.forEach((e, idx) => {
      if (e.at.day > day) return;
      for (const c of CATEGORIES) {
        if (c.types.includes(e.type)) {
          m.get(c.key)!.push({ event: e, idx });
          break;
        }
      }
    });
    return m;
  }, [dump.events, day]);

  const easterEggSpawns = useMemo(
    () =>
      (grouped.get("pool.spawned") ?? []).filter(
        (x) => x.event.isEasterEgg === true,
      ).length,
    [grouped],
  );

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);

  // Drop the selection if we step backward and the event is no longer in scope.
  useEffect(() => {
    if (selectedIdx === null) return;
    const e = dump.events[selectedIdx];
    if (e === undefined || e.at.day > day) setSelectedIdx(null);
  }, [day, selectedIdx, dump.events]);

  const toggleCategory = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Lower-half resize — same pattern as the sidebar's lower split.
  const asideRef = useRef<HTMLElement>(null);
  const [lowerPx, setLowerPx] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(LOWER_HEIGHT_KEY);
      if (raw !== null) {
        const n = Number(raw);
        if (Number.isFinite(n) && n >= MIN_LOWER_PX) return n;
      }
    } catch {
      /* ignore */
    }
    return DEFAULT_LOWER_PX;
  });
  useEffect(() => {
    try {
      localStorage.setItem(LOWER_HEIGHT_KEY, String(Math.round(lowerPx)));
    } catch {
      /* quota / disabled */
    }
  }, [lowerPx]);

  const onDividerPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const aside = asideRef.current;
    if (aside === null) return;
    const startY = e.clientY;
    const startLower = lowerPx;
    const totalH = aside.getBoundingClientRect().height;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const delta = startY - ev.clientY;
      const next = startLower + delta;
      const maxLower = Math.max(MIN_LOWER_PX, totalH - MIN_UPPER_PX);
      setLowerPx(Math.min(maxLower, Math.max(MIN_LOWER_PX, next)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const selectedEvent =
    selectedIdx !== null ? dump.events[selectedIdx] ?? null : null;

  return (
    <aside className="panel right-panel" ref={asideRef}>
      <div className="right-upper">
        <h2>Cumulative through day {day}</h2>
        <ul className="cat-list">
          {CATEGORIES.map((c) => {
            const items = grouped.get(c.key) ?? [];
            const count = items.length;
            const isOpen = expanded.has(c.key);
            const eggSuffix =
              c.key === "pool.spawned" && easterEggSpawns > 0
                ? ` (${easterEggSpawns} ✨)`
                : "";
            return (
              <li key={c.key} className="cat-item">
                <button
                  className="cat-row"
                  onClick={() => toggleCategory(c.key)}
                  disabled={count === 0}
                  aria-expanded={isOpen}
                >
                  <span className="cat-arrow">
                    {count === 0 ? "·" : isOpen ? "▾" : "▸"}
                  </span>
                  <span className="cat-label">{c.label}</span>
                  <span
                    className="cat-count"
                    style={{
                      color: c.warn && count > 0 ? "var(--warn)" : undefined,
                    }}
                  >
                    {count}
                    {eggSuffix}
                  </span>
                </button>
                {isOpen && count > 0 ? (
                  <ul className="cat-children">
                    {items.map(({ event, idx }) => (
                      <li key={idx}>
                        <button
                          className={`cat-child-row ${selectedIdx === idx ? "cat-child-row-selected" : ""}`}
                          onClick={() => setSelectedIdx(idx)}
                        >
                          <span className="cat-child-stamp">
                            D{pad(event.at.day)} {pad(event.at.hour)}:00
                          </span>
                          <span className="cat-child-body">
                            {renderEvent(event, dump, onSelect)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
        <h2 style={{ marginTop: 16 }}>Final tally</h2>
        <dl className="summary">
          <dt>Run length</dt>
          <dd>{dump.runLengthDays} days</dd>
          <dt>Total events</dt>
          <dd>{dump.events.length}</dd>
        </dl>
      </div>
      <div
        className="side-divider"
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize"
        onPointerDown={onDividerPointerDown}
      >
        <span className="side-divider-grip" />
      </div>
      <div className="right-lower" style={{ height: `${lowerPx}px` }}>
        {selectedEvent === null ? (
          <div className="side-lower-empty muted">
            Select an item above to see the details.
          </div>
        ) : (
          <div className="right-detail">
            <header className="right-detail-head muted">
              D{pad(selectedEvent.at.day)} {pad(selectedEvent.at.hour)}:00 ·{" "}
              <code>{selectedEvent.type}</code>
            </header>
            <div className="right-detail-body">
              {renderEvent(selectedEvent, dump, onSelect)}
            </div>
            {renderDealEnrichment(selectedEvent, dump, snapshot, onSelect)}
            <details className="right-detail-raw">
              <summary className="muted">Raw payload</summary>
              <pre>{JSON.stringify(selectedEvent, null, 2)}</pre>
            </details>
          </div>
        )}
      </div>
    </aside>
  );
}
