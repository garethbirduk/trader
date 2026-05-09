import { useMemo } from "react";
import type { RunDump, RunEvent, SnapshotAuctionLot } from "../types.js";
import type { Selection } from "../App.js";
import { ActorChip } from "./Links.js";
import { ActorRef, DealRef, ItemRef, LotRef, PoolRef } from "./Refs.js";
import { resolveAuctionWindow } from "../lib/auction-window.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly locationId: number;
  readonly onChangeDay: (d: number) => void;
  readonly onSelect: (s: Selection) => void;
}

/**
 * Day diary for a location, branching by location type:
 *
 *  - **home**: residents listed up top + per-hour visitors with avatars
 *  - **business / pub / civic**: opening-hours band + hourly attendance
 *  - **auction**: today's lots scheduled at the auction hour as star
 *    events, otherwise quiet
 *  - **street / abstract**: minimal — just events
 *
 * Booked attendance comes from each actor's hourly routine (skin
 * pre-seeded). Actual attendance — what really happened given the
 * simulation events — is computed by replaying actor.travelled events
 * from the previous day's end-of-day snapshot.
 */
export function LocationDiary({
  dump,
  day,
  hour,
  locationId,
  onChangeDay,
  onSelect,
}: Props) {
  const loc = dump.locations.find((l) => l.id === locationId);
  if (loc === undefined) return null;

  // Diary is a turn-by-turn replay: only events at-or-before the
  // current cursor hour have "happened" yet.
  const dayEvents = useMemo(
    () =>
      dump.events.filter((e) => e.at.day === day && e.at.hour <= hour),
    [dump, day, hour],
  );

  // Actual presence per hour, computed by replaying travels from the
  // previous day's end-of-day snapshot positions.
  const startOfDayLocations = useMemo(() => {
    const m = new Map<number, number | null>();
    const snap =
      dump.snapshots?.find((s) => s.day === day - 1) ??
      dump.snapshots?.find((s) => s.day === day) ??
      null;
    if (snap !== null) for (const a of snap.actors) m.set(a.id, a.currentLocationId);
    return m;
  }, [dump, day]);

  const presenceByHour = useMemo(() => {
    const current = new Map<number, number | null>(startOfDayLocations);
    const out = new Map<number, Set<number>>();
    for (let h = 0; h <= 23; h += 1) out.set(h, new Set<number>());
    const travels = dayEvents
      .filter((e) => e.type === "actor.travelled")
      .sort((a, b) => a.at.hour - b.at.hour);
    let idx = 0;
    // Only fill out presence up to the cursor hour — anything later
    // hasn't happened yet, so we don't know who's there.
    for (let h = 0; h <= hour; h += 1) {
      while (idx < travels.length && travels[idx]!.at.hour <= h) {
        const t = travels[idx]!;
        current.set(t.actorId as number, (t.toLocationId as number) ?? null);
        idx += 1;
      }
      const here = out.get(h)!;
      for (const [aid, lid] of current) if (lid === locationId) here.add(aid);
    }
    return out;
  }, [dayEvents, startOfDayLocations, locationId, hour]);

  // Booked presence per hour from skin routines.
  const bookedByHour = useMemo(() => {
    const out = new Map<number, Set<number>>();
    for (let h = 0; h <= 23; h += 1) out.set(h, new Set<number>());
    if (!dump.actorRoutines) return out;
    for (const r of dump.actorRoutines) {
      for (const e of r.schedule) {
        if (e.locationId === locationId) out.get(e.hour)!.add(r.actorId);
      }
    }
    return out;
  }, [dump.actorRoutines, locationId]);

  const eventsByHour = useMemo(() => {
    const m = new Map<number, RunEvent[]>();
    for (let h = 0; h <= 23; h += 1) m.set(h, []);
    for (const e of dayEvents) {
      const here = presenceByHour.get(e.at.hour) ?? new Set();
      const matchesLoc =
        (e.type === "gossip.exchanged" && e.atLocationId === locationId) ||
        (e.type === "actor.travelled" && e.toLocationId === locationId);
      const matchesActor =
        (typeof e.actorId === "number" && here.has(e.actorId)) ||
        (typeof e.buyerActorId === "number" && here.has(e.buyerActorId)) ||
        (typeof e.sellerActorId === "number" && here.has(e.sellerActorId)) ||
        (typeof e.winnerActorId === "number" && here.has(e.winnerActorId));
      if (matchesLoc || matchesActor) m.get(e.at.hour)!.push(e);
    }
    return m;
  }, [dayEvents, presenceByHour, locationId]);

  const hourRange = chooseHourRange(loc, dump);
  const isAuction =
    loc.type === "auction" || locationId === dump.auctionLocationId;
  const auctionWindow = resolveAuctionWindow(dump);

  // Today's auction lots — used by the auction view. Indexed by
  // scheduledHour so each hour row in the window can show its lot.
  const todaysLots = useMemo<SnapshotAuctionLot[]>(() => {
    if (!isAuction) return [];
    const snap = dump.snapshots?.find((s) => s.day === day) ?? null;
    if (snap === null) return [];
    return snap.auctionLots.filter(
      (l) =>
        l.listedDay <= day &&
        (l.clearedDay === null || l.clearedDay === day),
    );
  }, [dump, day, isAuction]);

  const lotByScheduledHour = useMemo(() => {
    const m = new Map<number, SnapshotAuctionLot>();
    for (const l of todaysLots) {
      if (l.scheduledHour !== undefined && l.scheduledHour !== null) {
        m.set(l.scheduledHour, l);
      }
    }
    return m;
  }, [todaysLots]);

  const residents = useMemo(
    () => dump.actors.filter((a) => a.homeLocationId === locationId),
    [dump.actors, locationId],
  );

  return (
    <section className="diary">
      <header className="diary-nav">
        <button onClick={() => onChangeDay(day - 1)} disabled={day <= 1} title="prev day">‹</button>
        <span className="diary-day">
          Day {day} · {loc.displayName}
        </span>
        <button
          onClick={() => onChangeDay(day + 1)}
          disabled={day >= dump.runLengthDays}
          title="next day"
        >›</button>
      </header>

      <LocationHeader
        loc={loc}
        residents={residents}
        dump={dump}
        onSelect={onSelect}
        isAuction={isAuction}
        auctionWindow={auctionWindow}
      />

      <div className="diary-hours">
        {hourRange.map((h) => {
          const isCurrent = h === hour;
          const isOpen = isHourOpen(loc, h);
          // Auction-window star rows: any hour in the docket window
          // that has a scheduled lot, but only once the cursor has
          // reached or passed it (the auction hasn't happened yet for
          // hours after `hour`). Future-hour rows still show the
          // scheduled lot as "on view."
          const lotForHour = lotByScheduledHour.get(h);
          const isWindowHour =
            isAuction &&
            auctionWindow !== null &&
            h >= auctionWindow.start &&
            h <= auctionWindow.end;
          const isStar = isWindowHour && lotForHour !== undefined;
          const auctionEventsThisHour = isStar
            ? (eventsByHour.get(h) ?? []).filter(
                (e) =>
                  e.type === "auction.cleared" ||
                  e.type === "auction.unsold" ||
                  e.type === "auction.written_off",
              )
            : [];
          const auctionLive = auctionEventsThisHour.length > 0;
          const auctionUpcoming = isStar && h > hour && !auctionLive;
          const peopleHere = sortByPlayerFirst(
            [...(presenceByHour.get(h) ?? new Set<number>())],
            dump.playerActorId,
          );
          const peopleBooked = sortByPlayerFirst(
            [...(bookedByHour.get(h) ?? new Set<number>())],
            dump.playerActorId,
          );
          const events = eventsByHour.get(h) ?? [];
          return (
            <div
              key={h}
              className={`diary-row ${isCurrent ? "diary-row-now" : ""} ${isStar ? "diary-row-star" : ""}`}
            >
              <span className="diary-hour">{String(h).padStart(2, "0")}:00</span>
              <div className="diary-loc-body">
                {!isOpen && !isStar && peopleHere.length === 0 ? (
                  <span className="muted">closed</span>
                ) : null}
                {isStar && lotForHour !== undefined ? (
                  <div className="star-lots">
                    <span className="star-flag">
                      {auctionLive
                        ? "★ Auction now"
                        : auctionUpcoming
                          ? "Auction · upcoming"
                          : "Auction · cleared"}
                    </span>
                    <ul className="lot-list">
                      <AuctionLotRow
                        lot={lotForHour}
                        dump={dump}
                        onSelect={onSelect}
                      />
                    </ul>
                  </div>
                ) : null}
                {peopleHere.length > 0 ? (
                  <div className="people-row">
                    {peopleHere.map((aid) => (
                      <ActorChip
                        key={aid}
                        dump={dump}
                        actorId={aid}
                        onSelect={onSelect}
                        size={18}
                        showName={false}
                      />
                    ))}
                  </div>
                ) : null}
                {peopleBooked.length > 0 &&
                peopleHere.length === 0 &&
                isOpen ? (
                  <div className="people-row people-booked muted">
                    booked:
                    {peopleBooked.map((aid) => (
                      <ActorChip
                        key={aid}
                        dump={dump}
                        actorId={aid}
                        onSelect={onSelect}
                        size={16}
                        showName={false}
                      />
                    ))}
                  </div>
                ) : null}
                {events.length > 0 ? (
                  <div className="diary-events">
                    {events.map((e, i) => (
                      <div key={i} className={`diary-event diary-event-${e.type.replace(/\./g, "-")}`}>
                        <span className="muted">{e.type}</span>{" "}
                        <span>{summarizeLocEvent(e, dump, onSelect)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LocationHeader({
  loc,
  residents,
  dump,
  onSelect,
  isAuction,
  auctionWindow,
}: {
  loc: RunDump["locations"][number];
  residents: readonly RunDump["actors"][number][];
  dump: RunDump;
  onSelect: (s: Selection) => void;
  isAuction: boolean;
  auctionWindow: { start: number; end: number } | null;
}) {
  if (isAuction) {
    const auctionLabel = auctionWindow
      ? auctionWindow.start === auctionWindow.end
        ? `at ${fmtHour(auctionWindow.start)}`
        : `${fmtHour(auctionWindow.start)}–${fmtHour(auctionWindow.end)}, one lot/hr`
      : "";
    return (
      <div className="diary-meta">
        ★ Daily auction {auctionLabel}
        {loc.openHours
          ? ` · viewing ${fmtHour(loc.openHours.start)}–${fmtHour(loc.openHours.end)}`
          : null}
      </div>
    );
  }
  if (loc.type === "home") {
    return (
      <div className="diary-meta">
        <span className="muted">Lives here:</span>
        {residents.length === 0 ? (
          <span className="muted">— nobody</span>
        ) : (
          <div className="people-row">
            {residents.map((r) => (
              <ActorChip
                key={r.id}
                dump={dump}
                actorId={r.id}
                onSelect={onSelect}
                size={18}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
  if (loc.openHours !== undefined && loc.openHours !== null) {
    return (
      <div className="diary-meta">
        <span className="muted">Open</span> {fmtHour(loc.openHours.start)}
        –{fmtHour(loc.openHours.end)}
      </div>
    );
  }
  return null;
}

function AuctionLotRow({
  lot,
  dump,
  onSelect,
}: {
  lot: SnapshotAuctionLot;
  dump: RunDump;
  onSelect: (s: Selection) => void;
}) {
  return (
    <li>
      <LotRef dump={dump} id={lot.id} onSelect={onSelect} variant="inline" />{" "}
      <ItemRef
        dump={dump}
        id={lot.itemKindId}
        onSelect={onSelect}
        variant="inline"
        qualityTier={lot.qualityTier}
      />{" "}
      ×{lot.quantity}{" "}
      <span className="muted">floor £{lot.floorPrice}</span>{" "}
      {lot.clearedDay !== null && lot.clearedToActorId !== null ? (
        <span className="muted">
          —{" → "}
          <ActorRef
            dump={dump}
            id={lot.clearedToActorId}
            onSelect={onSelect}
            variant="inline"
          />{" "}
          for £{lot.clearedPrice}
        </span>
      ) : lot.clearedDay !== null ? (
        <span className="muted">— unsold</span>
      ) : (
        <span className="muted">— live</span>
      )}
    </li>
  );
}

function chooseHourRange(
  loc: RunDump["locations"][number],
  dump: RunDump,
): readonly number[] {
  // Always show 06–23 by default; clip homes to a slightly later span
  // (people sleep in) and businesses to their open hours plus a bit.
  if (loc.type === "abstract") return [];
  if (loc.openHours) {
    const s = Math.max(0, loc.openHours.start - 1);
    const e = Math.min(23, Math.max(loc.openHours.end, loc.openHours.start) + 1);
    return range(s, e);
  }
  const w = resolveAuctionWindow(dump);
  if (loc.id === dump.auctionLocationId && w !== null) {
    return range(Math.max(0, w.start - 3), Math.min(23, w.end + 1));
  }
  return range(6, 23);
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i += 1) out.push(i);
  return out;
}

function isHourOpen(
  loc: RunDump["locations"][number],
  hour: number,
): boolean {
  if (loc.type === "home") return true;
  if (loc.type === "street") return true;
  if (loc.openHours === undefined || loc.openHours === null) return true;
  const { start, end } = loc.openHours;
  if (start <= end) return hour >= start && hour < end;
  // Wraps midnight (e.g. 20–02 represented as 20–26).
  if (end > 24) return hour >= start || hour < end - 24;
  return hour >= start && hour < end;
}

function fmtHour(h: number): string {
  const norm = h >= 24 ? h - 24 : h;
  return `${String(norm).padStart(2, "0")}:00`;
}

function sortByPlayerFirst(ids: number[], playerId: number): number[] {
  return [...ids].sort((a, b) => {
    if (a === playerId) return -1;
    if (b === playerId) return 1;
    return a - b;
  });
}

function summarizeLocEvent(
  e: RunEvent,
  dump: RunDump,
  onSelect: (s: Selection) => void,
): JSX.Element {
  const A = (id: unknown) =>
    typeof id === "number" ? (
      <ActorRef dump={dump} id={id} onSelect={onSelect} variant="inline" />
    ) : (
      <span className="muted">?</span>
    );
  const I = (id: unknown) =>
    typeof id === "number" ? (
      <ItemRef dump={dump} id={id} onSelect={onSelect} variant="inline" />
    ) : (
      <span className="muted">?</span>
    );
  const Lot = (id: unknown) =>
    typeof id === "number" ? (
      <LotRef dump={dump} id={id} onSelect={onSelect} variant="inline" />
    ) : (
      <span className="muted">lot ?</span>
    );
  const Deal = (id: unknown) =>
    typeof id === "number" ? (
      <DealRef dump={dump} id={id} onSelect={onSelect} variant="inline" />
    ) : (
      <span className="muted">deal ?</span>
    );
  const Pool = (id: unknown) =>
    typeof id === "number" ? (
      <PoolRef dump={dump} id={id} onSelect={onSelect} variant="inline" />
    ) : (
      <span className="muted">pool ?</span>
    );

  switch (e.type) {
    case "actor.travelled":
      return <>{A(e.actorId)} arrived</>;
    case "gossip.exchanged":
      return (
        <>
          {A(e.visitorActorId)} ↔ {A(e.proprietorActorId)}
        </>
      );
    case "pubdeal.attempted":
      return (
        <>
          {A(e.sellerActorId)} → {A(e.buyerActorId)} re {I(e.itemKindId)} ×{String(e.quantity)}
        </>
      );
    case "pubdeal.agreed":
      return (
        <>
          {A(e.sellerActorId)} → {A(e.buyerActorId)} agreed {Deal(e.dealId)} @£{String(e.unitPrice)}
        </>
      );
    case "pubdeal.walked":
      return (
        <>
          {A(e.sellerActorId)} &amp; {A(e.buyerActorId)} couldn't agree
        </>
      );
    case "auction.cleared":
      return (
        <>
          {Lot(e.auctionLotId)} → {A(e.winnerActorId)} for £{String(e.totalPrice)}
        </>
      );
    case "auction.unsold":
      return (
        <>
          {Lot(e.auctionLotId)} unsold ({String(e.reason)})
        </>
      );
    case "deal.settled":
      return (
        <>
          {Deal(e.dealId)}: {A(e.sellerActorId)} → {A(e.buyerActorId)} for £{String(e.totalPrice)}
        </>
      );
    case "deal.defaulted":
      return (
        <>
          {Deal(e.dealId)} defaulted — {String(e.reason)}
        </>
      );
    case "pool.claimed":
      return (
        <>
          {A(e.actorId)} claimed {Pool(e.poolId)} ×{String(e.quantity)}
        </>
      );
    case "authority.raid":
      return (
        <>
          🚨 {A(e.actorId)} raided — £{String(e.fine)} fine
        </>
      );
    case "auction.knowledge-acquired":
      return (
        <>
          {A(e.actorId)} learned about {Lot(e.auctionLotId)}{" "}
          <span className="muted">via {String(e.via)}</span>
        </>
      );
    case "auction.lot-inspected":
      return (
        <>
          {A(e.actorId)} inspected {Lot(e.auctionLotId)}
        </>
      );
    default:
      return <></>;
  }
}
