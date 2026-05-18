import { useEffect, useMemo, useRef, useState } from "react";
import type { DaySnapshot, RunActor, RunDump, RunLocation, SnapshotStockLot } from "../types.js";
import type { SidebarTopTab } from "../App.js";
import { useSelectionSet, type SelectionItem } from "../lib/selection-set.js";
import { usePov } from "../lib/pov.js";
import { useKnownIds, type KnownIds } from "../lib/pov-knowledge.js";
import { Avatar } from "./Avatar.js";
import { LocationAvatar } from "./LocationAvatar.js";
import { BeliefChip } from "./BeliefChip.js";
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
  family: "Family",
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

type StockGrouping = "owner" | "location";

function readStockGrouping(): StockGrouping {
  try {
    const raw = localStorage.getItem(STOCK_GROUPING_KEY);
    if (raw === "owner" || raw === "location") return raw;
  } catch {
    /* ignore */
  }
  return "owner";
}

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly topTab: SidebarTopTab;
  readonly setTopTab: (t: SidebarTopTab) => void;
}

export function Sidebar(props: Props) {
  const { dump, day, snapshot, topTab, setTopTab } = props;
  const { pov } = usePov();
  // Knowledge filter: in player POV, restrict lists to what this actor
  // knows (gossip-mentioned, transacted, witnessed). Admin POV bypasses
  // (we pass `-1` as the actor id and discard the result via `known`).
  const povActorId = pov.kind === "actor" ? pov.actorId : null;
  const knownRaw = useKnownIds(dump, povActorId ?? -1, day);
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
            {known !== null ? (
              <div className="pov-knowledge-note" title="Filtered to entities this actor has met, traded with, or heard about in gossip.">
                Filtered to {known.actors.size} known actor{known.actors.size === 1 ? "" : "s"} · {known.itemKinds.size} item-kind{known.itemKinds.size === 1 ? "" : "s"} (POV: {pov.kind === "actor" ? dump.actors.find((a) => a.id === pov.actorId)?.displayName ?? "actor" : ""})
              </div>
            ) : null}
            {topTab === "actors" && (
              <ActorList dump={dump} snapshot={snapshot} day={day} roleFilter={roleFilter} known={known} />
            )}
            {topTab === "locations" && (
              <LocationList dump={dump} snapshot={snapshot} typeFilter={locTypeFilter} known={known} />
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
  day,
  roleFilter,
  known,
}: {
  dump: RunDump;
  snapshot: DaySnapshot | null;
  day: number;
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
    return filtered.sort((a, b) => {
      if (a.id === dump.playerActorId) return -1;
      if (b.id === dump.playerActorId) return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [dump, roleFilter, known]);

  return (
    <>
      <div className="side-list-header">D{day}</div>
      {sorted.map((a) => {
        const cash = cashByActor.get(a.id) ?? a.cash;
        const heat = heatByActor.get(a.id) ?? 0;
        const loc = locByActor.has(a.id) ? locByActor.get(a.id) ?? null : a.currentLocationId;
        const isPlayer = a.id === dump.playerActorId;
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
          <div key={a.id} className={`row-and-checks ${inSet ? "row-in-set" : ""}`}>
            <button
              type="button"
              className={`actor-row ${inSet ? "actor-row-selected" : ""}`}
              onClick={() => set.toggle(item)}
              title={inSet ? "Click to remove from selection" : "Click to add to selection"}
            >
              <Avatar name={a.displayName} code={a.code} isPlayer={isPlayer} size={28} />
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
                  {a.isVirtual === true
                    ? <span className="muted">virtual producer</span>
                    : <>{locName(dump, loc)} · {a.transportCapacity}</>}
                </span>
              </div>
              <span className={`actor-cash ${cash === 0 ? "zero" : ""}`}>
                {a.isVirtual === true ? "—" : `£${cash}`}
              </span>
            </button>
            <SubChecks checks={checks} />
          </div>
        );
      })}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────
// Location list — rows + nested stock + sub-checks (proprietor / stock here / lots)
// ────────────────────────────────────────────────────────────────────

function LocationList({
  dump,
  snapshot,
  typeFilter,
  known,
}: {
  dump: RunDump;
  snapshot: DaySnapshot | null;
  typeFilter: ReadonlySet<string>;
  known: KnownIds | null;
}) {
  const set = useSelectionSet();
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

  // Stock-by-location, but only stock kinds the POV actor knows about.
  // Locations themselves are always visible per docs/ui.md §5.2 —
  // "discovery layer added later" — so the location rows themselves
  // aren't filtered; only the nested stock and the "stock here" bulk.
  const stockByLoc = useMemo(() => {
    const m = new Map<number, SnapshotStockLot[]>();
    if (snapshot !== null) {
      for (const lot of snapshot.stockLots) {
        if (lot.locationId === null) continue;
        if (known !== null && !known.itemKinds.has(lot.itemKindId)) continue;
        const list = m.get(lot.locationId) ?? [];
        list.push(lot);
        m.set(lot.locationId, list);
      }
    }
    return m;
  }, [snapshot, known]);

  const proprietorByLoc = useMemo(() => {
    const m = new Map<number, RunActor>();
    for (const a of dump.actors) {
      if (a.isVirtual === true) continue;
      const hid = a.homeLocationId;
      if (hid === null || hid === undefined) continue;
      const existing = m.get(hid);
      if (existing === undefined) m.set(hid, a);
    }
    return m;
  }, [dump.actors]);

  const lotsByLoc = useMemo(() => {
    const m = new Map<number, number[]>();
    if (snapshot !== null) {
      for (const lot of snapshot.auctionLots) {
        const auctionLocId = dump.auctionLocationId;
        if (auctionLocId === undefined) continue;
        if (lot.clearedDay !== null) continue;
        const list = m.get(auctionLocId) ?? [];
        list.push(lot.id);
        m.set(auctionLocId, list);
      }
    }
    return m;
  }, [snapshot, dump.auctionLocationId]);

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
      {sorted.map((l) => {
        const item: SelectionItem = { kind: "location", id: l.id };
        const inSet = set.has(item);
        const pop = popByLoc.get(l.id) ?? 0;
        const stock = stockByLoc.get(l.id) ?? [];
        const proprietor = proprietorByLoc.get(l.id);
        const lots = lotsByLoc.get(l.id) ?? [];

        const checks: SubCheck[] = [];
        if (proprietor !== undefined) {
          checks.push({
            kind: "single",
            label: `proprietor (${proprietor.displayName})`,
            item: { kind: "actor", id: proprietor.id },
            title: "Add proprietor to selection",
          });
        }
        if (stock.length > 0) {
          checks.push({
            kind: "bulk",
            label: "stock here",
            items: stock.map<SelectionItem>((s) => ({ kind: "item", id: s.itemKindId })),
            title: `${stock.length} stock kind${stock.length === 1 ? "" : "s"} held at this venue`,
          });
        }
        if (lots.length > 0) {
          checks.push({
            kind: "bulk",
            label: "all lots",
            items: lots.map<SelectionItem>((id) => ({ kind: "lot", id })),
            title: `${lots.length} open lot${lots.length === 1 ? "" : "s"} at this venue`,
          });
        }

        return (
          <div key={l.id} className={`row-and-checks ${inSet ? "row-in-set" : ""}`}>
            <button
              type="button"
              className={`loc-row ${inSet ? "actor-row-selected" : ""}`}
              onClick={() => set.toggle(item)}
              title={inSet ? "Click to remove from selection" : "Click to add to selection"}
            >
              <LocationAvatar
                displayName={l.displayName}
                code={l.code}
                type={l.type}
                size={24}
              />
              <div className="loc-name">
                <span>{l.displayName}</span>
                <span className="actor-loc">{l.code}</span>
              </div>
              <span className={`loc-pop ${pop === 0 ? "zero" : ""}`}>
                {pop === 0 ? "—" : `${pop} here`}
              </span>
            </button>
            <SubChecks checks={checks} />
            {stock.length > 0 ? (
              <div className="loc-stock-nest">
                {stock.map((s) => (
                  <StockRow key={s.id} lot={s} dump={dump} contextLocation={l} />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
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

  const grouped = useMemo(() => {
    const m = new Map<number, SnapshotStockLot[]>();
    for (const lot of lots) {
      const key = grouping === "owner" ? lot.ownerActorId : (lot.locationId ?? -1);
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
    const keys = [...grouped.keys()];
    const labelFor = (k: number): string => {
      if (grouping === "owner") {
        const a = dump.actors.find((x) => x.id === k);
        return a?.displayName ?? `actor ${k}`;
      }
      if (k === -1) return "(no location)";
      const l = dump.locations.find((x) => x.id === k);
      return l?.displayName ?? `loc ${k}`;
    };
    return keys.sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
  }, [grouped, grouping, dump]);

  if (lots.length === 0) {
    return <div className="side-lower-empty muted">No stock at the current day.</div>;
  }

  return (
    <>
      <div className="stock-grouping" role="tablist" aria-label="Stock grouping">
        <button
          type="button"
          className={`stock-grouping-btn ${grouping === "owner" ? "active" : ""}`}
          onClick={() => onChangeGrouping("owner")}
        >
          by owner
        </button>
        <button
          type="button"
          className={`stock-grouping-btn ${grouping === "location" ? "active" : ""}`}
          onClick={() => onChangeGrouping("location")}
        >
          by location
        </button>
      </div>
      {sortedKeys.map((key) => {
        const arr = grouped.get(key) ?? [];
        const headerLabel =
          grouping === "owner"
            ? dump.actors.find((a) => a.id === key)?.displayName ?? `actor ${key}`
            : key === -1
            ? "(no location)"
            : dump.locations.find((l) => l.id === key)?.displayName ?? `loc ${key}`;
        return (
          <div key={key} className="stock-group">
            <div className="stock-group-header">
              <span className="stock-group-title">{headerLabel}</span>
              <span className="stock-group-count">{arr.length} lot{arr.length === 1 ? "" : "s"}</span>
            </div>
            {arr.map((lot) => (
              <StockRow key={lot.id} lot={lot} dump={dump} />
            ))}
          </div>
        );
      })}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────
// Shared stock row
// ────────────────────────────────────────────────────────────────────

function StockRow({
  lot,
  dump,
  contextLocation,
}: {
  lot: SnapshotStockLot;
  dump: RunDump;
  contextLocation?: RunLocation;
}) {
  const set = useSelectionSet();
  const { pov } = usePov();
  const itemKind: SelectionItem = { kind: "item", id: lot.itemKindId };
  const inSet = set.has(itemKind);
  const owner = dump.actors.find((a) => a.id === lot.ownerActorId);
  const loc = lot.locationId !== null ? dump.locations.find((l) => l.id === lot.locationId) : undefined;

  // Per-row chip POV: actor POV → that actor's belief (single POV chip,
  // per feedback_chip_layering_pattern). Admin POV → truth chip (no
  // avatar, unit = tierTruth). Tier passes through: the actor's true
  // tier knowledge isn't modelled in the snapshot today, so we render
  // the lot's true tier in both modes — Phase 5 (POV semantics across
  // components) is where redaction lands.
  const observerActorId = pov.kind === "actor" ? pov.actorId : null;

  const checks: SubCheck[] = [];
  if (owner !== undefined) {
    checks.push({
      kind: "single",
      label: owner.displayName,
      item: { kind: "actor", id: owner.id },
      title: `Add ${owner.displayName} (owner) to selection`,
    });
  }
  if (loc !== undefined && contextLocation === undefined) {
    checks.push({
      kind: "single",
      label: loc.displayName,
      item: { kind: "location", id: loc.id },
      title: `Add ${loc.displayName} (held at) to selection`,
    });
  }

  return (
    <div className={`row-and-checks stock-row-wrap ${inSet ? "row-in-set" : ""}`}>
      <BeliefChip
        dump={dump}
        itemKindId={lot.itemKindId}
        qualityTier={lot.qualityTier}
        quantity={lot.quantity}
        observerActorId={observerActorId}
        onSelect={() => set.toggle(itemKind)}
      />
      <SubChecks checks={checks} />
    </div>
  );
}

function locName(dump: RunDump, id: number | null | undefined): string {
  return typeof id === "number"
    ? dump.locations.find((l) => l.id === id)?.displayName ?? `loc ${id}`
    : "—";
}
