import { useEffect, useMemo, useRef, useState } from "react";
import type { DaySnapshot, RunDump } from "./types.js";
import { TimeStepper } from "./components/TimeStepper.js";
import { Sidebar } from "./components/Sidebar.js";
import { PlaybackControls } from "./components/PlaybackControls.js";
import { CurrentTimeProvider } from "./lib/current-time.js";
import { PovProvider, usePov, type Pov } from "./lib/pov.js";
import { ShowMathProvider, useShowMath } from "./lib/show-math.js";
import { useKnownIds } from "./lib/pov-knowledge.js";
import { PovSwitcher } from "./components/PovSwitcher.js";
import { SelectionSetProvider, useSelectionSet } from "./lib/selection-set.js";
import { SelectionChips } from "./components/SelectionChips.js";
import { CalendarView } from "./components/CalendarView.js";
import { MapGraph } from "./components/MapGraph.js";
import { CharacterEditor } from "./components/CharacterEditor.js";
import { MapEditor } from "./components/MapEditor.js";
import { BusinessHoursEditor } from "./components/BusinessHoursEditor.js";
import { SceneDeck } from "./components/SceneDeck.js";
import { DealBook } from "./components/DealBook.js";
import { InventoryView } from "./components/InventoryView.js";
import { PoolBoard } from "./components/PoolBoard.js";
import { ItemsList } from "./components/ItemsList.js";
import { GossipBoard } from "./components/GossipBoard.js";
import { GraphScratchpad } from "./components/GraphScratchpad.js";

export type RhsTab =
  | "calendar"
  | "map"
  | "deals"
  | "lots"
  | "pools"
  | "items"
  | "gossip"
  | "scratchpad"
  | "editor";
export type EditorSubTab = "residences" | "actors" | "businesses" | "map";

const DEV = import.meta.env.DEV;

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
  | "pool"
  | "category";

export interface Selection {
  readonly kind: SelectionKind;
  readonly id: number;
  /** Only set when kind === "category" — the category string key
   *  (item kind taxonomy bucket; tools / food / electronics …).
   *  For all other kinds `id` is the identifier; `id` is unused for
   *  category items (set to 0). */
  readonly category?: string;
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [day, setDay] = useState(1);
  const [hour, setHour] = useState(0);
  const [topTab, setTopTab] = useState<SidebarTopTab>("actors");
  const [rhsTab, setRhsTab] = useState<RhsTab>("calendar");
  const [editorSubTab, setEditorSubTab] = useState<EditorSubTab>("residences");

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
      <ShowMathProvider>
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
          editorSubTab={editorSubTab}
          setEditorSubTab={setEditorSubTab}
        />
        </SelectionSetProvider>
      </ShowMathProvider>
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
  readonly editorSubTab: EditorSubTab;
  readonly setEditorSubTab: (t: EditorSubTab) => void;
}

const LEFT_PANEL_KEY = "trader-left-panel-px";
const DEFAULT_LEFT_PX = 320;
const MIN_LEFT_PX = 220;
const MIN_RIGHT_PX = 200;

const LOWER_PANEL_KEY = "trader-lower-panel-px";
const DEFAULT_LOWER_PX = 340;
const MIN_LOWER_PX = 120;
const MIN_UPPER_PX = 200;

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

  // POV transition prune (see memory: feedback-pov-prune-selection).
  // When admin→actor or actor→actor, drop selection entries the new
  // POV doesn't know. An emptied set defers to selection-set §7.3's
  // auto-add-self rule, which seeds the POV chip as the default.
  const povActorId = pov.kind === "actor" ? pov.actorId : null;
  const known = useKnownIds(dump, povActorId ?? -1, day, hour);
  const prevPovRef = useRef<Pov>(pov);
  useEffect(() => {
    const prev = prevPovRef.current;
    prevPovRef.current = pov;
    if (pov.kind !== "actor") return;
    const wasAdmin = prev.kind === "admin";
    const switchedActor =
      prev.kind === "actor" && prev.actorId !== pov.actorId;
    if (!wasAdmin && !switchedActor) return;
    const pruned = set.items.filter((it) => {
      if (it.kind === "actor") return known.actors.has(it.id);
      if (it.kind === "location") return known.locations.has(it.id);
      if (it.kind === "item") return known.itemKinds.has(it.id);
      // lots / deals / pools have no clean POV-knowledge gate today —
      // keep them through the prune rather than guess.
      return true;
    });
    if (pruned.length !== set.items.length) {
      set.setItems(pruned);
    }
  }, [pov, known, set, dump]);

  const appRef = useRef<HTMLDivElement>(null);
  const rhsRef = useRef<HTMLDivElement>(null);
  const [leftPx, setLeftPx] = useState<number>(() =>
    readPersistedPx(LEFT_PANEL_KEY, MIN_LEFT_PX, DEFAULT_LEFT_PX),
  );
  const [lowerPx, setLowerPx] = useState<number>(() =>
    readPersistedPx(LOWER_PANEL_KEY, MIN_LOWER_PX, DEFAULT_LOWER_PX),
  );
  useEffect(() => {
    try {
      localStorage.setItem(LEFT_PANEL_KEY, String(Math.round(leftPx)));
    } catch {
      /* quota / disabled */
    }
  }, [leftPx]);
  useEffect(() => {
    try {
      localStorage.setItem(LOWER_PANEL_KEY, String(Math.round(lowerPx)));
    } catch {
      /* quota / disabled */
    }
  }, [lowerPx]);

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

  const onLowerResizeDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const rhs = rhsRef.current;
    if (rhs === null) return;
    const startY = e.clientY;
    const startLower = lowerPx;
    const totalH = rhs.getBoundingClientRect().height;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      // Dragging UP = lower pane grows (delta negative → next bigger).
      const delta = startY - ev.clientY;
      const next = startLower + delta;
      const maxLower = Math.max(MIN_LOWER_PX, totalH - MIN_UPPER_PX - 6);
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
          ["--lower-panel-h" as string]: `${lowerPx}px`,
        }}
      >
        <header className="header">
          <h1>TRADER · sim viewer</h1>
          <div className="header-controls">
            <PovSwitcher dump={dump} />
            <ShowMathToggle />
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
        <main className="rhs" ref={rhsRef}>
          <SelectionChips dump={dump} />
          <div className="main-upper">
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
            <button
              type="button"
              role="tab"
              className={`rhs-tab ${props.rhsTab === "deals" ? "rhs-tab-active" : ""}`}
              aria-selected={props.rhsTab === "deals"}
              onClick={() => props.setRhsTab("deals")}
            >
              Deals
            </button>
            <button
              type="button"
              role="tab"
              className={`rhs-tab ${props.rhsTab === "lots" ? "rhs-tab-active" : ""}`}
              aria-selected={props.rhsTab === "lots"}
              onClick={() => props.setRhsTab("lots")}
            >
              Lots
            </button>
            <button
              type="button"
              role="tab"
              className={`rhs-tab ${props.rhsTab === "pools" ? "rhs-tab-active" : ""}`}
              aria-selected={props.rhsTab === "pools"}
              onClick={() => props.setRhsTab("pools")}
            >
              Pools
            </button>
            <button
              type="button"
              role="tab"
              className={`rhs-tab ${props.rhsTab === "items" ? "rhs-tab-active" : ""}`}
              aria-selected={props.rhsTab === "items"}
              onClick={() => props.setRhsTab("items")}
            >
              Items
            </button>
            <button
              type="button"
              role="tab"
              className={`rhs-tab ${props.rhsTab === "gossip" ? "rhs-tab-active" : ""}`}
              aria-selected={props.rhsTab === "gossip"}
              onClick={() => props.setRhsTab("gossip")}
            >
              Gossip
            </button>
            <button
              type="button"
              role="tab"
              className={`rhs-tab ${props.rhsTab === "scratchpad" ? "rhs-tab-active" : ""}`}
              aria-selected={props.rhsTab === "scratchpad"}
              onClick={() => props.setRhsTab("scratchpad")}
              title="Throwaway graph editor (in-memory only)"
            >
              Scratch
            </button>
            {DEV && pov.kind === "admin" ? (
              <button
                type="button"
                role="tab"
                className={`rhs-tab ${props.rhsTab === "editor" ? "rhs-tab-active" : ""}`}
                aria-selected={props.rhsTab === "editor"}
                onClick={() => props.setRhsTab("editor")}
                title="Cast & map editors (dev / admin only)"
              >
                Editor
              </button>
            ) : null}
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
            ) : props.rhsTab === "deals" ? (
              <DealBook
                dump={dump}
                day={day}
                snapshot={snapshot}
                onSelect={(s) => set.replace(s)}
              />
            ) : props.rhsTab === "lots" ? (
              <InventoryView
                dump={dump}
                day={day}
                snapshot={snapshot}
                onSelect={(s) => set.replace(s)}
              />
            ) : props.rhsTab === "pools" ? (
              <PoolBoard
                dump={dump}
                day={day}
                snapshot={snapshot}
                onSelect={(s) => set.replace(s)}
              />
            ) : props.rhsTab === "items" ? (
              <ItemsList
                dump={dump}
                day={day}
                snapshot={snapshot}
                onSelect={(s) => set.replace(s)}
              />
            ) : props.rhsTab === "gossip" ? (
              <GossipBoard
                dump={dump}
                day={day}
                hour={hour}
                snapshot={snapshot}
                onSelect={(s) => set.replace(s)}
              />
            ) : props.rhsTab === "scratchpad" ? (
              <GraphScratchpad />
            ) : props.rhsTab === "editor" && DEV && pov.kind === "admin" ? (
              <div className="editor-pane">
                <div className="editor-subtabs" role="tablist" aria-label="Editor section">
                  <button
                    type="button"
                    role="tab"
                    className={`editor-subtab ${props.editorSubTab === "residences" ? "editor-subtab-active" : ""}`}
                    aria-selected={props.editorSubTab === "residences"}
                    onClick={() => props.setEditorSubTab("residences")}
                  >
                    Residences
                  </button>
                  <button
                    type="button"
                    role="tab"
                    className={`editor-subtab ${props.editorSubTab === "actors" ? "editor-subtab-active" : ""}`}
                    aria-selected={props.editorSubTab === "actors"}
                    onClick={() => props.setEditorSubTab("actors")}
                  >
                    Actors
                  </button>
                  <button
                    type="button"
                    role="tab"
                    className={`editor-subtab ${props.editorSubTab === "businesses" ? "editor-subtab-active" : ""}`}
                    aria-selected={props.editorSubTab === "businesses"}
                    onClick={() => props.setEditorSubTab("businesses")}
                  >
                    Businesses
                  </button>
                  <button
                    type="button"
                    role="tab"
                    className={`editor-subtab ${props.editorSubTab === "map" ? "editor-subtab-active" : ""}`}
                    aria-selected={props.editorSubTab === "map"}
                    onClick={() => props.setEditorSubTab("map")}
                  >
                    Map
                  </button>
                </div>
                <div className="editor-subbody">
                  {props.editorSubTab === "residences" ? (
                    <CharacterEditor view="residences" />
                  ) : props.editorSubTab === "actors" ? (
                    <CharacterEditor view="actors" />
                  ) : props.editorSubTab === "businesses" ? (
                    <BusinessHoursEditor />
                  ) : (
                    <MapEditor dump={dump} />
                  )}
                </div>
              </div>
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
          </div>
          <div
            className="lower-resizer"
            role="separator"
            aria-orientation="horizontal"
            title="Drag to resize"
            onPointerDown={onLowerResizeDown}
          >
            <span className="lower-resizer-grip" />
          </div>
          <div className="main-lower">
            <SceneDeck
              dump={dump}
              day={day}
              hour={hour}
              snapshot={snapshot}
              onSelect={(s) => set.replace(s)}
              povActorId={pov.kind === "actor" ? pov.actorId : null}
            />
          </div>
        </main>
      </div>
    </CurrentTimeProvider>
  );
}

function ShowMathToggle() {
  const { showMath, setShowMath } = useShowMath();
  return (
    <button
      type="button"
      className={`show-math-toggle ${showMath ? "show-math-toggle-on" : ""}`}
      onClick={() => setShowMath(!showMath)}
      title={
        showMath
          ? "Hide numeric values in NPC judgement hovers (keeps formula structure)"
          : "Reveal numeric values in every judgement hover (dev / inspection mode)"
      }
      aria-pressed={showMath}
    >
      Show math
    </button>
  );
}
