import { useEffect, useMemo, useRef, useState } from "react";
import type { DaySnapshot, RunActor, RunDump, RunLocation, SnapshotStockLot } from "../types.js";
import type { SidebarTopTab } from "../App.js";
import { useSelectionSet, type SelectionItem } from "../lib/selection-set.js";
import { usePov } from "../lib/pov.js";
import { useKnownIds, type KnownIds } from "../lib/pov-knowledge.js";
import { useActorPositionsAt } from "../lib/positions.js";
import { LocationAvatar } from "./LocationAvatar.js";
import { LocationChip } from "./LocationChip.js";
import { LocationRef } from "./Refs.js";
import { StockChip, CategoryTag } from "./StockChip.js";
import { ActorChip } from "./ActorChip.js";
import { TransportChip } from "./TransportChip.js";
import { SubChecks, type SubCheck } from "./SubChecks.js";

const ACTOR_ROLE_FILTER_KEY = "trader-sidebar-role-filter";
const LOC_TYPE_FILTER_KEY = "trader-sidebar-loctype-filter";
const STOCK_GROUPING_KEY = "trader-sidebar-stock-grouping";

const ROLE_LABEL: Record<string, string> = {
  player: "Player",
  dealer: "Dealers",
  fence: "Fences",
  supplier: "Suppliers",
  pub: "Pub",
  household: "Household",
  civilian: "Civvies",
  police: "Police",
  villain: "Villains",
  official: "Officials",
  shopkeeper: "Shopkeepers",
  "off-map-dealer": "Off-map dealers",
  "off-map-market": "Off-map market",
  "virtual-producer": "Virtual producers",
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

type StockGrouping = "item" | "type" | "owner" | "location";

function readStockGrouping(): StockGrouping {
  try {
    const raw = localStorage.getItem(STOCK_GROUPING_KEY);
    if (raw === "item" || raw === "type" || raw === "owner" || raw === "location") return raw;
  } catch {
    /* ignore */
  }
  return "item";
}

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly snapshot: DaySnapshot | null;
  readonly topTab: SidebarTopTab;
  readonly setTopTab: (t: SidebarTopTab) => void;
}

export function Sidebar(props: Props) {
  const { dump, day, hour, snapshot, topTab, setTopTab } = props;
  const { pov } = usePov();
  // Knowledge filter: in player POV, restrict lists to what this actor
  // knows (gossip-mentioned, transacted, witnessed). Admin POV bypasses
  // (we pass `-1` as the actor id and discard the result via `known`).
  const povActorId = pov.kind === "actor" ? pov.actorId : null;
  const knownRaw = useKnownIds(dump, povActorId ?? -1, day, hour);
  const known: KnownIds | null = povActorId === null ? null : knownRaw;
  const asideRef = useRef<HTMLElement>(null);

  const [roleFilter, setRoleFilter] = useState<ReadonlySet<string>>(() => readFilterSet(ACTOR_ROLE_FILTER_KEY));
  const [locTypeFilter, setLocTypeFilter] = useState<ReadonlySet<string>>(() => readFilterSet(LOC_TYPE_FILTER_KEY));
  const [stockGrouping, setStockGrouping] = useState<StockGrouping>(() => readStockGrouping());

  useEffect(() => writeFilterSet(ACTOR_ROLE_FILTER_KEY, roleFilter), [roleFilter]);
  useEffect(() => writeFilterSet(LOC_TYPE_FILTER_KEY, locTypeFilter), [locTypeFilter]);
  useEffect(() => {
    try { localStorage.setItem(STOCK_GROUPING_KEY, stockGrouping); } catch { /* ignore */ }
  }, [stockGrouping]);

  const availableRoles = useMemo(() => {
    const seen = new Set<string>();
    for (const a of dump.actors) for (const r of a.roles ?? []) seen.add(r);
    const known = Object.keys(ROLE_LABEL).filter((r) => seen.has(r));
    const extras = [...seen].filter((r) => !(r in ROLE_LABEL)).sort((a, b) => a.localeCompare(b));
    return [...known, ...extras];
  }, [dump.actors]);

  const availableLocTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const l of dump.locations) {
      const t = (l as { type?: string }).type;
      if (typeof t === "string") seen.add(t);
    }
    return Object.keys(LOC_TYPE_LABEL).filter((t) => seen.has(t));
  }, [dump.locations]);

  const railConfig =
    topTab === "actors"
      ? { filter: roleFilter, setFilter: setRoleFilter, options: availableRoles, labels: ROLE_LABEL }
      : topTab === "locations"
      ? { filter: locTypeFilter, setFilter: setLocTypeFilter, options: availableLocTypes, labels: LOC_TYPE_LABEL }
      : null;

  const toggleRailFilter = (tag: string) => {
    if (railConfig === null) return;
    railConfig.setFilter((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  return (
    <aside className="panel side-panel" ref={asideRef}>
      <div className="side-with-rail">
        {railConfig !== null ? (
          <div className="side-filter-rail" role="toolbar" aria-label="Filter">
            <button
              className={`side-filter-chip ${railConfig.filter.size === 0 ? "active" : ""}`}
              onClick={() => railConfig.setFilter(new Set())}
              title="Show all"
            >
              All
            </button>
            {railConfig.options.map((tag) => (
              <button
                key={tag}
                className={`side-filter-chip ${railConfig.filter.has(tag) ? "active" : ""}`}
                onClick={() => toggleRailFilter(tag)}
                title={railConfig.labels[tag] ?? tag}
              >
                {railConfig.labels[tag] ?? tag}
              </button>
            ))}
          </div>
        ) : null}
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
            <button
              className={`side-tab ${topTab === "stock" ? "side-tab-active" : ""}`}
              onClick={() => setTopTab("stock")}
            >
              Stock
            </button>
          </nav>
          <div className="side-list">
            {topTab === "actors" && (
              <ActorList dump={dump} snapshot={snapshot} roleFilter={roleFilter} known={known} />
            )}
            {topTab === "locations" && (
              <LocationList dump={dump} day={day} hour={hour} snapshot={snapshot} typeFilter={locTypeFilter} known={known} />
            )}
            {topTab === "stock" && (
              <StockList
                dump={dump}
                snapshot={snapshot}
                grouping={stockGrouping}
                onChangeGrouping={setStockGrouping}
                known={known}
              />
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

// ────────────────────────────────────────────────────────────────────
// Actor list
// ────────────────────────────────────────────────────────────────────

function ActorList({
  dump,
  snapshot,
  roleFilter,
  known,
}: {
  dump: RunDump;
  snapshot: DaySnapshot | null;
  roleFilter: ReadonlySet<string>;
  known: KnownIds | null;
}) {
  const set = useSelectionSet();
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
    if (snapshot !== null) for (const a of snapshot.actors) m.set(a.id, a.currentLocationId);
    return m;
  }, [snapshot]);
  const stockByOwner = useMemo(() => {
    const m = new Map<number, SnapshotStockLot[]>();
    if (snapshot !== null) {
      for (const lot of snapshot.stockLots) {
        const list = m.get(lot.ownerActorId) ?? [];
        list.push(lot);
        m.set(lot.ownerActorId, list);
      }
    }
    return m;
  }, [snapshot]);

  const sorted = useMemo(() => {
    let pool = [...dump.actors];
    if (known !== null) {
      pool = pool.filter((a) => known.actors.has(a.id));
    }
    const filtered =
      roleFilter.size === 0
        ? pool
        : pool.filter((a) => {
            const roles = a.roles ?? [];
            for (const r of roles) if (roleFilter.has(r)) return true;
            return false;
          });
    return filtered.sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }, [dump, roleFilter, known]);

  return (
    <>
      {sorted.map((a) => {
        const cash = cashByActor.get(a.id) ?? a.cash;
        const heat = heatByActor.get(a.id) ?? 0;
        const loc = locByActor.has(a.id) ? locByActor.get(a.id) ?? null : a.currentLocationId;
        const item: SelectionItem = { kind: "actor", id: a.id };
        const inSet = set.has(item);

        const checks: SubCheck[] = [];
        if (a.homeLocationId !== null && a.homeLocationId !== undefined) {
          checks.push({
            kind: "single",
            label: "home",
            item: { kind: "location", id: a.homeLocationId },
            title: "Add their home venue to selection",
          });
        }
        if (typeof loc === "number" && loc !== a.homeLocationId) {
          checks.push({
            kind: "single",
            label: "here",
            item: { kind: "location", id: loc },
            title: "Add their current location to selection",
          });
        }
        const lots = stockByOwner.get(a.id) ?? [];
        if (lots.length > 0) {
          checks.push({
            kind: "bulk",
            label: "stock",
            items: lots.map<SelectionItem>((l) => ({ kind: "item", id: l.itemKindId })),
            title: `${lots.length} stock kind${lots.length === 1 ? "" : "s"} this actor owns`,
          });
        }

        return (
          <div key={a.id} className={`row-and-checks lhs-actor-row ${inSet ? "row-in-set" : ""}`}>
            <ActorChip
              actor={a}
              dump={dump}
              size={24}
              onClick={() => set.toggle(item)}
              state={inSet ? "on" : "off"}
              className="lhs-actor-chip"
              title={inSet ? "Click to remove from selection" : "Click to add to selection"}
            />
            <div className="lhs-actor-meta">
              {a.isVirtual === true ? (
                <span className="muted">virtual producer</span>
              ) : (
                <>
                  <span className="lhs-actor-loc">
                    {loc !== null && loc !== undefined ? (
                      <LocationRef
                        dump={dump}
                        id={loc}
                        onSelect={(s) => set.replace(s)}
                        variant="chip"
                        size={14}
                      />
                    ) : (
                      <span className="muted">—</span>
                    )}
                    <TransportChip capacity={a.transportCapacity} />
                  </span>
                  {heat > 0 ? (
                    <span className="actor-heat" title={`heat ${heat}`}>🔥{heat}</span>
                  ) : null}
                  <span className={`actor-cash ${cash === 0 ? "zero" : ""}`}>£{cash}</span>
                </>
              )}
            </div>
            <SubChecks checks={checks} />
          </div>
        );
      })}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────
// Location list — each venue expands into Actors (Works/Lives/Visiting)
// and Stock (per-category) nested subgroups. Every group header doubles
// as a bulk-select operator. POV knowledge filter applies inside each
// venue: actors / items the POV doesn't know about are hidden.
// ────────────────────────────────────────────────────────────────────

function LocationList({
  dump,
  day,
  hour,
  snapshot,
  typeFilter,
  known,
}: {
  dump: RunDump;
  day: number;
  hour: number;
  snapshot: DaySnapshot | null;
  typeFilter: ReadonlySet<string>;
  known: KnownIds | null;
}) {
  // Hour-precise positions for the "Visiting here" computation —
  // snapshot.currentLocationId is daily, so it doesn't reflect who's
  // actually at the pub at 17:00 vs 02:00.
  const positions = useActorPositionsAt(dump, day, hour);

  const sorted = useMemo(() => {
    const filtered =
      typeFilter.size === 0
        ? [...dump.locations]
        : dump.locations.filter((l) => {
            const t = (l as { type?: string }).type;
            return typeof t === "string" && typeFilter.has(t);
          });
    return filtered.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [dump, typeFilter]);

  return (
    <>
      {sorted.map((l) => (
        <LocationBlock
          key={l.id}
          loc={l}
          dump={dump}
          snapshot={snapshot}
          positions={positions}
          known={known}
        />
      ))}
    </>
  );
}

/** Single location block — header + Actors subgroups + Stock subgroups. */
function LocationBlock({
  loc,
  dump,
  snapshot,
  positions,
  known,
}: {
  loc: RunLocation;
  dump: RunDump;
  snapshot: DaySnapshot | null;
  positions: ReadonlyMap<number, number>;
  known: KnownIds | null;
}) {
  const set = useSelectionSet();
  const locItem: SelectionItem = { kind: "location", id: loc.id };
  const inSet = set.has(locItem);

  const knownActor = (id: number) => known === null || known.actors.has(id);
  const knownItem = (id: number) => known === null || known.itemKinds.has(id);

  const isResidential = loc.type === "home";

  // Lives here = home is this loc AND the venue is residential. A
  // publican whose only "home" record is the pub itself lives over
  // the bar but is meaningfully a worker — they fall in "Works here"
  // instead (the proprietor branch below).
  const lives = useMemo(
    () =>
      dump.actors
        .filter((a) => a.homeLocationId === loc.id && isResidential)
        .filter((a) => knownActor(a.id))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [dump.actors, loc.id, isResidential, known],
  );

  // Works here = either (a) the live-above-shop proprietor (home is
  // this loc AND this loc is non-residential — Mike at the Nag's,
  // Sid at Sid's Café), OR (b) for non-pub workplaces only, someone
  // whose routine puts them here a meaningful chunk of the day
  // without their home being here (Trigger at Council Yard, Boyce at
  // Boyce Autos). Pubs are excluded from the routine path because
  // they're social venues — every regular's routine includes their
  // local, but they're visitors, not workers. Without an explicit
  // employment surface in the engine, this heuristic is the best we
  // can do; expect false negatives for actual pub staff.
  const works = useMemo(() => {
    const isPub = loc.type === "pub";
    const routines = dump.actorRoutines ?? [];
    const hoursAtLocByActor = new Map<number, number>();
    for (const r of routines) {
      const n = r.schedule.filter((s) => s.locationId === loc.id).length;
      if (n > 0) hoursAtLocByActor.set(r.actorId, n);
    }
    return dump.actors
      .filter((a) => {
        if (!knownActor(a.id)) return false;
        // (a) proprietor — home is this venue and it's not residential
        if (a.homeLocationId === loc.id && !isResidential) return true;
        // (b) routine path — non-pub only, substantial presence, not resident
        if (isPub) return false;
        if (a.homeLocationId === loc.id) return false;
        const hrs = hoursAtLocByActor.get(a.id) ?? 0;
        return hrs >= 3;
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [dump.actorRoutines, dump.actors, loc.id, loc.type, isResidential, known]);

  // Visiting here = at this loc AT THIS HOUR (via the replayed
  // positions map) and not Lives/Works. Dynamic with the time
  // slider — scrub to 17:00 and the pub fills up; scrub to 03:00
  // and it empties.
  const visiting = useMemo(() => {
    const livesSet = new Set(lives.map((a) => a.id));
    const worksSet = new Set(works.map((a) => a.id));
    return dump.actors
      .filter((a) => {
        if (positions.get(a.id) !== loc.id) return false;
        if (livesSet.has(a.id) || worksSet.has(a.id)) return false;
        return knownActor(a.id);
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [positions, dump.actors, loc.id, lives, works, known]);

  // Stock at this venue, grouped by category. POV-filtered. Stock
  // moves on day boundaries — the day's snapshot is the right slice.
  const stockByCategory = useMemo(() => {
    if (snapshot === null) return [] as { category: string; lots: SnapshotStockLot[] }[];
    const m = new Map<string, SnapshotStockLot[]>();
    for (const lot of snapshot.stockLots) {
      if (lot.locationId !== loc.id) continue;
      if (!knownItem(lot.itemKindId)) continue;
      const item = dump.items.find((i) => i.id === lot.itemKindId);
      const cat = item?.category ?? "other";
      const list = m.get(cat) ?? [];
      list.push(lot);
      m.set(cat, list);
    }
    return [...m.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, lots]) => ({
        category,
        lots: lots
          .slice()
          .sort((a, b) => {
            const an = dump.items.find((i) => i.id === a.itemKindId)?.displayName ?? "";
            const bn = dump.items.find((i) => i.id === b.itemKindId)?.displayName ?? "";
            return an.localeCompare(bn);
          }),
      }));
  }, [snapshot, dump.items, loc.id, known]);

  const allActors = useMemo(
    () => [...lives, ...works, ...visiting].map<SelectionItem>((a) => ({ kind: "actor", id: a.id })),
    [lives, works, visiting],
  );

  const allItemKinds = useMemo<SelectionItem[]>(() => {
    const seen = new Set<number>();
    const out: SelectionItem[] = [];
    for (const grp of stockByCategory) {
      for (const lot of grp.lots) {
        if (seen.has(lot.itemKindId)) continue;
        seen.add(lot.itemKindId);
        out.push({ kind: "item", id: lot.itemKindId });
      }
    }
    return out;
  }, [stockByCategory]);

  const hasAnyActors = lives.length > 0 || works.length > 0 || visiting.length > 0;
  const hasAnyStock = allItemKinds.length > 0;

  return (
    <div className={`loc-block ${inSet ? "row-in-set" : ""}`}>
      <LocationChip
        loc={loc}
        detail="full"
        size={22}
        onClick={() => set.toggle(locItem)}
        state={inSet ? "on" : "off"}
        className="loc-block-header"
        title={inSet ? "Click to remove from selection" : "Click to add to selection"}
      />

      <div className="loc-block-body">
        {hasAnyActors ? (
          <BulkSection
            label="Actors"
            count={allActors.length}
            items={allActors}
            title="All actors at this venue (POV-filtered)"
          >
            <ActorSubgroup label="Works here" actors={works} dump={dump} />
            <ActorSubgroup label="Lives here" actors={lives} dump={dump} />
            <ActorSubgroup label="Visiting here" actors={visiting} dump={dump} />
          </BulkSection>
        ) : null}

        {hasAnyStock ? (
          <BulkSection
            label="Stock"
            count={allItemKinds.length}
            items={allItemKinds}
            title="All stock kinds held at this venue (POV-filtered)"
          >
            <div className="stock-rows">
              {stockByCategory.flatMap(({ lots }) =>
                lots.map((lot) => (
                  <StockRowWithOwner
                    key={lot.id}
                    lot={lot}
                    dump={dump}
                    loc={loc}
                    snapshot={snapshot}
                  />
                )),
              )}
            </div>
          </BulkSection>
        ) : null}

        {!hasAnyActors && !hasAnyStock ? (
          <div className="loc-block-empty muted">— nothing known here —</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Group header that doubles as a bulk-select operator for the items it
 * scopes. Tick reflects current set membership: "✓" all-on, "·" some-on,
 * "+" none-on. Children render indented below.
 */
function BulkSection({
  label,
  count,
  items,
  title,
  children,
}: {
  label: string;
  count: number;
  items: readonly SelectionItem[];
  title: string;
  children: React.ReactNode;
}) {
  const set = useSelectionSet();
  const presence = items.map((i) => set.has(i));
  const all = presence.length > 0 && presence.every((p) => p);
  const some = !all && presence.some((p) => p);
  const tick = all ? "✓" : some ? "·" : "+";
  const klass = all ? "bulk-on" : some ? "bulk-some" : "";
  const toggle = () => {
    if (all) {
      for (const i of items) set.remove(i);
    } else {
      for (const i of items) set.add(i);
    }
  };
  return (
    <div className="bulk-section">
      <button type="button" className={`bulk-section-header ${klass}`} onClick={toggle} title={title}>
        <span className="bulk-tick">{tick}</span>
        <span className="bulk-section-label">{label}</span>
        <span className="bulk-section-count">{count}</span>
      </button>
      <div className="bulk-section-body">{children}</div>
    </div>
  );
}

/** Actor reference inside a location block. Wraps the canonical
 *  ActorChip so any actor reference in the LHS looks the same. */
function MiniActorRow({ actor, dump }: { actor: RunActor; dump: RunDump }) {
  const set = useSelectionSet();
  const item: SelectionItem = { kind: "actor", id: actor.id };
  const inSet = set.has(item);
  return (
    <ActorChip
      actor={actor}
      dump={dump}
      onClick={() => set.toggle(item)}
      state={inSet ? "on" : "off"}
      title={inSet ? "Click to remove from selection" : "Click to add to selection"}
    />
  );
}

function ActorSubgroup({
  label,
  actors,
  dump,
}: {
  label: string;
  actors: readonly RunActor[];
  dump: RunDump;
}) {
  if (actors.length === 0) return null;
  return (
    <BulkSection
      label={label}
      count={actors.length}
      items={actors.map<SelectionItem>((a) => ({ kind: "actor", id: a.id }))}
      title={`${label} — ${actors.length} actor${actors.length === 1 ? "" : "s"} (POV-filtered)`}
    >
      <div className="mini-rows">
        {actors.map((a) => (
          <MiniActorRow key={a.id} actor={a} dump={dump} />
        ))}
      </div>
    </BulkSection>
  );
}


/** Stock row inside a location block — StockChip + "owned by [Owner]"
 *  where the owner is a bulk operator that selects every item-kind at
 *  this venue owned by them. */
function StockRowWithOwner({
  lot,
  dump,
  loc,
  snapshot,
}: {
  lot: SnapshotStockLot;
  dump: RunDump;
  loc: RunLocation;
  snapshot: DaySnapshot | null;
}) {
  const set = useSelectionSet();
  const { pov } = usePov();
  const observerActorId = pov.kind === "actor" ? pov.actorId : null;
  const itemKind: SelectionItem = { kind: "item", id: lot.itemKindId };
  const inSet = set.has(itemKind);
  const owner = dump.actors.find((a) => a.id === lot.ownerActorId);
  const item = dump.items.find((i) => i.id === lot.itemKindId);

  return (
    <div className={`stock-row-with-owner ${inSet ? "row-in-set" : ""}`}>
      {item !== undefined ? (
        <CategoryTag
          category={item.category}
          onSelect={(s) => set.toggle(s)}
          selected={set.has({ kind: "category", id: 0, category: item.category })}
        />
      ) : null}
      <StockChip
        dump={dump}
        itemKindId={lot.itemKindId}
        qualityTier={lot.qualityTier}
        quantity={lot.quantity}
        observerActorId={observerActorId}
        onSelect={() => set.toggle(itemKind)}
      />
      {owner !== undefined ? (
        <ActorChip
          actor={owner}
          dump={dump}
          size={14}
          onClick={() => set.toggle({ kind: "actor", id: owner.id })}
          state={set.has({ kind: "actor", id: owner.id }) ? "on" : "off"}
        />
      ) : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Stock list — all snapshot stock, grouped by owner or by location
// ────────────────────────────────────────────────────────────────────

function StockList({
  dump,
  snapshot,
  grouping,
  onChangeGrouping,
  known,
}: {
  dump: RunDump;
  snapshot: DaySnapshot | null;
  grouping: StockGrouping;
  onChangeGrouping: (g: StockGrouping) => void;
  known: KnownIds | null;
}) {
  const allLots = snapshot?.stockLots ?? [];
  const lots = useMemo(
    () => (known === null ? allLots : allLots.filter((l) => known.itemKinds.has(l.itemKindId))),
    [allLots, known],
  );

  if (lots.length === 0) {
    return (
      <>
        <StockGroupingTabs grouping={grouping} onChange={onChangeGrouping} />
        <div className="side-lower-empty muted">No stock at the current day.</div>
      </>
    );
  }

  return (
    <>
      <StockGroupingTabs grouping={grouping} onChange={onChangeGrouping} />
      {grouping === "item" ? (
        <FlatStockList lots={lots} dump={dump} />
      ) : grouping === "type" ? (
        <ByTypeStockList lots={lots} dump={dump} />
      ) : (
        <GroupedStockList lots={lots} dump={dump} grouping={grouping} />
      )}
    </>
  );
}

function StockGroupingTabs({
  grouping,
  onChange,
}: {
  grouping: StockGrouping;
  onChange: (g: StockGrouping) => void;
}) {
  return (
    <div className="stock-grouping" role="tablist" aria-label="Stock grouping">
      {(["item", "type", "owner", "location"] as const).map((g) => (
        <button
          key={g}
          type="button"
          className={`stock-grouping-btn ${grouping === g ? "active" : ""}`}
          onClick={() => onChange(g)}
        >
          by {g}
        </button>
      ))}
    </div>
  );
}

/** "by item" — flat alphabetical list, one row per lot. Sort first by
 *  item name, then owner, then location to give a stable ordering when
 *  the same item is held by multiple traders. */
function FlatStockList({
  lots,
  dump,
}: {
  lots: readonly SnapshotStockLot[];
  dump: RunDump;
}) {
  const sorted = useMemo(() => {
    const itemName = (id: number) => dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`;
    const ownerName = (id: number) => dump.actors.find((a) => a.id === id)?.shortName ?? `actor ${id}`;
    const locName = (id: number | null) =>
      id === null ? "" : dump.locations.find((l) => l.id === id)?.displayName ?? `loc ${id}`;
    return [...lots].sort((a, b) => {
      const cmp = itemName(a.itemKindId).localeCompare(itemName(b.itemKindId));
      if (cmp !== 0) return cmp;
      const oc = ownerName(a.ownerActorId).localeCompare(ownerName(b.ownerActorId));
      if (oc !== 0) return oc;
      return locName(a.locationId).localeCompare(locName(b.locationId));
    });
  }, [lots, dump.items, dump.actors, dump.locations]);
  return (
    <div className="stock-flat-list">
      {sorted.map((lot) => (
        <StockRow key={lot.id} lot={lot} dump={dump} />
      ))}
    </div>
  );
}

/** "by type" — grouped by item category. Category headers use the
 *  selectable `CategoryTag` so clicking adds a `{kind:"category"}`
 *  chip to the RHS selection / filter rail. Rows within a group
 *  sort by item name then owner (matches `FlatStockList`). */
function ByTypeStockList({
  lots,
  dump,
}: {
  lots: readonly SnapshotStockLot[];
  dump: RunDump;
}) {
  const set = useSelectionSet();
  const groups = useMemo(() => {
    const itemName = (id: number) => dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`;
    const ownerName = (id: number) => dump.actors.find((a) => a.id === id)?.shortName ?? `actor ${id}`;
    const m = new Map<string, SnapshotStockLot[]>();
    for (const lot of lots) {
      const cat = dump.items.find((i) => i.id === lot.itemKindId)?.category ?? "other";
      const list = m.get(cat) ?? [];
      list.push(lot);
      m.set(cat, list);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        const cmp = itemName(a.itemKindId).localeCompare(itemName(b.itemKindId));
        if (cmp !== 0) return cmp;
        return ownerName(a.ownerActorId).localeCompare(ownerName(b.ownerActorId));
      });
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [lots, dump.items, dump.actors]);
  return (
    <>
      {groups.map(([category, arr]) => {
        const selected = set.has({ kind: "category", id: 0, category });
        return (
          <div key={category} className="stock-group">
            <div className="stock-group-header">
              <CategoryTag
                category={category}
                onSelect={(s) => set.toggle(s)}
                selected={selected}
              />
              <span className="stock-group-count">
                {arr.length} lot{arr.length === 1 ? "" : "s"}
              </span>
            </div>
            {arr.map((lot) => (
              <StockRow key={lot.id} lot={lot} dump={dump} suppressCategory />
            ))}
          </div>
        );
      })}
    </>
  );
}

/** "by owner" / "by location" — group by the chosen axis, sort
 *  groups alphabetically, sort rows within each group by item name. */
function GroupedStockList({
  lots,
  dump,
  grouping,
}: {
  lots: readonly SnapshotStockLot[];
  dump: RunDump;
  grouping: "owner" | "location";
}) {
  const set = useSelectionSet();
  const grouped = useMemo(() => {
    const m = new Map<number, SnapshotStockLot[]>();
    for (const lot of lots) {
      const key = grouping === "owner" ? lot.ownerActorId : lot.locationId ?? -1;
      const list = m.get(key) ?? [];
      list.push(lot);
      m.set(key, list);
    }
    const itemName = (id: number) => dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`;
    for (const arr of m.values()) {
      arr.sort((a, b) => itemName(a.itemKindId).localeCompare(itemName(b.itemKindId)));
    }
    return m;
  }, [lots, grouping, dump.items]);

  const sortedKeys = useMemo(() => {
    const labelFor = (k: number): string => {
      if (grouping === "owner") {
        return dump.actors.find((x) => x.id === k)?.displayName ?? `actor ${k}`;
      }
      if (k === -1) return "(no location)";
      return dump.locations.find((x) => x.id === k)?.displayName ?? `loc ${k}`;
    };
    return [...grouped.keys()].sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
  }, [grouped, grouping, dump]);

  return (
    <>
      {sortedKeys.map((key) => {
        const arr = grouped.get(key) ?? [];
        const ownerActor = grouping === "owner" ? dump.actors.find((a) => a.id === key) : undefined;
        // Group-header chip = a selection toggle for the grouping axis.
        // Clicking the owner / location adds (or removes) the matching
        // chip on the RHS filter rail — mirrors the by-type CategoryTag.
        const headerNode = (() => {
          if (grouping === "owner" && ownerActor !== undefined) {
            const item: SelectionItem = { kind: "actor", id: ownerActor.id };
            const on = set.has(item);
            return (
              <ActorChip
                actor={ownerActor}
                dump={dump}
                size={14}
                onClick={() => set.toggle(item)}
                state={on ? "on" : "off"}
                title={on ? "Click to remove from selection" : "Click to add to selection"}
              />
            );
          }
          if (key === -1) {
            return <span className="stock-group-title muted">(no location)</span>;
          }
          const groupLoc = dump.locations.find((l) => l.id === key);
          if (groupLoc === undefined) {
            return <span className="stock-group-title muted">loc {key}</span>;
          }
          const item: SelectionItem = { kind: "location", id: groupLoc.id };
          const on = set.has(item);
          return (
            <LocationChip
              loc={groupLoc}
              size={14}
              onClick={() => set.toggle(item)}
              state={on ? "on" : "off"}
              title={on ? "Click to remove from selection" : "Click to add to selection"}
            />
          );
        })();
        const ctxLoc = grouping === "location" ? dump.locations.find((l) => l.id === key) : undefined;
        const ctxOwner = grouping === "owner" ? ownerActor : undefined;
        return (
          <div key={key} className="stock-group">
            <div className="stock-group-header">
              {headerNode}
              <span className="stock-group-count">
                {arr.length} lot{arr.length === 1 ? "" : "s"}
              </span>
            </div>
            {arr.map((lot) => (
              <StockRow
                key={lot.id}
                lot={lot}
                dump={dump}
                {...(ctxOwner !== undefined ? { contextOwner: ctxOwner } : {})}
                {...(ctxLoc !== undefined ? { contextLocation: ctxLoc } : {})}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────
// Shared stock row — one canonical layout used by every Stock grouping.
// Renders StockChip + "owned by [actor]" + "at [location]" inline.
// Whichever axis is the group context (owner / location) is omitted to
// avoid duplicating the group header.
// ────────────────────────────────────────────────────────────────────

function StockRow({
  lot,
  dump,
  contextOwner,
  contextLocation,
  suppressCategory,
}: {
  lot: SnapshotStockLot;
  dump: RunDump;
  contextOwner?: RunActor;
  contextLocation?: RunLocation;
  /** Omit the leading CategoryTag — used inside `by type` groups
   *  where the category is already the group header. */
  suppressCategory?: boolean;
}) {
  const set = useSelectionSet();
  const { pov } = usePov();
  const itemKind: SelectionItem = { kind: "item", id: lot.itemKindId };
  const inSet = set.has(itemKind);
  const owner = dump.actors.find((a) => a.id === lot.ownerActorId);
  const loc = lot.locationId !== null ? dump.locations.find((l) => l.id === lot.locationId) : undefined;
  const observerActorId = pov.kind === "actor" ? pov.actorId : null;
  const item = dump.items.find((i) => i.id === lot.itemKindId);

  return (
    <div className={`stock-row-by-item ${inSet ? "row-in-set" : ""}`}>
      {item !== undefined && suppressCategory !== true ? (
        <CategoryTag
          category={item.category}
          onSelect={(s) => set.toggle(s)}
          selected={set.has({ kind: "category", id: 0, category: item.category })}
        />
      ) : null}
      <StockChip
        dump={dump}
        itemKindId={lot.itemKindId}
        qualityTier={lot.qualityTier}
        quantity={lot.quantity}
        observerActorId={observerActorId}
        onSelect={() => set.toggle(itemKind)}
      />
      {owner !== undefined && contextOwner === undefined ? (
        <ActorChip
          actor={owner}
          dump={dump}
          size={14}
          onClick={() => set.toggle({ kind: "actor", id: owner.id })}
          state={set.has({ kind: "actor", id: owner.id }) ? "on" : "off"}
        />
      ) : null}
      {loc !== undefined && contextLocation === undefined ? (
        <LocationChip
          loc={loc}
          size={14}
          onClick={() => set.toggle({ kind: "location", id: loc.id })}
          state={set.has({ kind: "location", id: loc.id }) ? "on" : "off"}
        />
      ) : null}
    </div>
  );
}

function locName(dump: RunDump, id: number | null | undefined): string {
  return typeof id === "number"
    ? dump.locations.find((l) => l.id === id)?.displayName ?? `loc ${id}`
    : "—";
}
