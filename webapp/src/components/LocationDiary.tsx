import { useMemo } from "react";
import type { RunDump, RunEvent, SnapshotAuctionLot } from "../types.js";
import type { Selection } from "../App.js";
import { ActorChip } from "./Links.js";

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

  const dayEvents = useMemo(
    () => dump.events.filter((e) => e.at.day === day),
    [dump, day],
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
    for (let h = 0; h <= 23; h += 1) {
      while (idx < travels.length && travels[idx]!.at.hour <= h) {
        const t = travels[idx]!;
        current.set(t.actorId as number, (t.toLocationId as number) ?? null);
        idx += 1;
      }
      const here = out.get(h)!;
      for (const [aid, lid] of current) if (lid === locationId) here.add(aid);
    }
    return out;
  }, [dayEvents, startOfDayLocations, locationId]);

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

  // Today's auction lots — used by the auction view.
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
        auctionHour={dump.auctionHour}
      />

      <div className="diary-hours">
        {hourRange.map((h) => {
          const isCurrent = h === hour;
          const isOpen = isHourOpen(loc, h);
          const isStar =
            isAuction && dump.auctionHour !== undefined && h === dump.auctionHour;
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
                {isStar ? (
                  <div className="star-lots">
                    <span className="star-flag">★ Auction now</span>
                    {todaysLots.length === 0 ? (
                      <span className="muted">no lots today</span>
                    ) : (
                      <ul className="lot-list">
                        {todaysLots.map((l) => (
                          <AuctionLotRow key={l.id} lot={l} dump={dump} onSelect={onSelect} />
                        ))}
                      </ul>
                    )}
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
                        <span>{summarizeLocEvent(e, dump)}</span>
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
  auctionHour,
}: {
  loc: RunDump["locations"][number];
  residents: readonly RunDump["actors"][number][];
  dump: RunDump;
  onSelect: (s: Selection) => void;
  isAuction: boolean;
  auctionHour: number | undefined;
}) {
  if (isAuction) {
    return (
      <div className="diary-meta">
        ★ Daily auction {auctionHour !== undefined ? `at ${String(auctionHour).padStart(2, "0")}:00` : ""}
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
  const item = dump.items.find((i) => i.id === lot.itemKindId);
  const cleared =
    lot.clearedDay !== null && lot.clearedToActorId !== null
      ? `→ ${dump.actors.find((a) => a.id === lot.clearedToActorId)?.displayName ?? `actor ${lot.clearedToActorId}`} for £${lot.clearedPrice}`
      : lot.clearedDay !== null
        ? "unsold"
        : "live";
  return (
    <li>
      <strong>{item?.displayName ?? `item ${lot.itemKindId}`}</strong>{" "}
      <span className={`tier tier-${lot.qualityTier}`}>{lot.qualityTier}</span>{" "}
      ×{lot.quantity}{" "}
      <span className="muted">floor £{lot.floorPrice}</span>{" "}
      <span className="muted">— {cleared}</span>
      {lot.clearedToActorId !== null ? (
        <>
          {" "}
          <ActorChip
            dump={dump}
            actorId={lot.clearedToActorId}
            onSelect={onSelect}
            size={16}
            showName={false}
          />
        </>
      ) : null}
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
  if (loc.id === dump.auctionLocationId && dump.auctionHour !== undefined) {
    return range(Math.max(0, dump.auctionHour - 2), Math.min(23, dump.auctionHour + 4));
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

function summarizeLocEvent(e: RunEvent, dump: RunDump): string {
  const actorName = (id: unknown) =>
    typeof id === "number"
      ? dump.actors.find((a) => a.id === id)?.displayName ?? `actor ${id}`
      : "?";
  const itemName = (id: unknown) =>
    typeof id === "number"
      ? dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`
      : "?";

  switch (e.type) {
    case "actor.travelled":
      return `${actorName(e.actorId)} arrived`;
    case "gossip.exchanged":
      return `${actorName(e.visitorActorId)} ↔ ${actorName(e.proprietorActorId)}`;
    case "pubdeal.attempted":
      return `${actorName(e.sellerActorId)} → ${actorName(e.buyerActorId)} re ${itemName(e.itemKindId)} ×${e.quantity}`;
    case "pubdeal.agreed":
      return `${actorName(e.sellerActorId)} → ${actorName(e.buyerActorId)} agreed deal ${e.dealId} @£${e.unitPrice}`;
    case "pubdeal.walked":
      return `${actorName(e.sellerActorId)} & ${actorName(e.buyerActorId)} couldn't agree`;
    case "auction.cleared":
      return `lot ${e.auctionLotId} → ${actorName(e.winnerActorId)} for £${e.totalPrice}`;
    case "auction.unsold":
      return `lot ${e.auctionLotId} unsold (${e.reason})`;
    case "deal.settled":
      return `deal ${e.dealId}: ${actorName(e.sellerActorId)} → ${actorName(e.buyerActorId)} for £${e.totalPrice}`;
    case "deal.defaulted":
      return `deal ${e.dealId} defaulted — ${e.reason}`;
    case "pool.claimed":
      return `${actorName(e.actorId)} claimed pool ${e.poolId} ×${e.quantity}`;
    case "authority.raid":
      return `🚨 ${actorName(e.actorId)} raided — £${e.fine} fine`;
    default:
      return "";
  }
}
