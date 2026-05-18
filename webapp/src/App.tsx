import { useEffect, useState } from "react";
import type { RunDump } from "./types.js";
import { TimeStepper } from "./components/TimeStepper.js";
import { PlaybackControls } from "./components/PlaybackControls.js";
import { CurrentTimeProvider } from "./lib/current-time.js";
import { PovProvider, usePov } from "./lib/pov.js";
import { PovSwitcher } from "./components/PovSwitcher.js";
import { SelectionSetProvider, useSelectionSet } from "./lib/selection-set.js";

// REBUILD: imports below are for components commented out during the
// UI rebuild. Restore as we re-introduce each surface.
// import { useMemo, useRef } from "react";
// import type { DaySnapshot } from "./types.js";
// import { Sidebar } from "./components/Sidebar.js";
// import { SelectionChips } from "./components/SelectionChips.js";

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
}

// REBUILD: left-panel resizer state — restored when Sidebar comes back.
// const LEFT_PANEL_KEY = "trader-left-panel-px";
// const DEFAULT_LEFT_PX = 320;
// const MIN_LEFT_PX = 220;
// const MIN_RIGHT_PX = 200;
//
// function readPersistedPx(key: string, min: number, fallback: number): number {
//   try {
//     const raw = localStorage.getItem(key);
//     if (raw !== null) {
//       const n = Number(raw);
//       if (Number.isFinite(n) && n >= min) return n;
//     }
//   } catch {
//     /* ignore */
//   }
//   return fallback;
// }

function Loaded(props: LoadedProps) {
  const { dump, day, hour, setDay, setHour } = props;
  const { pov } = usePov();
  const set = useSelectionSet();

  // REBUILD: left-panel resizer — re-enable when Sidebar returns.
  // const appRef = useRef<HTMLDivElement>(null);
  // const [leftPx, setLeftPx] = useState<number>(() =>
  //   readPersistedPx(LEFT_PANEL_KEY, MIN_LEFT_PX, DEFAULT_LEFT_PX),
  // );
  // useEffect(() => {
  //   try {
  //     localStorage.setItem(LEFT_PANEL_KEY, String(Math.round(leftPx)));
  //   } catch {
  //     /* quota / disabled */
  //   }
  // }, [leftPx]);
  // const onLeftResizeDown = (e: React.PointerEvent) => { ... };

  useEffect(() => {
    if (day > dump.runLengthDays) setDay(dump.runLengthDays);
    if (day < 1) setDay(1);
  }, [day, dump.runLengthDays, setDay]);

  // REBUILD: per-day snapshot — restored when Sidebar (or anything
  // consuming snapshot.lotsByOwner / etc.) returns.
  // const snapshot: DaySnapshot | null = useMemo(
  //   () => dump.snapshots?.find((s) => s.day === day) ?? null,
  //   [dump, day],
  // );

  // REBUILD: topTab is unused while the Sidebar is commented out. Kept
  // in props so the App-level state survives the rebuild.
  void props.topTab;
  void props.setTopTab;

  return (
    <CurrentTimeProvider value={{ day, hour }}>
      <div
        className="app app--rebuild"
        data-pov={pov.kind}
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

        {/* REBUILD: Sidebar, left-resizer, and RHS main panel are
            commented out while we rebuild the UI from the header down.
            Re-introduce one surface at a time, each routed through the
            standard chip component family (see docs/ui-rules.md).

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
            <main className="rhs-placeholder">
              <SelectionChips dump={dump} />
              <div className="rhs-stub">
                <p>RHS not built yet.</p>
              </div>
            </main>
        */}

        <main className="rebuild-stub">
          <p className="muted">
            UI rebuild in progress — only the header is wired up. Add new
            surfaces below, following <code>docs/ui-rules.md</code>.
          </p>
        </main>
      </div>
    </CurrentTimeProvider>
  );
}
