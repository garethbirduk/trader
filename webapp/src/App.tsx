import { useEffect, useMemo, useRef, useState } from "react";
import type { DaySnapshot, RunDump } from "./types.js";
import { TimeStepper } from "./components/TimeStepper.js";
import { Sidebar } from "./components/Sidebar.js";
import { PlaybackControls } from "./components/PlaybackControls.js";
import { CurrentTimeProvider } from "./lib/current-time.js";
import { PovProvider, usePov } from "./lib/pov.js";
import { PovSwitcher } from "./components/PovSwitcher.js";
import { SelectionSetProvider, useSelectionSet } from "./lib/selection-set.js";
import { SelectionChips } from "./components/SelectionChips.js";
import { CalendarView } from "./components/CalendarView.js";
import { MapGraph } from "./components/MapGraph.js";

export type RhsTab = "calendar" | "map";

interface LoadState {
  readonly status: "loading" | "loaded" | "error";
  readonly dump?: RunDump;
  readonly error?: string;
  readonly progress?: string;
}

export type SidebarTopTab = "actors" | "locations" | "stock";

export type SelectionKind =
  | "actor"
  | "location"
  | "item"
  | "deal"
  | "lot"
  | "pool";

export interface Selection {
  readonly kind: SelectionKind;
  readonly id: number;
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [day, setDay] = useState(1);
  const [hour, setHour] = useState(0);
  const [topTab, setTopTab] = useState<SidebarTopTab>("actors");
  const [rhsTab, setRhsTab] = useState<RhsTab>("calendar");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode") ?? "static";
    if (mode === "live") {
      const seed = params.get("seed") ?? "default";
      const days = Number.parseInt(params.get("days") ?? "14", 10);
      import("./live-mode.js")
        .then(({ runLive }) =>
          runLive({
            seed,
            days: Number.isFinite(days) && days > 0 ? days : 14,
            onProgress: (progress) =>
              setState({ status: "loading", progress }),
          }),
        )
        .then((dump) => setState({ status: "loaded", dump }))
        .catch((e) => setState({ status: "error", error: (e as Error).message }));
    } else {
      fetch(`${import.meta.env.BASE_URL}events.json`)
        .then(async (res) => {
          if (!res.ok) {
            throw new Error(
              `events.json not found (HTTP ${res.status}). Run \`npm run sim -- --out webapp/public/events.json\` from the project root, or load this page with \`?mode=live\` to simulate in the browser.`,
            );
          }
          return (await res.json()) as RunDump;
        })
        .then((dump) => setState({ status: "loaded", dump }))
        .catch((e) => setState({ status: "error", error: (e as Error).message }));
    }
  }, []);

  if (state.status === "loading") {
    return (
      <div className="empty-state">
        {state.progress ? `loading… ${state.progress}` : "loading…"}
      </div>
    );
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
    <PovProvider dump={state.dump}>
      <SelectionSetProvider>
        <Loaded
          dump={state.dump}
          day={day}
          hour={hour}
          setDay={setDay}
          setHour={setHour}
          topTab={topTab}
          setTopTab={setTopTab}
          rhsTab={rhsTab}
          setRhsTab={setRhsTab}
        />
      </SelectionSetProvider>
    </PovProvider>
  );
}

interface LoadedProps {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly setDay: (d: number) => void;
  readonly setHour: (h: number) => void;
  readonly topTab: SidebarTopTab;
  readonly setTopTab: (t: SidebarTopTab) => void;
  readonly rhsTab: RhsTab;
  readonly setRhsTab: (t: RhsTab) => void;
}

const LEFT_PANEL_KEY = "trader-left-panel-px";
const DEFAULT_LEFT_PX = 320;
const MIN_LEFT_PX = 220;
const MIN_RIGHT_PX = 200;

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
  const { pov } = usePov();
  const set = useSelectionSet();
  const appRef = useRef<HTMLDivElement>(null);
  const [leftPx, setLeftPx] = useState<number>(() =>
    readPersistedPx(LEFT_PANEL_KEY, MIN_LEFT_PX, DEFAULT_LEFT_PX),
  );
  useEffect(() => {
    try {
      localStorage.setItem(LEFT_PANEL_KEY, String(Math.round(leftPx)));
    } catch {
      /* quota / disabled */
    }
  }, [leftPx]);

  const onLeftResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const app = appRef.current;
    if (app === null) return;
    const startX = e.clientX;
    const startLeft = leftPx;
    const totalW = app.getBoundingClientRect().width;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      const next = startLeft + delta;
      const maxLeft = Math.max(MIN_LEFT_PX, totalW - MIN_RIGHT_PX - 6);
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

  // Sidebar still wants the day's snapshot (lots-by-owner, etc.).
  const snapshot: DaySnapshot | null = useMemo(
    () => dump.snapshots?.find((s) => s.day === day) ?? null,
    [dump, day],
  );

  return (
    <CurrentTimeProvider value={{ day, hour }}>
      <div
        className="app"
        ref={appRef}
        data-pov={pov.kind}
        style={{
          ["--left-panel-w" as string]: `${leftPx}px`,
        }}
      >
        <header className="header">
          <h1>TRADER · sim viewer</h1>
          <div className="header-controls">
            <PovSwitcher dump={dump} />
            <div className="history-nav" role="toolbar" aria-label="Selection history">
              <button
                type="button"
                className="history-nav-btn"
                onClick={set.goBack}
                disabled={!set.canGoBack}
                title="Back (previous selection set)"
                aria-label="Back"
              >
                ←
              </button>
              <button
                type="button"
                className="history-nav-btn"
                onClick={set.goForward}
                disabled={!set.canGoForward}
                title="Forward (next selection set)"
                aria-label="Forward"
              >
                →
              </button>
            </div>
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
        <main className="rhs">
          <SelectionChips dump={dump} />
          <div className="rhs-tabs" role="tablist" aria-label="RHS view">
            <button
              type="button"
              role="tab"
              className={`rhs-tab ${props.rhsTab === "calendar" ? "rhs-tab-active" : ""}`}
              aria-selected={props.rhsTab === "calendar"}
              onClick={() => props.setRhsTab("calendar")}
            >
              Calendar
            </button>
            <button
              type="button"
              role="tab"
              className={`rhs-tab ${props.rhsTab === "map" ? "rhs-tab-active" : ""}`}
              aria-selected={props.rhsTab === "map"}
              onClick={() => props.setRhsTab("map")}
            >
              Map
            </button>
          </div>
          <div className="rhs-body">
            {props.rhsTab === "calendar" ? (
              <CalendarView
                dump={dump}
                day={day}
                hour={hour}
                snapshot={snapshot}
                onChangeDay={setDay}
                onSelect={(s) => set.replace(s)}
              />
            ) : (
              <MapGraph
                dump={dump}
                day={day}
                hour={hour}
                snapshot={snapshot}
                selection={set.primary}
                onSelect={(s) => set.replace(s)}
              />
            )}
          </div>
        </main>
      </div>
    </CurrentTimeProvider>
  );
}
