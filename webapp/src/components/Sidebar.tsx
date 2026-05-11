import { useEffect, useMemo, useRef, useState } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import type {
  Selection,
  SidebarLowerTab,
  SidebarTopTab,
} from "../App.js";
import { Avatar } from "./Avatar.js";
import { ActorProfile } from "./ActorProfile.js";
import { ActorDiary } from "./ActorDiary.js";
import { ActorKnows } from "./ActorKnows.js";
import { ActorInventory } from "./ActorInventory.js";
import { LocationProfile } from "./LocationProfile.js";
import { LocationDiary } from "./LocationDiary.js";
import { ItemProfile } from "./ItemProfile.js";
import { DealProfile } from "./DealProfile.js";
import { LotProfile } from "./LotProfile.js";
import { PoolProfile } from "./PoolProfile.js";

const LOWER_HEIGHT_KEY = "trader-sidebar-lower-px";
const DEFAULT_LOWER_PX = 320;
const MIN_LOWER_PX = 120;
const MIN_UPPER_PX = 140;

const ACTOR_ROLE_FILTER_KEY = "trader-sidebar-role-filter";
const LOC_TYPE_FILTER_KEY = "trader-sidebar-loctype-filter";

/** Display labels for role tags shown in the filter rail. Anything
 *  not listed here falls back to the raw tag string. */
const ROLE_LABEL: Record<string, string> = {
  player: "Player",
  dealer: "Dealers",
  fence: "Fences",
  supplier: "Suppliers",
  pub: "Pub",
  family: "Family",
  civilian: "Civvies",
  police: "Police",
  villain: "Villains",
  official: "Officials",
  shopkeeper: "Shopkeepers",
  "off-map-dealer": "Off-map dealers",
  "off-map-market": "Off-map market",
};

const LOC_TYPE_LABEL: Record<string, string> = {
  home: "Residential",
  business: "Business",
};

function readFilterSet(key: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === "") return new Set();
    return new Set(raw.split(","));
  } catch {
    return new Set();
  }
}

function writeFilterSet(key: string, set: ReadonlySet<string>): void {
  try {
    if (set.size === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, [...set].sort().join(","));
  } catch {
    /* quota / disabled */
  }
}

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly snapshot: DaySnapshot | null;
  readonly topTab: SidebarTopTab;
  readonly setTopTab: (t: SidebarTopTab) => void;
  readonly lowerTab: SidebarLowerTab;
  readonly setLowerTab: (t: SidebarLowerTab) => void;
  readonly selection: Selection | null;
  readonly setSelection: (s: Selection | null) => void;
  readonly onChangeDay: (d: number) => void;
}

export function Sidebar(props: Props) {
  const {
    dump,
    day,
    hour,
    snapshot,
    topTab,
    setTopTab,
    lowerTab,
    setLowerTab,
    selection,
    setSelection,
    onChangeDay,
  } = props;

  const asideRef = useRef<HTMLElement>(null);

  // Filter state — Set of selected role/type tags. Empty set = no
  // filter applied (show all). Stored as comma-joined sorted string.
  const [roleFilter, setRoleFilter] = useState<ReadonlySet<string>>(
    () => readFilterSet(ACTOR_ROLE_FILTER_KEY),
  );
  const [locTypeFilter, setLocTypeFilter] = useState<ReadonlySet<string>>(
    () => readFilterSet(LOC_TYPE_FILTER_KEY),
  );
  useEffect(() => {
    writeFilterSet(ACTOR_ROLE_FILTER_KEY, roleFilter);
  }, [roleFilter]);
  useEffect(() => {
    writeFilterSet(LOC_TYPE_FILTER_KEY, locTypeFilter);
  }, [locTypeFilter]);

  // Knows and Inventory are actor-only; Diary is actor+location.
  // Snap back to Profile if a non-applicable selection gets focused
  // while one of those tabs is active.
  useEffect(() => {
    if (selection === null) return;
    const isActor = selection.kind === "actor";
    const isLocation = selection.kind === "location";
    if ((lowerTab === "knows" || lowerTab === "inventory") && !isActor) {
      setLowerTab("profile");
    }
    if (lowerTab === "diary" && !isActor && !isLocation) {
      setLowerTab("profile");
    }
  }, [lowerTab, selection, setLowerTab]);

  // Available role tags for the rail — unique union across the cast,
  // sorted by ROLE_LABEL order with anything else appended alphabetically.
  const availableRoles = useMemo(() => {
    const seen = new Set<string>();
    for (const a of dump.actors) for (const r of a.roles ?? []) seen.add(r);
    const known = Object.keys(ROLE_LABEL).filter((r) => seen.has(r));
    const extras = [...seen]
      .filter((r) => !(r in ROLE_LABEL))
      .sort((a, b) => a.localeCompare(b));
    return [...known, ...extras];
  }, [dump.actors]);

  // Only two buckets for now: Residential (home) and Business (everything
  // else with a type — pubs, civic, etc. fold into Business). Anything
  // not matching either bucket falls through into the "All" view.
  const availableLocTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const l of dump.locations) {
      const t = (l as { type?: string }).type;
      if (typeof t === "string") seen.add(t);
    }
    return Object.keys(LOC_TYPE_LABEL).filter((t) => seen.has(t));
  }, [dump.locations]);

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

  // Persist height (debounced via the natural drag end — write on
  // every change is fine, localStorage writes are cheap).
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
      // Drag down → upper grows, lower shrinks.
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

  const activeFilter = topTab === "actors" ? roleFilter : locTypeFilter;
  const activeOptions = topTab === "actors" ? availableRoles : availableLocTypes;
  const activeLabels = topTab === "actors" ? ROLE_LABEL : LOC_TYPE_LABEL;
  const setActiveFilter = topTab === "actors" ? setRoleFilter : setLocTypeFilter;

  const toggleFilter = (tag: string) => {
    setActiveFilter((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  return (
    <aside className="panel side-panel" ref={asideRef}>
      <div className="side-with-rail">
        <div className="side-filter-rail" role="toolbar" aria-label="Filter">
          <button
            className={`side-filter-chip ${activeFilter.size === 0 ? "active" : ""}`}
            onClick={() => setActiveFilter(new Set())}
            title="Show all"
          >
            All
          </button>
          {activeOptions.map((tag) => (
            <button
              key={tag}
              className={`side-filter-chip ${activeFilter.has(tag) ? "active" : ""}`}
              onClick={() => toggleFilter(tag)}
              title={activeLabels[tag] ?? tag}
            >
              {activeLabels[tag] ?? tag}
            </button>
          ))}
        </div>
        <div className="side-with-rail-main">
          <nav className="side-tabs">
            <button
              className={`side-tab ${topTab === "actors" ? "side-tab-active" : ""}`}
              onClick={() => setTopTab("actors")}
            >
              Actors
            </button>
            <button
              className={`side-tab ${topTab === "locations" ? "side-tab-active" : ""}`}
              onClick={() => setTopTab("locations")}
            >
              Locations
            </button>
          </nav>
          <div className="side-list">
            {topTab === "actors" ? (
              <ActorList
                dump={dump}
                snapshot={snapshot}
                day={day}
                selection={selection}
                roleFilter={roleFilter}
                onSelect={(id) =>
                  setSelection(
                    selection?.kind === "actor" && selection.id === id
                      ? null
                      : { kind: "actor", id },
                  )
                }
              />
            ) : (
              <LocationList
                dump={dump}
                snapshot={snapshot}
                selection={selection}
                typeFilter={locTypeFilter}
                onSelect={(id) =>
                  setSelection(
                    selection?.kind === "location" && selection.id === id
                      ? null
                      : { kind: "location", id },
                  )
                }
              />
            )}
          </div>
        </div>
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
      <div className="side-lower" style={{ height: `${lowerPx}px` }}>
        <nav className="side-tabs side-lower-tabs">
          <button
            className={`side-tab ${lowerTab === "profile" ? "side-tab-active" : ""}`}
            onClick={() => setLowerTab("profile")}
            disabled={selection === null}
          >
            Profile
          </button>
          <button
            className={`side-tab ${lowerTab === "diary" ? "side-tab-active" : ""}`}
            onClick={() => setLowerTab("diary")}
            disabled={
              selection === null ||
              (selection.kind !== "actor" && selection.kind !== "location")
            }
            title={
              selection !== null &&
              selection.kind !== "actor" &&
              selection.kind !== "location"
                ? "Diary only applies to actors and locations"
                : "Per-day events"
            }
          >
            Diary
          </button>
          <button
            className={`side-tab ${lowerTab === "knows" ? "side-tab-active" : ""}`}
            onClick={() => setLowerTab("knows")}
            disabled={selection === null || selection.kind !== "actor"}
            title={
              selection?.kind === "location"
                ? "Locations don't know things"
                : "Gossip & info this actor has picked up"
            }
          >
            Knows
          </button>
          <button
            className={`side-tab ${lowerTab === "inventory" ? "side-tab-active" : ""}`}
            onClick={() => setLowerTab("inventory")}
            disabled={selection === null || selection.kind !== "actor"}
            title={
              selection?.kind === "location"
                ? "Locations don't carry inventory"
                : "Stock on hand and open delivery promises"
            }
          >
            Inventory
          </button>
          {selection !== null ? (
            <button
              className="side-close"
              onClick={() => setSelection(null)}
              title="close"
            >
              ×
            </button>
          ) : null}
        </nav>
        <div className="side-lower-body">
          {selection === null ? (
            <div className="side-lower-empty muted">
              Select an actor, location, item, deal, lot, or pool to view details.
            </div>
          ) : (
            <>
              {selection.kind === "actor" && lowerTab === "profile" && (
                <ActorProfile
                  dump={dump}
                  day={day}
                  hour={hour}
                  snapshot={snapshot}
                  actorId={selection.id}
                />
              )}
              {selection.kind === "actor" && lowerTab === "diary" && (
                <ActorDiary
                  dump={dump}
                  day={day}
                  hour={hour}
                  actorId={selection.id}
                  onChangeDay={onChangeDay}
                  onSelect={setSelection}
                />
              )}
              {selection.kind === "actor" && lowerTab === "knows" && (
                <ActorKnows
                  dump={dump}
                  day={day}
                  hour={hour}
                  actorId={selection.id}
                  onSelect={setSelection}
                />
              )}
              {selection.kind === "actor" && lowerTab === "inventory" && (
                <ActorInventory
                  dump={dump}
                  day={day}
                  snapshot={snapshot}
                  actorId={selection.id}
                  onSelect={setSelection}
                />
              )}
              {selection.kind === "location" && lowerTab === "profile" && (
                <LocationProfile
                  dump={dump}
                  day={day}
                  snapshot={snapshot}
                  locationId={selection.id}
                  onSelect={setSelection}
                />
              )}
              {selection.kind === "location" && lowerTab === "diary" && (
                <LocationDiary
                  dump={dump}
                  day={day}
                  hour={hour}
                  locationId={selection.id}
                  onChangeDay={onChangeDay}
                  onSelect={setSelection}
                />
              )}
              {selection.kind === "item" && lowerTab === "profile" && (
                <ItemProfile
                  dump={dump}
                  day={day}
                  snapshot={snapshot}
                  itemId={selection.id}
                  onSelect={setSelection}
                />
              )}
              {selection.kind === "deal" && lowerTab === "profile" && (
                <DealProfile
                  dump={dump}
                  day={day}
                  snapshot={snapshot}
                  dealId={selection.id}
                  onSelect={setSelection}
                />
              )}
              {selection.kind === "lot" && lowerTab === "profile" && (
                <LotProfile
                  dump={dump}
                  day={day}
                  snapshot={snapshot}
                  lotId={selection.id}
                  onSelect={setSelection}
                />
              )}
              {selection.kind === "pool" && lowerTab === "profile" && (
                <PoolProfile
                  dump={dump}
                  day={day}
                  snapshot={snapshot}
                  poolId={selection.id}
                  onSelect={setSelection}
                />
              )}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

function ActorList({
  dump,
  snapshot,
  day,
  selection,
  roleFilter,
  onSelect,
}: {
  dump: RunDump;
  snapshot: DaySnapshot | null;
  day: number;
  selection: Selection | null;
  roleFilter: ReadonlySet<string>;
  onSelect: (id: number) => void;
}) {
  const cashByActor = useMemo(() => {
    const m = new Map<number, number>();
    if (snapshot !== null) for (const a of snapshot.actors) m.set(a.id, a.cash);
    return m;
  }, [snapshot]);
  const heatByActor = useMemo(() => {
    const m = new Map<number, number>();
    if (snapshot !== null) for (const a of snapshot.actors) m.set(a.id, a.heat);
    return m;
  }, [snapshot]);
  const locByActor = useMemo(() => {
    const m = new Map<number, number | null>();
    if (snapshot !== null)
      for (const a of snapshot.actors) m.set(a.id, a.currentLocationId);
    return m;
  }, [snapshot]);

  const sorted = useMemo(
    () => {
      const filtered =
        roleFilter.size === 0
          ? [...dump.actors]
          : dump.actors.filter((a) => {
              const roles = a.roles ?? [];
              for (const r of roles) if (roleFilter.has(r)) return true;
              return false;
            });
      return filtered.sort((a, b) => {
        if (a.id === dump.playerActorId) return -1;
        if (b.id === dump.playerActorId) return 1;
        return a.displayName.localeCompare(b.displayName);
      });
    },
    [dump, roleFilter],
  );

  const locName = (id: number | null | undefined) =>
    typeof id === "number"
      ? dump.locations.find((l) => l.id === id)?.displayName ?? `loc ${id}`
      : "—";

  return (
    <>
      <div className="side-list-header">D{day}</div>
      {sorted.map((a) => {
        const cash = cashByActor.get(a.id) ?? a.cash;
        const heat = heatByActor.get(a.id) ?? 0;
        const loc = locByActor.has(a.id)
          ? locByActor.get(a.id) ?? null
          : a.currentLocationId;
        const isPlayer = a.id === dump.playerActorId;
        const isSelected = selection?.kind === "actor" && selection.id === a.id;
        return (
          <button
            key={a.id}
            className={`actor-row ${isSelected ? "actor-row-selected" : ""}`}
            onClick={() => onSelect(a.id)}
          >
            <Avatar
              name={a.displayName}
              code={a.code}
              isPlayer={isPlayer}
              size={28}
            />
            <div className="actor-name">
              <span>
                {a.displayName}
                {heat > 0 ? (
                  <span className="actor-heat" title={`heat ${heat}`}>
                    {" "}· 🔥{heat}
                  </span>
                ) : null}
              </span>
              <span className="actor-loc">
                {locName(loc)} · {a.transportCapacity}
              </span>
            </div>
            <span className={`actor-cash ${cash === 0 ? "zero" : ""}`}>
              £{cash}
            </span>
          </button>
        );
      })}
    </>
  );
}

function LocationList({
  dump,
  snapshot,
  selection,
  typeFilter,
  onSelect,
}: {
  dump: RunDump;
  snapshot: DaySnapshot | null;
  selection: Selection | null;
  typeFilter: ReadonlySet<string>;
  onSelect: (id: number) => void;
}) {
  const popByLoc = useMemo(() => {
    const m = new Map<number, number>();
    if (snapshot !== null) {
      for (const a of snapshot.actors) {
        if (a.currentLocationId === null) continue;
        m.set(a.currentLocationId, (m.get(a.currentLocationId) ?? 0) + 1);
      }
    }
    return m;
  }, [snapshot]);

  const sorted = useMemo(
    () => {
      const filtered =
        typeFilter.size === 0
          ? [...dump.locations]
          : dump.locations.filter((l) => {
              const t = (l as { type?: string }).type;
              return typeof t === "string" && typeFilter.has(t);
            });
      return filtered.sort((a, b) =>
        a.displayName.localeCompare(b.displayName),
      );
    },
    [dump, typeFilter],
  );

  return (
    <>
      {sorted.map((l) => {
        const isSelected =
          selection?.kind === "location" && selection.id === l.id;
        const pop = popByLoc.get(l.id) ?? 0;
        return (
          <button
            key={l.id}
            className={`loc-row ${isSelected ? "actor-row-selected" : ""}`}
            onClick={() => onSelect(l.id)}
          >
            <div className="loc-name">
              <span>{l.displayName}</span>
              <span className="actor-loc">{l.code}</span>
            </div>
            <span className={`loc-pop ${pop === 0 ? "zero" : ""}`}>
              {pop === 0 ? "—" : `${pop} here`}
            </span>
          </button>
        );
      })}
    </>
  );
}
