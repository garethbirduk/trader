import { useEffect, useMemo, useRef, useState } from "react";
import type { DaySnapshot, RunDump } from "./types.js";
import { TimeStepper } from "./components/TimeStepper.js";
import { EventList } from "./components/EventList.js";
import { Sidebar } from "./components/Sidebar.js";
import { Summary } from "./components/Summary.js";
import { InventoryView } from "./components/InventoryView.js";
import { DealBook } from "./components/DealBook.js";
import { PoolBoard } from "./components/PoolBoard.js";
import { MapGraph } from "./components/MapGraph.js";
import { MapEditor } from "./components/MapEditor.js";
import { PlaybackControls } from "./components/PlaybackControls.js";
import { SceneDeck } from "./components/SceneDeck.js";

const DEV = import.meta.env.DEV;

interface LoadState {
  readonly status: "loading" | "loaded" | "error";
  readonly dump?: RunDump;
  readonly error?: string;
}

type TabId =
  | "events"
  | "inventory"
  | "deals"
  | "pools"
  | "map"
  | "editor";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "events", label: "Events" },
  { id: "inventory", label: "Inventory" },
  { id: "deals", label: "Deals" },
  { id: "pools", label: "Pools" },
  { id: "map", label: "Map" },
  ...(DEV
    ? ([{ id: "editor" as const, label: "Editor" }] as const)
    : []),
];

export type SidebarTopTab = "actors" | "locations";
export type SidebarLowerTab = "profile" | "diary" | "knows" | "inventory";

export interface Selection {
  readonly kind: "actor" | "location";
  readonly id: number;
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [day, setDay] = useState(1);
  const [hour, setHour] = useState(0);
  const [tab, setTab] = useState<TabId>("events");
  const [topTab, setTopTab] = useState<SidebarTopTab>("actors");
  const [lowerTab, setLowerTab] = useState<SidebarLowerTab>("profile");
  const [selection, setSelection] = useState<Selection | null>(null);

  useEffect(() => {
    fetch("/events.json")
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(
            `events.json not found (HTTP ${res.status}). Run \`npm run sim -- --out webapp/public/events.json\` from the project root.`,
          );
        }
        return (await res.json()) as RunDump;
      })
      .then((dump) => setState({ status: "loaded", dump }))
      .catch((e) => setState({ status: "error", error: (e as Error).message }));
  }, []);

  if (state.status === "loading") {
    return <div className="empty-state">loading…</div>;
  }
  if (state.status === "error" || !state.dump) {
    return (
      <div className="error">
        <strong>Couldn't load run data.</strong>
        <pre>{state.error ?? "unknown error"}</pre>
      </div>
    );
  }

  return (
    <Loaded
      dump={state.dump}
      day={day}
      hour={hour}
      setDay={setDay}
      setHour={setHour}
      tab={tab}
      setTab={setTab}
      topTab={topTab}
      setTopTab={setTopTab}
      lowerTab={lowerTab}
      setLowerTab={setLowerTab}
      selection={selection}
      setSelection={setSelection}
    />
  );
}

interface LoadedProps {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly setDay: (d: number) => void;
  readonly setHour: (h: number) => void;
  readonly tab: TabId;
  readonly setTab: (t: TabId) => void;
  readonly topTab: SidebarTopTab;
  readonly setTopTab: (t: SidebarTopTab) => void;
  readonly lowerTab: SidebarLowerTab;
  readonly setLowerTab: (t: SidebarLowerTab) => void;
  readonly selection: Selection | null;
  readonly setSelection: (s: Selection | null) => void;
}

const RIGHT_PANEL_KEY = "trader-right-panel-px";
const DEFAULT_RIGHT_PX = 320;
const MIN_RIGHT_PX = 200;
const MIN_MAIN_PX = 360;

const LEFT_PANEL_KEY = "trader-left-panel-px";
const DEFAULT_LEFT_PX = 280;
const MIN_LEFT_PX = 220;

const MAIN_LOWER_KEY = "trader-main-lower-px";
const DEFAULT_MAIN_LOWER_PX = 240;
const MIN_MAIN_LOWER_PX = 80;
const MIN_MAIN_UPPER_PX = 200;

function readPersistedPx(key: string, min: number, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= min) return n;
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function Loaded(props: LoadedProps) {
  const { dump, day, hour, setDay, setHour } = props;
  const appRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [rightPx, setRightPx] = useState<number>(() =>
    readPersistedPx(RIGHT_PANEL_KEY, MIN_RIGHT_PX, DEFAULT_RIGHT_PX),
  );
  const [leftPx, setLeftPx] = useState<number>(() =>
    readPersistedPx(LEFT_PANEL_KEY, MIN_LEFT_PX, DEFAULT_LEFT_PX),
  );
  const [mainLowerPx, setMainLowerPx] = useState<number>(() =>
    readPersistedPx(MAIN_LOWER_KEY, MIN_MAIN_LOWER_PX, DEFAULT_MAIN_LOWER_PX),
  );
  useEffect(() => {
    try {
      localStorage.setItem(RIGHT_PANEL_KEY, String(Math.round(rightPx)));
    } catch {
      /* quota / disabled */
    }
  }, [rightPx]);
  useEffect(() => {
    try {
      localStorage.setItem(LEFT_PANEL_KEY, String(Math.round(leftPx)));
    } catch {
      /* quota / disabled */
    }
  }, [leftPx]);
  useEffect(() => {
    try {
      localStorage.setItem(MAIN_LOWER_KEY, String(Math.round(mainLowerPx)));
    } catch {
      /* quota / disabled */
    }
  }, [mainLowerPx]);

  const onMainResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const main = mainRef.current;
    if (main === null) return;
    const startY = e.clientY;
    const startLower = mainLowerPx;
    const totalH = main.getBoundingClientRect().height;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const delta = startY - ev.clientY;
      const next = startLower + delta;
      const maxLower = Math.max(MIN_MAIN_LOWER_PX, totalH - MIN_MAIN_UPPER_PX);
      setMainLowerPx(Math.min(maxLower, Math.max(MIN_MAIN_LOWER_PX, next)));
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

  const onRightResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const app = appRef.current;
    if (app === null) return;
    const startX = e.clientX;
    const startRight = rightPx;
    const totalW = app.getBoundingClientRect().width;
    (e.target as Element).setPointerCapture?.(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      // Drag left → right panel grows, main shrinks.
      const delta = startX - ev.clientX;
      const next = startRight + delta;
      // Reserve left + main min + two 6px dividers; the rest is free.
      const maxRight = Math.max(MIN_RIGHT_PX, totalW - leftPx - MIN_MAIN_PX - 12);
      setRightPx(Math.min(maxRight, Math.max(MIN_RIGHT_PX, next)));
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

  const onLeftResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const app = appRef.current;
    if (app === null) return;
    const startX = e.clientX;
    const startLeft = leftPx;
    const totalW = app.getBoundingClientRect().width;
    (e.target as Element).setPointerCapture?.(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      // Drag right → left panel grows, main shrinks.
      const delta = ev.clientX - startX;
      const next = startLeft + delta;
      const maxLeft = Math.max(MIN_LEFT_PX, totalW - rightPx - MIN_MAIN_PX - 12);
      setLeftPx(Math.min(maxLeft, Math.max(MIN_LEFT_PX, next)));
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

  useEffect(() => {
    if (day > dump.runLengthDays) setDay(dump.runLengthDays);
    if (day < 1) setDay(1);
  }, [day, dump.runLengthDays, setDay]);

  const eventsByDay = useMemo(() => groupEventsByDay(dump), [dump]);
  const todaysEvents = eventsByDay.get(day) ?? [];

  // Events visible "as of" current {day, hour} — same day events filtered
  // by hour. Earlier days included in full.
  const eventsAsOf = useMemo(() => {
    return todaysEvents.filter((e) => e.at.hour <= hour);
  }, [todaysEvents, hour]);

  // Snapshot is end-of-day state. We pass the previous day's snapshot
  // when mid-day so that "current" state can be reconstructed from
  // events; pass current day's snapshot only at end-of-day. For
  // simplicity we always pass the current day's snapshot — most views
  // (Inventory, Deals, Pools) show end-of-day for that day.
  const snapshot: DaySnapshot | null = useMemo(() => {
    return dump.snapshots?.find((s) => s.day === day) ?? null;
  }, [dump, day]);

  return (
    <div
      className="app"
      ref={appRef}
      style={{
        ["--left-panel-w" as string]: `${leftPx}px`,
        ["--right-panel-w" as string]: `${rightPx}px`,
      }}
    >
      <header className="header">
        <h1>TRADER · sim viewer</h1>
        <div className="header-controls">
          <TimeStepper
            day={day}
            hour={hour}
            maxDay={dump.runLengthDays}
            onChange={(d, h) => {
              setDay(d);
              setHour(h);
            }}
          />
          <PlaybackControls
            day={day}
            hour={hour}
            maxDay={dump.runLengthDays}
            dump={dump}
            onChange={(d, h) => {
              setDay(d);
              setHour(h);
            }}
          />
        </div>
        <div className="meta">
          seed=<strong>{dump.seed}</strong> · {dump.events.length} events
        </div>
      </header>
      <Sidebar
        dump={dump}
        day={day}
        hour={hour}
        snapshot={snapshot}
        topTab={props.topTab}
        setTopTab={props.setTopTab}
        lowerTab={props.lowerTab}
        setLowerTab={props.setLowerTab}
        selection={props.selection}
        setSelection={props.setSelection}
        onChangeDay={setDay}
      />
      <div
        className="left-resizer"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        onPointerDown={onLeftResizeDown}
      >
        <span className="left-resizer-grip" />
      </div>
      <main className="main-panel" ref={mainRef}>
        <div className="main-upper panel">
          <nav className="tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`tab ${props.tab === t.id ? "tab-active" : ""}`}
                onClick={() => props.setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="tab-body">
            {props.tab === "events" && (
              <EventList events={eventsAsOf} dump={dump} />
            )}
            {props.tab === "inventory" && (
              <InventoryView dump={dump} day={day} snapshot={snapshot} />
            )}
            {props.tab === "deals" && (
              <DealBook dump={dump} day={day} snapshot={snapshot} />
            )}
            {props.tab === "pools" && (
              <PoolBoard dump={dump} day={day} snapshot={snapshot} />
            )}
            {props.tab === "map" && (
              <MapGraph
                dump={dump}
                day={day}
                hour={hour}
                snapshot={snapshot}
                selection={props.selection}
                onSelect={props.setSelection}
              />
            )}
            {DEV && props.tab === "editor" && <MapEditor dump={dump} />}
          </div>
        </div>
        <div
          className="side-divider"
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize"
          onPointerDown={onMainResizeDown}
        >
          <span className="side-divider-grip" />
        </div>
        <div
          className="main-lower"
          style={{ height: `${mainLowerPx}px` }}
        >
          <SceneDeck
            dump={dump}
            day={day}
            hour={hour}
            snapshot={snapshot}
            onSelect={props.setSelection}
          />
        </div>
      </main>
      <div
        className="right-resizer"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        onPointerDown={onRightResizeDown}
      >
        <span className="right-resizer-grip" />
      </div>
      <Summary dump={dump} day={day} snapshot={snapshot} />
    </div>
  );
}

function groupEventsByDay(dump: RunDump): Map<number, typeof dump.events> {
  const m = new Map<number, typeof dump.events[number][]>();
  for (const e of dump.events) {
    const list = m.get(e.at.day) ?? [];
    list.push(e);
    m.set(e.at.day, list);
  }
  return m as Map<number, typeof dump.events>;
}
