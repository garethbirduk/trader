import { useEffect, useMemo, useState } from "react";
import type { DaySnapshot, RunDump } from "./types.js";
import { TimeStepper } from "./components/TimeStepper.js";
import { EventList } from "./components/EventList.js";
import { Sidebar } from "./components/Sidebar.js";
import { Summary } from "./components/Summary.js";
import { InventoryView } from "./components/InventoryView.js";
import { DealBook } from "./components/DealBook.js";
import { PoolBoard } from "./components/PoolBoard.js";
import { MapGraph } from "./components/MapGraph.js";
import { PlaybackControls } from "./components/PlaybackControls.js";

interface LoadState {
  readonly status: "loading" | "loaded" | "error";
  readonly dump?: RunDump;
  readonly error?: string;
}

type TabId = "events" | "inventory" | "deals" | "pools" | "map";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "events", label: "Events" },
  { id: "inventory", label: "Inventory" },
  { id: "deals", label: "Deals" },
  { id: "pools", label: "Pools" },
  { id: "map", label: "Map" },
];

export type SidebarTopTab = "actors" | "locations";
export type SidebarLowerTab = "profile" | "diary";

export interface Selection {
  readonly kind: "actor" | "location";
  readonly id: number;
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [day, setDay] = useState(1);
  const [hour, setHour] = useState(8);
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

function Loaded(props: LoadedProps) {
  const { dump, day, hour, setDay, setHour } = props;

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
    <div className="app">
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
      <main className="panel main-panel">
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
        </div>
      </main>
      <Summary dump={dump} day={day} />
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
