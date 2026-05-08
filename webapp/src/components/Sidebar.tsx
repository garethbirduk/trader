import { useMemo } from "react";
import type { DaySnapshot, RunDump } from "../types.js";
import type {
  Selection,
  SidebarLowerTab,
  SidebarTopTab,
} from "../App.js";
import { Avatar } from "./Avatar.js";
import { ActorProfile } from "./ActorProfile.js";
import { ActorDiary } from "./ActorDiary.js";
import { LocationProfile } from "./LocationProfile.js";
import { LocationDiary } from "./LocationDiary.js";

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

  return (
    <aside className="panel side-panel">
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
      {selection !== null ? (
        <div className="side-lower">
          <nav className="side-tabs side-lower-tabs">
            <button
              className={`side-tab ${lowerTab === "profile" ? "side-tab-active" : ""}`}
              onClick={() => setLowerTab("profile")}
            >
              Profile
            </button>
            <button
              className={`side-tab ${lowerTab === "diary" ? "side-tab-active" : ""}`}
              onClick={() => setLowerTab("diary")}
            >
              Diary
            </button>
            <button
              className="side-close"
              onClick={() => setSelection(null)}
              title="close"
            >
              ×
            </button>
          </nav>
          <div className="side-lower-body">
            {selection.kind === "actor" && lowerTab === "profile" && (
              <ActorProfile
                dump={dump}
                day={day}
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
            {selection.kind === "location" && lowerTab === "profile" && (
              <LocationProfile
                dump={dump}
                day={day}
                snapshot={snapshot}
                locationId={selection.id}
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
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function ActorList({
  dump,
  snapshot,
  day,
  selection,
  onSelect,
}: {
  dump: RunDump;
  snapshot: DaySnapshot | null;
  day: number;
  selection: Selection | null;
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
    () =>
      [...dump.actors].sort((a, b) => {
        if (a.id === dump.playerActorId) return -1;
        if (b.id === dump.playerActorId) return 1;
        return a.displayName.localeCompare(b.displayName);
      }),
    [dump],
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
  onSelect,
}: {
  dump: RunDump;
  snapshot: DaySnapshot | null;
  selection: Selection | null;
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
    () =>
      [...dump.locations].sort((a, b) =>
        a.displayName.localeCompare(b.displayName),
      ),
    [dump],
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
