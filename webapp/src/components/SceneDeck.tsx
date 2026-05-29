import { useEffect, useMemo, useRef, useState } from "react";
import type { DaySnapshot, RunDump, RunEvent, SnapshotAuctionLot, SnapshotDeal, SnapshotStockLot } from "../types.js";
import type { Selection } from "../App.js";
import { LocationLink } from "./Links.js";
import { ItemRef, LotRef } from "./Refs.js";
import { ActorChipById } from "./ActorChip.js";
import { StockChip } from "./StockChip.js";
import { useSelectionSet } from "../lib/selection-set.js";
import { chipName, fullName } from "../lib/actor-names.js";
import { nextRungAbove, rungAtOrBelow } from "../lib/bid-ladder.js";
import { isHourInAuctionWindow } from "../lib/auction-window.js";
import {
  getJudgementById,
  indexJudgements,
  isComposite,
  isPriceArm,
  type JudgementIndex,
} from "../lib/judgement-log.js";
import {
  formatCompositeMath,
  formatPriceArmMathFromPayload,
} from "../lib/perception.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly snapshot: DaySnapshot | null;
  readonly onSelect: (s: Selection) => void;
  /** Player POV filter: when non-null, only events the actor participated
   *  in survive. Admin (null) sees the full fan-out. */
  readonly povActorId: number | null;
}

interface Scene {
  readonly key: string;
  readonly label: string;
  readonly render: () => JSX.Element;
}

/** Strict participation — does this event involve the given actor? */
function eventTouchesActor(e: RunEvent, actorId: number): boolean {
  switch (e.type) {
    case "auction.cleared":
    case "auction.unsold":
    case "auction.written_off": {
      const attendees = (e.attendees as readonly number[] | undefined) ?? [];
      return attendees.includes(actorId);
    }
    case "auction.lot-inspected":
      return e.actorId === actorId;
    case "pubdeal.agreed":
    case "pubdeal.walked":
    case "pubdeal.attempted":
      return e.sellerActorId === actorId || e.buyerActorId === actorId;
    case "market.hour-summary":
      return e.sellerActorId === actorId;
    case "gossip.exchanged": {
      const participants =
        (e.participantActorIds as readonly number[] | undefined) ?? [];
      return participants.includes(actorId);
    }
    case "gossip.detail-unlocked":
      return e.askerActorId === actorId || e.partnerActorId === actorId;
    case "authority.raid":
      return e.actorId === actorId;
    case "clearance.booked":
      return e.bookerActorId === actorId;
    case "clearance.resolved": {
      if (e.winnerActorId === actorId) return true;
      const losers = (e.loserActorIds as readonly number[] | undefined) ?? [];
      return losers.includes(actorId);
    }
    default:
      return false;
  }
}

/** Shape of a gossip exchange's embedded lead snapshot (mirror of
 *  engine `GossipExchange.lead`). Only the fields the unlock scene
 *  needs to render are pulled out. */
interface ExchangeLead {
  readonly id: number;
  readonly kind: "commodity" | "rep";
  readonly side: "supply" | "demand";
  readonly subjectItemKindId: number | null;
  readonly subjectQualityTier: string | null;
  readonly counterpartyActorId: number | null;
  readonly estimatedQuantity: number;
  readonly estimatedUnitPrice: number;
  readonly confidence: "warm" | "cold";
}

/** Build a `leadId → snapshot` index from every `gossip.exchanged`
 *  in the dump. The unlock scene uses this to look up the value
 *  fields for each leadId reported in `gossip.detail-unlocked` (the
 *  unlock event itself only carries ids + a flipped flag). */
function indexExchangeLeads(dump: RunDump): ReadonlyMap<number, ExchangeLead> {
  const out = new Map<number, ExchangeLead>();
  for (const e of dump.events) {
    if (e.type !== "gossip.exchanged") continue;
    const exchanges =
      (e.exchanges as readonly { lead: ExchangeLead }[] | undefined) ?? [];
    for (const x of exchanges) {
      if (!out.has(x.lead.id)) out.set(x.lead.id, x.lead);
    }
  }
  return out;
}

/**
 * Live "what's happening right now" deck for the current cursor hour.
 * Each in-progress activity (auction, pub deal, gossip) becomes its own
 * tab; once the cursor moves past the hour, the scene disappears.
 */
export function SceneDeck({ dump, day, hour, snapshot, onSelect, povActorId }: Props) {
  const set = useSelectionSet();
  // Actor ids in the current selection. Used to narrow the deck:
  //   • Admin + selected actor → drop events that don't touch any
  //     selected actor (so "Mickey selected" leaves only Mickey's
  //     gossip / deals / market / etc.).
  //   • Player POV — povActorId already does the narrowing; the
  //     selection set is informational only here.
  const focusActorIds = useMemo<ReadonlySet<number>>(() => {
    const out = new Set<number>();
    for (const s of set.items) {
      if (s.kind === "actor") out.add(s.id);
    }
    return out;
  }, [set.items]);

  const eventsThisHour = useMemo(() => {
    const all = dump.events.filter(
      (e) => e.at.day === day && e.at.hour === hour,
    );
    if (povActorId !== null) {
      return all.filter((e) => eventTouchesActor(e, povActorId));
    }
    if (focusActorIds.size === 0) return all;
    return all.filter((e) => {
      for (const id of focusActorIds) {
        if (eventTouchesActor(e, id)) return true;
      }
      return false;
    });
  }, [dump.events, day, hour, povActorId, focusActorIds]);

  const scenes = useMemo<readonly Scene[]>(() => {
    const list: Scene[] = [];

    // Auction — fires at the auction hour. Each lot is either being
    // auctioned right now (event present), on view for a later auction
    // (listed today, no event yet), or already on display from earlier.
    const auctionEvents = eventsThisHour.filter(
      (e) =>
        e.type === "auction.cleared" ||
        e.type === "auction.unsold" ||
        e.type === "auction.written_off",
    );
    const isAuctionHour = isHourInAuctionWindow(dump, hour);
    const eventLotIds = new Set<number>(
      auctionEvents.map((e) => e.auctionLotId as number),
    );
    // "On view" = today's docket lots scheduled for a LATER hour. They
    // have a known scheduledHour but haven't run yet. Past-hour lots
    // are already in the events list (cleared/unsold) so we don't
    // duplicate them. When dumps don't carry scheduledHour (legacy),
    // fall back to "any open lot listed by today".
    // In docket mode, "on view" is strictly today's later-hour lots.
    // Legacy single-hour mode falls back to listed-but-not-cleared.
    const docketMode =
      dump.auctionStartHour !== undefined && dump.auctionEndHour !== undefined;
    // Player POV: only surface "on view" lots when the player is
    // actually at the auction this hour (i.e. has an attendance event
    // in the filtered set). Admin always sees on-view.
    const playerAtAuction =
      povActorId === null || auctionEvents.length > 0;
    const onViewLots = isAuctionHour && playerAtAuction
      ? (snapshot?.auctionLots ?? []).filter((l) => {
          if (eventLotIds.has(l.id)) return false;
          if (docketMode) {
            return (
              l.scheduledHour !== undefined &&
              l.scheduledHour !== null &&
              l.scheduledHour > hour &&
              (l.clearedDay === null || l.clearedDay === day)
            );
          }
          if (l.listedDay > day) return false;
          if (l.clearedDay !== null && l.clearedDay < day) return false;
          return l.clearedDay === null || l.clearedDay === day;
        })
      : [];
    const totalLots = auctionEvents.length + onViewLots.length;
    if (totalLots > 0) {
      list.push({
        key: "auction",
        label: `Auction (${totalLots})`,
        render: () => (
          <AuctionScene
            events={auctionEvents}
            onViewLots={onViewLots}
            snapshot={snapshot}
            dump={dump}
            day={day}
            onSelect={onSelect}
          />
        ),
      });
    }

    // Pub deals — one tab per agreed/walked event, since each is a
    // discrete negotiation.
    eventsThisHour
      .filter((e) => e.type === "pubdeal.agreed")
      .forEach((e) => {
        const dealId = e.dealId as number;
        list.push({
          key: `pubdeal-agreed-${dealId}`,
          label: "Pub deal",
          render: () => (
            <PubdealAgreedScene
              event={e}
              dump={dump}
              snapshot={snapshot}
              hourEvents={eventsThisHour}
              onSelect={onSelect}
            />
          ),
        });
      });
    eventsThisHour
      .filter((e) => e.type === "pubdeal.walked")
      .forEach((e, i) => {
        list.push({
          key: `pubdeal-walked-${i}`,
          label: "Walk-out",
          render: () => (
            <PubdealWalkedScene
              event={e}
              dump={dump}
              hourEvents={eventsThisHour}
              onSelect={onSelect}
            />
          ),
        });
      });

    // Market — one tab covering every stall trading this hour.
    const market = eventsThisHour.filter(
      (e) => e.type === "market.hour-summary",
    );
    if (market.length > 0) {
      list.push({
        key: "market",
        label: `Market (${market.length})`,
        render: () => (
          <MarketScene events={market} dump={dump} snapshot={snapshot} onSelect={onSelect} />
        ),
      });
    }

    // Gossip — single tab covering every exchange this hour.
    const gossip = eventsThisHour.filter((e) => e.type === "gossip.exchanged");
    if (gossip.length > 0) {
      list.push({
        key: "gossip",
        label: `Gossip (${gossip.length})`,
        render: () => (
          <GossipScene
            events={gossip}
            dump={dump}
            onSelect={onSelect}
            povActorId={povActorId}
            focusActorIds={focusActorIds}
          />
        ),
      });
    }

    // Detail unlocks — receiver paid £3 + 1h to flip headlines they
    // already hold from `locked` to `unlocked`. The full lead values
    // (qty/price/counterparty) become visible here, in contrast to
    // the gossip headline rows where they're hidden.
    const unlocks = eventsThisHour.filter(
      (e) => e.type === "gossip.detail-unlocked",
    );
    if (unlocks.length > 0) {
      list.push({
        key: "detail-unlock",
        label: `Unlocks (${unlocks.length})`,
        render: () => (
          <DetailUnlockedScene events={unlocks} dump={dump} onSelect={onSelect} />
        ),
      });
    }

    // Authority raid — high-impact, gets its own tab per event.
    eventsThisHour
      .filter((e) => e.type === "authority.raid")
      .forEach((e, i) => {
        list.push({
          key: `raid-${i}`,
          label: "🚨 Raid",
          render: () => <RaidScene event={e} dump={dump} onSelect={onSelect} />,
        });
      });

    // Inspections — auction.lot-inspected events during the pre-auction
    // inspection window. One tab listing every inspector × lot pair
    // this hour. (Was previously only surfaced as a "· inspected"
    // suffix on the Knows-tab auction-lots row, which conflated time-
    // anchored state with persistent knowledge.)
    const inspections = eventsThisHour.filter(
      (e) => e.type === "auction.lot-inspected",
    );
    if (inspections.length > 0) {
      list.push({
        key: "inspections",
        label: `Inspections (${inspections.length})`,
        render: () => (
          <InspectionScene
            events={inspections}
            snapshot={snapshot}
            dump={dump}
            onSelect={onSelect}
          />
        ),
      });
    }

    // Clearance lifecycle — one tab per hour covering every listed /
    // booked / resolved / expired event.
    const clearance = eventsThisHour.filter(
      (e) =>
        e.type === "clearance.listed" ||
        e.type === "clearance.booked" ||
        e.type === "clearance.resolved" ||
        e.type === "clearance.expired",
    );
    if (clearance.length > 0) {
      list.push({
        key: "clearance",
        label: `Clearance (${clearance.length})`,
        render: () => (
          <ClearanceScene events={clearance} dump={dump} onSelect={onSelect} />
        ),
      });
    }

    return list;
  }, [eventsThisHour, snapshot, dump, day, onSelect, povActorId, focusActorIds]);

  const [activeKey, setActiveKey] = useState<string | null>(null);
  useEffect(() => {
    // Hold the active tab when scenes recompute. The `scenes` useMemo
    // re-runs whenever the parent re-renders (e.g. lower-panel resize
    // changes App's lowerPx, which re-creates the inline `onSelect`
    // arrow we depend on), so an unconditional reset to scenes[0]
    // would yank focus back to the first tab on every drag tick.
    // Only fall back when the active scene's key no longer exists —
    // typically because the cursor advanced to a new hour.
    if (scenes.length === 0) {
      setActiveKey(null);
      return;
    }
    setActiveKey((cur) =>
      cur !== null && scenes.some((s) => s.key === cur) ? cur : scenes[0]!.key,
    );
  }, [scenes]);

  if (scenes.length === 0) {
    return (
      <div className="scene-empty muted">
        Nothing playing out at D{pad(day)} {pad(hour)}:00.
      </div>
    );
  }

  const active = scenes.find((s) => s.key === activeKey) ?? scenes[0]!;

  return (
    <div className="scene-deck">
      <nav className="scene-tabs">
        {scenes.map((s) => (
          <button
            key={s.key}
            className={`scene-tab ${s.key === active.key ? "scene-tab-active" : ""}`}
            onClick={() => setActiveKey(s.key)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="scene-body">{active.render()}</div>
    </div>
  );
}

/* ─── Scene renderers ──────────────────────────────────────────────── */

function AuctionScene({
  events,
  onViewLots,
  snapshot,
  dump,
  day,
  onSelect,
}: {
  readonly events: readonly RunEvent[];
  readonly onViewLots: readonly SnapshotAuctionLot[];
  readonly snapshot: DaySnapshot | null;
  readonly dump: RunDump;
  readonly day: number;
  readonly onSelect: (s: Selection) => void;
}) {
  const itemName = (id: number) =>
    dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`;
  const locId = dump.auctionLocationId;

  // Pair each auction event with its full lot record from the snapshot.
  const playingCards = useMemo(() => {
    const out: { event: RunEvent; lot: SnapshotAuctionLot | null }[] = [];
    for (const e of events) {
      const lotId = e.auctionLotId as number;
      const lot = snapshot?.auctionLots.find((l) => l.id === lotId) ?? null;
      out.push({ event: e, lot });
    }
    return out;
  }, [events, snapshot]);

  const hasAuction = events.length > 0;
  const totalLots = playingCards.length + onViewLots.length;

  return (
    <section className="scene scene-auction">
      <header className="scene-header">
        <span className="scene-tag">{hasAuction ? "★ Auction" : "Auction · viewing"}</span>
        {locId !== undefined ? (
          <LocationLink dump={dump} locationId={locId} onSelect={onSelect} />
        ) : (
          <span>Sotheby's</span>
        )}
        <span className="muted">
          · {totalLots} lot{totalLots === 1 ? "" : "s"}
          {hasAuction && onViewLots.length > 0
            ? ` (${playingCards.length} on the block, ${onViewLots.length} on view)`
            : !hasAuction
              ? " on view — auctioned next session"
              : ""}
        </span>
      </header>
      {totalLots === 0 ? (
        <div className="muted">No lot details on file.</div>
      ) : (
        <ul className="lot-cards">
          {playingCards.map(({ event, lot }, i) => (
            <li key={`p-${i}`}>
              <AuctionLotPlayer
                event={event}
                lot={lot}
                dump={dump}
                day={day}
                onSelect={onSelect}
                itemName={itemName}
              />
            </li>
          ))}
          {onViewLots.map((lot) => (
            <li key={`v-${lot.id}`}>
              <AuctionLotOnView
                lot={lot}
                dump={dump}
                day={day}
                onSelect={onSelect}
                itemName={itemName}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AuctionLotOnView({
  lot,
  dump,
  day,
  onSelect,
  itemName,
}: {
  readonly lot: SnapshotAuctionLot;
  readonly dump: RunDump;
  readonly day: number;
  readonly onSelect: (s: Selection) => void;
  readonly itemName: (id: number) => string;
}) {
  void onSelect;
  void dump;
  // Docket mode: lot has a scheduledHour today. Legacy: schedule next
  // listed-day-after-today at the legacy auctionHour.
  const scheduled =
    lot.scheduledHour !== undefined && lot.scheduledHour !== null
      ? { day, hour: lot.scheduledHour }
      : null;
  void itemName;
  return (
    <article className="lot-card lot-card-onview">
      <div className="lot-line">
        <StockChip
          dump={dump}
          itemKindId={lot.itemKindId}
          qualityTier={lot.qualityTier}
          quantity={lot.quantity}
          observerActorId={null}
          onSelect={onSelect}
        />
        <span className="muted">floor £{lot.floorPrice}</span>
      </div>
      <div className="lot-bidline">
        <span className="lot-status muted">
          On view{lot.listedDay === day ? " (just listed)" : ""}
        </span>
        {scheduled !== null ? (
          <span className="muted">
            on the block: D{String(scheduled.day).padStart(2, "0")}{" "}
            {String(scheduled.hour).padStart(2, "0")}:00
          </span>
        ) : null}
      </div>
    </article>
  );
}

/** A frame in the auction play-out. Each frame represents one auctioneer
 *  ask + the response. On a `bid` frame, `bidder` is who took the ask
 *  and is now the leader at `price`. On `hammer` it's the winner; on
 *  `unsold` nobody bid the opening. */
interface BidFrame {
  readonly kind: "bid" | "hammer" | "unsold";
  /** Auctioneer's ask price for this round. */
  readonly price: number;
  /** Who took the ask this round (bid frame) or the winner (hammer). */
  readonly bidder: number | null;
  /** Who is currently winning AFTER this frame. */
  readonly leader: number | null;
  /** All bidders willing to bid at this ask. */
  readonly willing: readonly number[];
}

/**
 * Walk one auction lot as an ascending alternation. The highest-snap
 * bidder takes the opening; bidders then alternate, each one bidding
 * the next rung. When a non-leader can no longer match an ask, the
 * leader wins at their last bid. When only one bidder remains willing
 * after a competitive round, they take the new ask and win there.
 */
function buildBidFrames(
  bidders: readonly { actorId: number; ceiling: number }[],
  effectiveFloor: number,
  finalPrice: number | null,
  winnerId: number | null,
): readonly BidFrame[] {
  const openingAsk = rungAtOrBelow(effectiveFloor);
  // Build the queue with the same ordering the engine uses: ASC by
  // snapped ceiling, ties by raw ceiling ASC, then by actor id (a
  // stand-in for the engine's "originalIndex"). This ensures the
  // round-robin walk produces the same bid sequence and hammer winner.
  const queue = bidders
    .map((b, idx) => ({
      actorId: b.actorId,
      snap: rungAtOrBelow(b.ceiling),
      raw: b.ceiling,
      idx,
    }))
    .filter((b) => b.snap >= openingAsk)
    .sort(
      (a, b) =>
        a.snap - b.snap || a.raw - b.raw || a.idx - b.idx,
    );

  const frames: BidFrame[] = [];

  if (queue.length === 0) {
    frames.push({
      kind: "unsold",
      price: openingAsk,
      bidder: null,
      leader: null,
      willing: [],
    });
    return frames;
  }

  if (queue.length === 1) {
    // Single bidder takes the opening at the floor and that's it.
    const lone = queue[0]!.actorId;
    frames.push({
      kind: "bid",
      price: openingAsk,
      bidder: lone,
      leader: lone,
      willing: [lone],
    });
    frames.push({
      kind: "hammer",
      price: finalPrice ?? openingAsk,
      bidder: winnerId ?? lone,
      leader: winnerId ?? lone,
      willing: [lone],
    });
    return frames;
  }

  // Round-robin: at each ask, scan from queueIdx forward and pick the
  // first bidder who isn't currently the leader and whose snap covers
  // the ask. After a bid, queueIdx advances to the position right
  // after the bidder who just bid.
  let leaderActorId: number | null = null;
  let lastBid = openingAsk;
  let queueIdx = 0;
  let ask = openingAsk;

  for (let guard = 0; guard < 1000; guard += 1) {
    let pickedQueuePos = -1;
    for (let scan = 0; scan < queue.length; scan += 1) {
      const pos = (queueIdx + scan) % queue.length;
      const cand = queue[pos]!;
      if (
        (leaderActorId === null || cand.actorId !== leaderActorId) &&
        cand.snap >= ask
      ) {
        pickedQueuePos = pos;
        break;
      }
    }
    if (pickedQueuePos === -1) {
      // Nobody else can match — leader wins at last bid.
      const winner = winnerId ?? leaderActorId;
      frames.push({
        kind: "hammer",
        price: finalPrice ?? lastBid,
        bidder: winner,
        leader: winner,
        willing: winner !== null ? [winner] : [],
      });
      return frames;
    }
    const picked = queue[pickedQueuePos]!;
    // Compute current willing set (snap >= ask) for the bid frame's UI.
    const willing = queue.filter((q) => q.snap >= ask).map((q) => q.actorId);
    frames.push({
      kind: "bid",
      price: ask,
      bidder: picked.actorId,
      leader: picked.actorId,
      willing,
    });
    leaderActorId = picked.actorId;
    lastBid = ask;
    queueIdx = (pickedQueuePos + 1) % queue.length;
    ask = nextRungAbove(ask);
  }
  return frames;
}

const FRAME_INTERVAL_MS = 700;

function AuctionLotPlayer({
  event,
  lot,
  dump,
  day,
  onSelect,
  itemName,
}: {
  readonly event: RunEvent;
  readonly lot: SnapshotAuctionLot | null;
  readonly dump: RunDump;
  readonly day: number;
  readonly onSelect: (s: Selection) => void;
  readonly itemName: (id: number) => string;
}) {
  const bidders =
    (event.bidders as
      | readonly { actorId: number; ceiling: number; judgementId?: number }[]
      | undefined) ?? [];
  const attendees =
    (event.attendees as readonly number[] | undefined) ?? [];
  const effectiveFloor =
    (event.effectiveFloor as number | undefined) ?? lot?.floorPrice ?? 0;
  const cleared = event.type === "auction.cleared";
  const finalPrice = cleared
    ? ((event.totalPrice as number | undefined) ?? null)
    : null;
  const winnerId = cleared
    ? ((event.winnerActorId as number | undefined) ?? null)
    : null;
  const reason = String(event.reason ?? "");

  const frames = useMemo(
    () => buildBidFrames(bidders, effectiveFloor, finalPrice, winnerId),
    [bidders, effectiveFloor, finalPrice, winnerId],
  );

  // Judgement audit index — built once per dump load
  // (docs/judgement.md). Bidder rows look up by judgementId to pop
  // the per-arm Condition → Price → multipliers math behind each
  // ceiling. Empty index when the dump pre-dates the audit field.
  const judgementIdx = useMemo<JudgementIndex>(
    () => indexJudgements(dump),
    [dump],
  );

  const lotKey = (event.auctionLotId as number) ?? -1;

  // Reset and auto-step through frames whenever we land on a new lot.
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    setFrameIdx(0);
    setPlaying(true);
  }, [lotKey, day]);

  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    if (frameIdx >= frames.length - 1) return;
    timerRef.current = window.setTimeout(() => {
      setFrameIdx((i) => Math.min(i + 1, frames.length - 1));
    }, FRAME_INTERVAL_MS);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [frameIdx, playing, frames.length]);

  const frame = frames[Math.min(frameIdx, frames.length - 1)] ?? null;
  const willingSet = new Set(frame?.willing ?? []);
  const currentLeader = frame?.leader ?? null;
  const isFinal = frameIdx >= frames.length - 1;
  const cardClass = `lot-card ${cleared ? "lot-cleared" : "lot-unsold"} ${isFinal ? "lot-card-final" : "lot-card-live"}`;

  // Bidders are a subset of attendees. Show attendees who didn't bid as
  // greyed-out chips alongside the active bidders.
  const bidderIdSet = new Set(bidders.map((b) => b.actorId));
  const nonBidderAttendees = attendees.filter((id) => !bidderIdSet.has(id));
  const allBidders = bidders.slice().sort((a, b) => a.ceiling - b.ceiling);
  const ceilingByActor = new Map(bidders.map((b) => [b.actorId, b.ceiling]));
  const actorName = (id: number) => {
    const a = dump.actors.find((x) => x.id === id);
    return a !== undefined ? chipName(a) : `actor ${id}`;
  };

  // Auctioneer's call for the current frame.
  const call = describeCall(
    frame,
    frameIdx,
    frames,
    cleared,
    finalPrice,
    winnerId,
    actorName,
    reason,
  );

  // Bid log — only frames up to and including the current one. Walking
  // bid frames + a final hammer; "drops" are implicit (we don't say
  // 'X pulls out' — we just stop hearing from them).
  const log = frames.slice(0, frameIdx + 1).map((f) =>
    describeLogEntry(f, cleared, finalPrice, winnerId, dump, onSelect, reason),
  );

  const stepBack = () => {
    setPlaying(false);
    setFrameIdx((i) => Math.max(0, i - 1));
  };
  const stepFwd = () => {
    setPlaying(false);
    setFrameIdx((i) => Math.min(frames.length - 1, i + 1));
  };
  const togglePlay = () => {
    if (isFinal) {
      // pressing play after the hammer rewinds and replays
      setFrameIdx(0);
      setPlaying(true);
    } else {
      setPlaying((p) => !p);
    }
  };

  return (
    <article className={cardClass}>
      <div className="lot-line">
        {lot !== null ? (
          <StockChip
            dump={dump}
            itemKindId={lot.itemKindId}
            qualityTier={lot.qualityTier}
            quantity={lot.quantity}
            observerActorId={null}
            onSelect={onSelect}
          />
        ) : (
          <strong>lot {lotKey}</strong>
        )}
        <span className="muted">floor £{effectiveFloor}</span>
      </div>
      <div className="lot-bidline">
        <span className="lot-price">£{frame?.price ?? effectiveFloor}</span>
        {isFinal ? (
          winnerId !== null ? (
            <span className="lot-hammer">
              ★ HAMMER · <ActorChipById dump={dump} actorId={winnerId} onSelect={onSelect} size={16} /> for £{finalPrice}
            </span>
          ) : (
            <span className="lot-hammer lot-hammer-unsold">unsold ({reason || "no clear"})</span>
          )
        ) : currentLeader !== null ? (
          <span className="muted">
            <ActorChipById dump={dump} actorId={currentLeader} onSelect={onSelect} size={14} />{" "}
            <span>has the bid</span>
          </span>
        ) : (
          <span className="muted">
            {willingSet.size} bidder{willingSet.size === 1 ? "" : "s"} willing
          </span>
        )}
      </div>
      <blockquote className="lot-call">“{call}”</blockquote>
      {allBidders.length > 0 || nonBidderAttendees.length > 0 ? (
        <div className="lot-room">
          {allBidders.length > 0 ? (
            <>
              <span className="lot-room-label muted">Bidders:</span>
              <ul className="lot-bidders">
                {allBidders.map((b) => {
                  const stillIn = willingSet.has(b.actorId);
                  const isWinner = isFinal && b.actorId === winnerId;
                  const openingAsk = rungAtOrBelow(effectiveFloor);
                  const belowOpening = rungAtOrBelow(b.ceiling) < openingAsk;
                  // Judgement audit lookup. Bidder snapshots carry
                  // judgementId via AuctionBidderSnapshot; the
                  // composite payload reconstructs the per-arm chain.
                  const judgement =
                    b.judgementId !== undefined
                      ? getJudgementById(judgementIdx, b.judgementId)
                      : null;
                  const bidderActor = dump.actors.find((a) => a.id === b.actorId);
                  const bidderName =
                    bidderActor !== undefined ? fullName(bidderActor) : `actor#${b.actorId}`;
                  const ceilingTitle =
                    judgement !== null && isComposite(judgement) && lot !== null
                      ? formatCompositeMath({
                          observerName: bidderName,
                          itemName: itemName(judgement.payload.itemKindId),
                          payload: judgement.payload,
                        })
                      : undefined;
                  return (
                    <li
                      key={b.actorId}
                      className={`lot-bidder ${
                        isWinner
                          ? "lot-bidder-winner"
                          : stillIn
                            ? "lot-bidder-in"
                            : belowOpening
                              ? "lot-bidder-belowfloor"
                              : "lot-bidder-out"
                      }`}
                    >
                      <ActorChipById dump={dump} actorId={b.actorId} onSelect={onSelect} size={14} />
                      <span
                        className="muted"
                        {...(ceilingTitle !== undefined ? { title: ceilingTitle } : {})}
                      >
                        {belowOpening ? `below opening (£${b.ceiling})` : `ceiling £${b.ceiling}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
          {nonBidderAttendees.length > 0 ? (
            <>
              <span className="lot-room-label muted">In the room:</span>
              <ul className="lot-bidders lot-attendees">
                {nonBidderAttendees.map((id) => (
                  <li key={id} className="lot-bidder lot-bidder-watching">
                    <ActorChipById dump={dump} actorId={id} onSelect={onSelect} size={14} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      {frames.length > 1 ? (
        <div className="lot-controls muted">
          <button
            onClick={() => {
              setFrameIdx(0);
              setPlaying(true);
            }}
            title="restart and play"
          >
            ↺
          </button>
          <button onClick={stepBack} disabled={frameIdx === 0} title="back one step">
            ◀
          </button>
          <button onClick={togglePlay} title={playing ? "pause" : isFinal ? "replay" : "play"}>
            {playing ? "⏸" : "▶"}
          </button>
          <button onClick={stepFwd} disabled={isFinal} title="forward one step">
            ▶|
          </button>
          <button
            onClick={() => {
              setPlaying(false);
              setFrameIdx(frames.length - 1);
            }}
            disabled={isFinal}
            title="skip to end"
          >
            ⏭
          </button>
          <span>
            {frameIdx + 1}/{frames.length}
          </span>
        </div>
      ) : null}
      {log.length > 0 ? (
        <ol className="lot-log">
          {log.map((entry, i) => (
            <li key={i} className={i === log.length - 1 ? "lot-log-current" : ""}>
              <span className="lot-log-price">£{entry.price}</span>
              <span className="lot-log-text">{entry.text}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </article>
  );
}

interface LogEntry {
  readonly price: number;
  readonly text: JSX.Element;
}

function describeCall(
  frame: BidFrame | null,
  frameIdx: number,
  frames: readonly BidFrame[],
  cleared: boolean,
  finalPrice: number | null,
  winnerId: number | null,
  actorName: (id: number) => string,
  unsoldReason: string,
): string {
  if (frame === null) return "";
  if (frame.kind === "unsold") {
    return `No bidders at £${frame.price}. Lot withdrawn (${unsoldReason || "unsold"}).`;
  }
  if (frame.kind === "hammer") {
    if (cleared && winnerId !== null && finalPrice !== null) {
      return `Going once… going twice… SOLD to ${actorName(winnerId)} for £${finalPrice}!`;
    }
    return `No takers. Lot withdrawn (${unsoldReason || "unsold"}).`;
  }
  // bid frame — someone took the auctioneer's ask. The auctioneer
  // always tries one more rung before the hammer falls; "silence"
  // happens off-screen between this frame and the hammer.
  const bidderName = frame.bidder !== null ? actorName(frame.bidder) : "—";
  const nextRung = nextRungAbove(frame.price);
  if (frameIdx === 0) {
    return `Lot opens at £${frame.price} — ${bidderName} takes it. Do I hear £${nextRung}?`;
  }
  return `£${frame.price} from ${bidderName}. Do I hear £${nextRung}?`;
}

function describeLogEntry(
  frame: BidFrame,
  cleared: boolean,
  finalPrice: number | null,
  winnerId: number | null,
  dump: RunDump,
  onSelect: (s: Selection) => void,
  unsoldReason: string,
): LogEntry {
  if (frame.kind === "unsold") {
    return {
      price: frame.price,
      text: <span>unsold ({unsoldReason || "no clear"})</span>,
    };
  }
  if (frame.kind === "hammer") {
    if (cleared && winnerId !== null && finalPrice !== null) {
      return {
        price: finalPrice,
        text: (
          <span>
            ★ HAMMER —{" "}
            <ActorChipById
              dump={dump}
              actorId={winnerId}
              onSelect={onSelect}
              size={14}
            />{" "}
            wins
          </span>
        ),
      };
    }
    return {
      price: frame.price,
      text: <span>unsold ({unsoldReason || "no clear"})</span>,
    };
  }
  // bid frame
  return {
    price: frame.price,
    text:
      frame.bidder !== null ? (
        <span>
          <ActorChipById
            dump={dump}
            actorId={frame.bidder}
            onSelect={onSelect}
            size={14}
          />{" "}
          bids
        </span>
      ) : (
        <span className="muted">— bids</span>
      ),
  };
}

interface NegotiationTurn {
  readonly by: "seller" | "buyer";
  readonly action: "open" | "counter" | "accept" | "walk";
  readonly unitPrice: number | null;
}

function PubdealAgreedScene(props: {
  readonly event: RunEvent;
  readonly dump: RunDump;
  readonly snapshot: DaySnapshot | null;
  readonly hourEvents: readonly RunEvent[];
  readonly onSelect: (s: Selection) => void;
}) {
  return <PubdealHagglePlayer kind="agreed" {...props} />;
}

function PubdealWalkedScene(props: {
  readonly event: RunEvent;
  readonly dump: RunDump;
  readonly hourEvents: readonly RunEvent[];
  readonly onSelect: (s: Selection) => void;
}) {
  return <PubdealHagglePlayer kind="walked" {...props} snapshot={null} />;
}

function PubdealHagglePlayer({
  event,
  dump,
  snapshot,
  hourEvents,
  onSelect,
  kind,
}: {
  readonly event: RunEvent;
  readonly dump: RunDump;
  readonly snapshot: DaySnapshot | null;
  readonly hourEvents: readonly RunEvent[];
  readonly onSelect: (s: Selection) => void;
  readonly kind: "agreed" | "walked";
}) {
  const sellerId = event.sellerActorId as number;
  const buyerId = event.buyerActorId as number;
  const turns = (event.turns as readonly NegotiationTurn[] | undefined) ?? [];
  // Belief snapshots attached to the agreement event — per-unit
  // ranges representing what each side thought the item was worth
  // when they sat down. Optional (older dumps don't carry them).
  const sellerBelief = event.sellerBelief as
    | { low: number; high: number }
    | undefined;
  const buyerBelief = event.buyerBelief as
    | { low: number; high: number }
    | undefined;
  const truePricePerUnit = event.truePricePerUnit as number | undefined;
  const buyerJudgementId = event.buyerJudgementId as number | undefined;

  // Judgement audit lookup for the buyer-belief band hover. Memo'd on
  // dump so the index is shared across pubdeal scenes within the hour.
  const judgementIdx = useMemo<JudgementIndex>(
    () => indexJudgements(dump),
    [dump],
  );
  const buyerJudgement =
    buyerJudgementId !== undefined
      ? getJudgementById(judgementIdx, buyerJudgementId)
      : null;
  const buyerActor = dump.actors.find((a) => a.id === buyerId);
  const buyerJudgementHover =
    buyerJudgement !== null && isComposite(buyerJudgement) && buyerActor !== undefined
      ? formatCompositeMath({
          observerName: fullName(buyerActor),
          itemName:
            dump.items.find((i) => i.id === buyerJudgement.payload.itemKindId)
              ?.displayName ?? `item ${buyerJudgement.payload.itemKindId}`,
          payload: buyerJudgement.payload,
        })
      : "what the buyer thought a unit was worth";

  const attempted = hourEvents.find(
    (e) =>
      e.type === "pubdeal.attempted" &&
      e.sellerActorId === sellerId &&
      e.buyerActorId === buyerId,
  );
  const locId = attempted?.locationId as number | undefined;
  const itemId = attempted?.itemKindId as number | undefined;
  const tier = attempted?.qualityTier as string | undefined;
  const qty = attempted?.quantity as number | undefined;

  const dealId = kind === "agreed" ? (event.dealId as number) : null;
  const unitPrice = kind === "agreed" ? (event.unitPrice as number) : null;
  const reason = kind === "walked" ? String(event.reason ?? "") : "";
  const deal: SnapshotDeal | undefined =
    dealId !== null ? snapshot?.deals.find((d) => d.id === dealId) : undefined;

  const itemName = (id: number) =>
    dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`;

  // Frame index 0..turns.length. The final frame (index === turns.length)
  // is the "deal struck" / "walked" stamp.
  const frameKey = `${event.at.day}-${event.at.hour}-${sellerId}-${buyerId}-${dealId ?? "w"}`;
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    setFrameIdx(0);
    setPlaying(true);
  }, [frameKey]);

  const total = turns.length + 1; // +1 for the closing stamp frame
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!playing) return;
    if (frameIdx >= total - 1) return;
    timerRef.current = window.setTimeout(() => {
      setFrameIdx((i) => Math.min(i + 1, total - 1));
    }, FRAME_INTERVAL_MS);
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [frameIdx, playing, total]);

  const isFinal = frameIdx >= total - 1;
  const currentTurn: NegotiationTurn | null =
    !isFinal && turns[frameIdx] !== undefined ? turns[frameIdx]! : null;

  // Each party's most recent offer up to (and including) the current
  // frame. Used by the parties/room panel so the user can see how each
  // side is moving — analogous to the auction's bidder roster.
  const lastOffers = useMemo(() => {
    let lastSeller: number | null = null;
    let lastBuyer: number | null = null;
    const upTo = Math.min(frameIdx, turns.length - 1);
    for (let i = 0; i <= upTo; i += 1) {
      const t = turns[i];
      if (t === undefined) break;
      if (t.unitPrice === null) continue;
      if (t.by === "seller") lastSeller = t.unitPrice;
      else lastBuyer = t.unitPrice;
    }
    return { seller: lastSeller, buyer: lastBuyer };
  }, [turns, frameIdx]);

  const stepBack = () => {
    setPlaying(false);
    setFrameIdx((i) => Math.max(0, i - 1));
  };
  const stepFwd = () => {
    setPlaying(false);
    setFrameIdx((i) => Math.min(total - 1, i + 1));
  };
  const togglePlay = () => {
    if (isFinal) {
      setFrameIdx(0);
      setPlaying(true);
    } else {
      setPlaying((p) => !p);
    }
  };

  // State class on the card mirrors the auction lot's chrome:
  //   live → accent border; agreed final → accent-2 (cleared);
  //   walked final → muted (unsold).
  const cardClass = isFinal
    ? `lot-card lot-card-final ${kind === "agreed" ? "lot-cleared" : "lot-unsold"}`
    : "lot-card lot-card-live";

  const currentSpeakerId =
    currentTurn !== null
      ? currentTurn.by === "seller"
        ? sellerId
        : buyerId
      : null;

  return (
    <section className={`scene scene-pubdeal ${kind === "walked" ? "scene-walked" : ""}`}>
      <header className="scene-header">
        <span className={`scene-tag ${kind === "walked" ? "scene-tag-walk" : "scene-tag-deal"}`}>
          {isFinal
            ? kind === "agreed"
              ? "Pub deal struck"
              : "Couldn't agree"
            : "Haggling…"}
        </span>
        {locId !== undefined ? (
          <LocationLink dump={dump} locationId={locId} onSelect={onSelect} />
        ) : null}
      </header>

      <article className={cardClass}>
        <div className="lot-line">
          <ActorChipById dump={dump} actorId={sellerId} onSelect={onSelect} size={20} />
          <span className="muted">{kind === "walked" && isFinal ? "↮" : "↔"}</span>
          <ActorChipById dump={dump} actorId={buyerId} onSelect={onSelect} size={20} />
          {itemId !== undefined ? (
            <>
              <span className="muted">·</span>
              <StockChip
                dump={dump}
                itemKindId={itemId}
                qualityTier={tier ?? null}
                quantity={qty ?? null}
                observerActorId={null}
                onSelect={onSelect}
              />
            </>
          ) : null}
        </div>

        {/* Big price line: current offer if mid-haggle, agreed price on final. */}
        <div className="lot-bidline">
          {currentTurn !== null && currentTurn.unitPrice !== null ? (
            <>
              <span className="lot-price">£{currentTurn.unitPrice}</span>
              <span className="muted">
                from{" "}
                <ActorChipById
                  dump={dump}
                  actorId={currentTurn.by === "seller" ? sellerId : buyerId}
                  onSelect={onSelect}
                  size={14}
                />
              </span>
            </>
          ) : isFinal && kind === "agreed" && unitPrice !== null ? (
            <>
              <span className="lot-price">£{unitPrice}</span>
              <span className="lot-hammer">
                ★ DEAL ·{" "}
                <ActorChipById
                  dump={dump}
                  actorId={buyerId}
                  onSelect={onSelect}
                  size={14}
                />{" "}
                @ £{unitPrice}
                {deal !== undefined ? ` · total £${deal.totalPrice}` : ""}
              </span>
            </>
          ) : (
            <span className="lot-hammer lot-hammer-unsold">
              walked ({reason || "no overlap"})
            </span>
          )}
        </div>

        {/* Dialogue for the current turn — script-like, with chips. */}
        <blockquote className="lot-call">
          {renderHaggleQuote(
            currentTurn,
            isFinal,
            kind,
            sellerId,
            buyerId,
            unitPrice,
            qty,
            itemId !== undefined && itemName(itemId).length > 0
              ? itemName(itemId)
              : null,
            dump,
            onSelect,
            frameIdx,
          )}
        </blockquote>

        {/* Parties / room panel — mirrors the auction's lot-room. Each
            side's last offer is shown beside its chip so the reader can
            see the gap closing (or not). The chip whose side just spoke
            gets the "in" highlight. */}
        <div className="lot-room">
          <span className="lot-room-label muted">Seller:</span>
          <ul className="lot-bidders">
            <li
              className={`lot-bidder ${
                isFinal && kind === "agreed"
                  ? "lot-bidder-winner"
                  : currentSpeakerId === sellerId
                    ? "lot-bidder-in"
                    : ""
              }`}
            >
              <ActorChipById
                dump={dump}
                actorId={sellerId}
                onSelect={onSelect}
                size={14}
              />
              {sellerBelief !== undefined ? (
                <span
                  className="belief-band"
                  title="what the seller thought a unit was worth"
                >
                  £{sellerBelief.low}–£{sellerBelief.high}
                </span>
              ) : null}
              <span className="muted">
                {lastOffers.seller !== null
                  ? `last £${lastOffers.seller}`
                  : "—"}
              </span>
            </li>
          </ul>
          <span className="lot-room-label muted">Buyer:</span>
          <ul className="lot-bidders">
            <li
              className={`lot-bidder ${
                isFinal && kind === "agreed"
                  ? "lot-bidder-winner"
                  : currentSpeakerId === buyerId
                    ? "lot-bidder-in"
                    : ""
              }`}
            >
              <ActorChipById
                dump={dump}
                actorId={buyerId}
                onSelect={onSelect}
                size={14}
              />
              {buyerBelief !== undefined ? (
                <span
                  className="belief-band"
                  title={buyerJudgementHover}
                >
                  £{buyerBelief.low}–£{buyerBelief.high}
                </span>
              ) : null}
              <span className="muted">
                {lastOffers.buyer !== null
                  ? `last £${lastOffers.buyer}`
                  : "—"}
              </span>
            </li>
          </ul>
          {truePricePerUnit !== undefined && isFinal ? (
            <div className="lot-room-truth muted">
              True RRP £{truePricePerUnit}/unit
              {unitPrice !== null ? (
                <>
                  {" · agreed "}
                  <span className={truePricePerUnit > unitPrice ? "warn" : ""}>
                    {fmtDelta(unitPrice - truePricePerUnit)}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Controls */}
        {turns.length > 0 ? (
          <div className="lot-controls muted">
            <button
              onClick={() => {
                setFrameIdx(0);
                setPlaying(true);
              }}
              title="restart and play"
            >
              ↺
            </button>
            <button onClick={stepBack} disabled={frameIdx === 0} title="back one step">
              ◀
            </button>
            <button onClick={togglePlay} title={playing ? "pause" : isFinal ? "replay" : "play"}>
              {playing ? "⏸" : "▶"}
            </button>
            <button onClick={stepFwd} disabled={isFinal} title="forward one step">
              ▶|
            </button>
            <button
              onClick={() => {
                setPlaying(false);
                setFrameIdx(total - 1);
              }}
              disabled={isFinal}
              title="skip to end"
            >
              ⏭
            </button>
            <span>
              {frameIdx + 1}/{total}
            </span>
          </div>
        ) : null}

        {/* Turn log */}
        {turns.length > 0 ? (
          <ol className="lot-log">
            {turns.slice(0, frameIdx + 1).map((t, i) => {
              const speakerId = t.by === "seller" ? sellerId : buyerId;
              const verb =
                t.action === "open"
                  ? "opens"
                  : t.action === "counter"
                    ? "counters"
                    : t.action === "accept"
                      ? "accepts"
                      : "walks";
              return (
                <li
                  key={i}
                  className={
                    i === Math.min(frameIdx, turns.length - 1)
                      ? "lot-log-current"
                      : ""
                  }
                >
                  <span className="lot-log-price">
                    {t.unitPrice !== null ? `£${t.unitPrice}` : "—"}
                  </span>
                  <span className="lot-log-text">
                    <ActorChipById
                      dump={dump}
                      actorId={speakerId}
                      onSelect={onSelect}
                      size={14}
                    />{" "}
                    {verb}
                    {t.action === "walk" ? "" : "."}
                  </span>
                </li>
              );
            })}
            {isFinal ? (
              <li className="lot-log-current">
                <span className="lot-log-price">
                  {kind === "agreed" && unitPrice !== null ? `£${unitPrice}` : "—"}
                </span>
                <span className="lot-log-text">
                  {kind === "agreed" ? (
                    <>
                      ★ DEAL —{" "}
                      <ActorChipById
                        dump={dump}
                        actorId={sellerId}
                        onSelect={onSelect}
                        size={14}
                      />
                      <span className="ref-arrow">→</span>
                      <ActorChipById
                        dump={dump}
                        actorId={buyerId}
                        onSelect={onSelect}
                        size={14}
                      />
                    </>
                  ) : (
                    `walked — ${reason || "no overlap"}`
                  )}
                </span>
              </li>
            ) : null}
          </ol>
        ) : null}
      </article>

      {/* Deal details once agreed — sits outside the card, like an
          auction footer. */}
      {isFinal && kind === "agreed" && deal !== undefined ? (
        <div className="scene-row muted">
          deal {dealId} · deadline D{deal.deadlineDay}
          {deal.deliveryLocationId !== null ? (
            <>
              {" "}· drop @{" "}
              <LocationLink dump={dump} locationId={deal.deliveryLocationId} onSelect={onSelect} />
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function renderHaggleQuote(
  turn: NegotiationTurn | null,
  isFinal: boolean,
  kind: "agreed" | "walked",
  sellerId: number,
  buyerId: number,
  finalPrice: number | null,
  qty: number | undefined,
  itemLabel: string | null,
  dump: RunDump,
  onSelect: (s: Selection) => void,
  frameIdx: number,
): JSX.Element {
  const seller = (
    <ActorChipById dump={dump} actorId={sellerId} onSelect={onSelect} size={14} />
  );
  const buyer = (
    <ActorChipById dump={dump} actorId={buyerId} onSelect={onSelect} size={14} />
  );
  if (turn === null) {
    if (kind === "agreed" && finalPrice !== null) {
      return (
        <span>
          {seller} and {buyer} shake on it — £{finalPrice} each.
        </span>
      );
    }
    return <span>No deal — neither would budge.</span>;
  }
  const speakerChip = turn.by === "seller" ? seller : buyer;
  const price = turn.unitPrice;
  // A small library of phrasings, picked deterministically from the
  // frame index so each turn reads slightly differently.
  const variant = frameIdx % 3;
  switch (turn.action) {
    case "open":
      if (turn.by === "buyer") {
        const opening = price !== null
          ? variant === 0
            ? `: "How much? I'd give you £${price} each${qty !== undefined && itemLabel ? ` for ${qty} ${itemLabel}` : ""}."`
            : variant === 1
              ? `: "Talk to me. £${price} a piece?"`
              : `: "I'll go £${price}${qty !== undefined ? ` for ${qty}` : ""}."`
          : `: "How much you after?"`;
        return <span>{speakerChip}{opening}</span>;
      }
      return (
        <span>
          {speakerChip}
          {price !== null
            ? `: "For you, £${price} each${qty !== undefined && itemLabel ? ` — ${qty} ${itemLabel}` : ""}."`
            : `: "Make me an offer."`}
        </span>
      );
    case "counter":
      return (
        <span>
          {speakerChip}
          {price !== null
            ? variant === 0
              ? `: "£${price}."`
              : variant === 1
                ? `: "Make it £${price}."`
                : `: "I can do £${price}."`
            : `: "Pass."`}
        </span>
      );
    case "accept":
      return (
        <span>
          {speakerChip}
          {price !== null
            ? variant === 0
              ? `: "£${price}? Done."`
              : variant === 1
                ? `: "Alright, £${price}. Sold."`
                : `: "£${price} it is."`
            : `: "Done."`}
        </span>
      );
    case "walk":
      return (
        <span>
          {speakerChip} walks away.
        </span>
      );
  }
}

interface RawExchange {
  readonly fromActorId: number;
  readonly toActorId: number;
  readonly lead: {
    readonly kind: "commodity" | "rep";
    readonly side: "supply" | "demand";
    readonly subjectItemKindId: number | null;
    readonly subjectTargetActorId: number | null;
    readonly counterpartyActorId: number | null;
  };
}

interface GossipGroup {
  readonly a: number;
  readonly b: number;
  readonly loc: number;
  exchanges: RawExchange[];
}

/** Subject the gossip line is about — commodity supply/demand uses the
 *  named counterparty (falling back to the speaker for first-hand "I
 *  have/want X" leads); rep leads use the target. May be null when the
 *  payload is incomplete. */
function subjectActorIdOf(x: RawExchange): number | null {
  const lead = x.lead;
  if (lead.kind === "commodity") {
    return lead.counterpartyActorId ?? x.fromActorId;
  }
  return lead.subjectTargetActorId;
}

function GossipScene({
  events,
  dump,
  onSelect,
  povActorId,
  focusActorIds,
}: {
  readonly events: readonly RunEvent[];
  readonly dump: RunDump;
  readonly onSelect: (s: Selection) => void;
  readonly povActorId: number | null;
  readonly focusActorIds: ReadonlySet<number>;
}) {
  void onSelect;
  const set = useSelectionSet();
  // Chips inside the gossip scene toggle membership in the selection
  // set rather than replace it. Letting them route through the parent
  // `onSelect` would wipe the user's current filter (e.g. selecting
  // Del + Nag's then clicking a gossip line would drop both).
  const toggle = (s: Selection): void => set.toggle(s);

  // Group by (unordered pair, location). The engine emits multiple
  // gossip.exchanged events per encounter (chat + clarification +
  // proprietor + deal — see core/events.ts), and their exchanges
  // overlap. We:
  //   1. Drop any exchange where the subject is the LISTENER — you
  //      don't tell someone news about themselves; they already know.
  //   2. Drop exchanges that don't match the current POV / selection
  //      focus: in player mode, keep only what the player *received*
  //      (toActorId === povActorId); in admin + selected-actors,
  //      keep exchanges where either side of the line is one of the
  //      selected actors. Without these filters a Boyce/Trigger
  //      exchange survives in "Mickey selected" because the parent
  //      event-level filter already lets sibling exchanges through.
  //   3. Dedupe by (speaker, kind, side, subject) so the same lead
  //      doesn't print twice when chat + clarification both fired.
  const groups = useMemo<readonly GossipGroup[]>(() => {
    const map = new Map<string, GossipGroup>();
    for (const e of events) {
      const participants =
        (e.participantActorIds as readonly number[] | undefined) ?? [];
      const a = participants[0];
      const b = participants[1];
      if (a === undefined || b === undefined) continue;
      const loc = e.atLocationId as number;
      const key = `${Math.min(a, b)}-${Math.max(a, b)}-${loc}`;
      const entry: GossipGroup =
        map.get(key) ?? { a, b, loc, exchanges: [] };
      const xs = (e.exchanges as readonly RawExchange[] | undefined) ?? [];
      for (const x of xs) {
        const subj = subjectActorIdOf(x);
        if (subj !== null && subj === x.toActorId) continue;
        if (povActorId !== null) {
          if (x.toActorId !== povActorId) continue;
        } else if (focusActorIds.size > 0) {
          if (
            !focusActorIds.has(x.fromActorId) &&
            !focusActorIds.has(x.toActorId)
          ) {
            continue;
          }
        }
        entry.exchanges.push(x);
      }
      map.set(key, entry);
    }
    for (const g of map.values()) {
      const seen = new Set<string>();
      g.exchanges = g.exchanges.filter((x) => {
        const lead = x.lead;
        const subjectKey =
          lead.subjectItemKindId !== null
            ? `i${lead.subjectItemKindId}`
            : lead.subjectTargetActorId !== null
              ? `a${lead.subjectTargetActorId}`
              : "u";
        const k = `${x.fromActorId}|${lead.kind}|${lead.side}|${subjectKey}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return [...map.values()].filter((g) => g.exchanges.length > 0);
  }, [events]);

  const totalLines = groups.reduce((s, g) => s + g.exchanges.length, 0);

  return (
    <section className="scene scene-gossip">
      <header className="scene-header">
        <span className="scene-tag scene-tag-gossip">Gossip</span>
        <span className="muted">
          {groups.length} encounter{groups.length === 1 ? "" : "s"}
          {" · "}
          {totalLines} line{totalLines === 1 ? "" : "s"}
        </span>
      </header>
      <ul className="scene-gossip-list">
        {groups.map((g, i) => (
          <li key={i} className="scene-gossip-row">
            <div className="scene-parties">
              <ActorChipById dump={dump} actorId={g.a} onSelect={toggle} size={16} />
              <span className="ref-arrow">↔</span>
              <ActorChipById dump={dump} actorId={g.b} onSelect={toggle} size={16} />
              <span className="muted">at</span>
              <LocationLink dump={dump} locationId={g.loc} onSelect={toggle} />
            </div>
            <ul className="scene-lines">
              {g.exchanges.map((x, j) => (
                <GossipExchangeLine
                  key={j}
                  dump={dump}
                  exchange={x}
                  toggle={toggle}
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One row inside a gossip exchange:
 *    `(speaker): (subject) verb (stock name only)`  — commodity
 *    `(speaker): (target) — bad rep`                — rep
 *  Two-tier gossip headline (docs/ui.md + memory:project_gossip_two_tier):
 *  qty / unit price are hidden until the receiver unlocks. Counterparty
 *  is shown because the speaker named them out loud — the receiver's
 *  stored lead row redacts it, but the verbal moment doesn't. */
function GossipExchangeLine({
  dump,
  exchange,
  toggle,
}: {
  readonly dump: RunDump;
  readonly exchange: RawExchange;
  readonly toggle: (s: Selection) => void;
}) {
  const { fromActorId, lead } = exchange;
  const isCommodity = lead.kind === "commodity" && lead.subjectItemKindId !== null;
  const subjectActorId = subjectActorIdOf(exchange);
  const verb = isCommodity ? (lead.side === "supply" ? "has" : "wants") : "— bad rep";
  return (
    <li className="scene-gossip-headline">
      <ActorChipById dump={dump} actorId={fromActorId} onSelect={toggle} size={14} />
      <span className="muted">:</span>
      {subjectActorId !== null ? (
        <ActorChipById dump={dump} actorId={subjectActorId} onSelect={toggle} size={14} />
      ) : (
        <span className="muted">someone</span>
      )}
      <span className="muted">{verb}</span>
      {isCommodity ? (
        <StockChip
          dump={dump}
          itemKindId={lead.subjectItemKindId as number}
          qualityTier={null}
          quantity={null}
          observerActorId={null}
          onSelect={toggle}
        />
      ) : null}
    </li>
  );
}

/**
 * Detail-unlock scene — receiver paid £3 + 1h in-venue to flip the
 * value-bearing fields (counterparty + qty + unit price) on locked
 * headlines they already hold. One row per attempted unlock, with
 * the full lead snapshot pulled from the prior `gossip.exchanged`
 * via the dump-wide lead index. Failed flips (already-unlocked /
 * no-longer-held leads) still render so the diary shows the £3
 * spent.
 */
function DetailUnlockedScene({
  events,
  dump,
  onSelect,
}: {
  readonly events: readonly RunEvent[];
  readonly dump: RunDump;
  readonly onSelect: (s: Selection) => void;
}) {
  const leadIndex = useMemo(() => indexExchangeLeads(dump), [dump]);
  return (
    <section className="scene scene-unlock">
      <header className="scene-header">
        <span className="scene-tag scene-tag-unlock">🔓 Detail unlock</span>
        <span className="muted">
          {events.length} session{events.length === 1 ? "" : "s"}
        </span>
      </header>
      <ul className="scene-gossip-list">
        {events.map((e, i) => {
          const asker = e.askerActorId as number;
          const partner = e.partnerActorId as number;
          const loc = e.atLocationId as number;
          const costPaid = Number(e.costPaid ?? 0);
          const paidTo = e.paidToActorId as number | null;
          const unlockedLeads =
            (e.unlockedLeads as
              | readonly { leadId: number; unlocked: boolean }[]
              | undefined) ?? [];
          return (
            <li key={i} className="scene-gossip-row">
              <div className="scene-parties">
                <ActorChipById dump={dump} actorId={asker} onSelect={onSelect} size={16} />
                <span className="muted">paid £{costPaid} to</span>
                {paidTo !== null ? (
                  <ActorChipById
                    dump={dump}
                    actorId={paidTo}
                    onSelect={onSelect}
                    size={16}
                  />
                ) : (
                  <span className="muted">the house</span>
                )}
                <span className="muted">via</span>
                <ActorChipById
                  dump={dump}
                  actorId={partner}
                  onSelect={onSelect}
                  size={16}
                />
                <span className="muted">at</span>
                <LocationLink dump={dump} locationId={loc} onSelect={onSelect} />
              </div>
              {unlockedLeads.length > 0 ? (
                <ul className="scene-lines">
                  {unlockedLeads.map((u, j) => {
                    const lead = leadIndex.get(u.leadId) ?? null;
                    if (lead === null) {
                      return (
                        <li key={j} className="chip-stack">
                          <span className="muted">
                            lead #{u.leadId}
                            {u.unlocked ? "" : " (already unlocked)"}
                          </span>
                        </li>
                      );
                    }
                    const verb = lead.side === "supply" ? "has" : "wants";
                    const isCommodity =
                      lead.kind === "commodity" &&
                      lead.subjectItemKindId !== null;
                    return (
                      <li key={j} className="chip-stack">
                        <div className="chip-stack-row">
                          {lead.counterpartyActorId !== null ? (
                            <ActorChipById
                              dump={dump}
                              actorId={lead.counterpartyActorId}
                              onSelect={onSelect}
                              size={14}
                            />
                          ) : (
                            <span className="muted">someone</span>
                          )}
                          <span className="muted">{verb}</span>
                          {isCommodity ? (
                            <StockChip
                              dump={dump}
                              itemKindId={lead.subjectItemKindId as number}
                              qualityTier={lead.subjectQualityTier ?? null}
                              quantity={lead.estimatedQuantity}
                              observerActorId={null}
                              unitPriceOverride={lead.estimatedUnitPrice}
                              onSelect={onSelect}
                            />
                          ) : (
                            <span className="muted">[rep lead]</span>
                          )}
                          {!u.unlocked ? (
                            <span className="muted">· no change</span>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RaidScene({
  event,
  dump,
  onSelect,
}: {
  readonly event: RunEvent;
  readonly dump: RunDump;
  readonly onSelect: (s: Selection) => void;
}) {
  const actorId = event.actorId as number;
  const seized = event.unitsSeized as number;
  const fine = event.fine as number;
  const codes = (event.seizedItemCodes as readonly string[] | undefined) ?? [];
  return (
    <section className="scene scene-raid">
      <header className="scene-header">
        <span className="scene-tag scene-tag-raid">🚨 Raid</span>
      </header>
      <div className="scene-parties">
        <ActorChipById dump={dump} actorId={actorId} onSelect={onSelect} size={20} />
      </div>
      <div className="scene-row">
        {seized} units seized · £{fine} fine
      </div>
      {codes.length > 0 ? (
        <div className="scene-row muted">{codes.join(", ")}</div>
      ) : null}
    </section>
  );
}

/**
 * Inspection scene — per-hour list of `auction.lot-inspected` pairs.
 * Renders inspector → lot rows showing the lot's item, tier, and
 * floor price so the player can see *what* the actor poked at, not
 * just the lot id. Replaces the legacy "· inspected" suffix on the
 * Knows-tab Auction-lots row (inspection is a time-anchored event,
 * not a persistent knowledge attribute).
 */
function InspectionScene({
  events,
  snapshot,
  dump,
  onSelect,
}: {
  readonly events: readonly RunEvent[];
  readonly snapshot: DaySnapshot | null;
  readonly dump: RunDump;
  readonly onSelect: (s: Selection) => void;
}) {
  const lotById = useMemo<ReadonlyMap<number, SnapshotAuctionLot>>(() => {
    const out = new Map<number, SnapshotAuctionLot>();
    // Prefer the current snapshot (matches what the player sees in
    // the lot panel today), then fall back to any earlier snapshot.
    if (snapshot !== null) {
      for (const l of snapshot.auctionLots) out.set(l.id, l);
    }
    for (const snap of dump.snapshots) {
      for (const l of snap.auctionLots) {
        if (!out.has(l.id)) out.set(l.id, l);
      }
    }
    return out;
  }, [snapshot, dump.snapshots]);

  return (
    <section className="scene scene-inspection">
      <header className="scene-header">
        <span className="scene-tag scene-tag-inspection">Inspections</span>
        <span className="muted">
          · {events.length} event{events.length === 1 ? "" : "s"}
        </span>
      </header>
      <ul className="inspection-events">
        {events.map((e, i) => {
          const actorId = e.actorId as number;
          const lotId = e.auctionLotId as number;
          const lot = lotById.get(lotId) ?? null;
          return (
            <li key={i} className="chip-stack">
              <div className="chip-stack-row">
                <span className="muted">🔨</span>
                <ActorChipById
                  dump={dump}
                  actorId={actorId}
                  onSelect={onSelect}
                  size={14}
                />
                <span className="muted">inspected</span>
                <LotRef dump={dump} id={lotId} onSelect={onSelect} variant="chip" />
                {lot !== null ? (
                  <span className="muted">floor £{lot.floorPrice}</span>
                ) : null}
              </div>
              {lot !== null ? (
                <>
                  <div className="chip-stack-row">
                    <span className="chip-stack-label muted">RRP</span>
                    <StockChip
                      dump={dump}
                      itemKindId={lot.itemKindId}
                      qualityTier={lot.qualityTier}
                      quantity={lot.quantity}
                      observerActorId={null}
                      onSelect={onSelect}
                    />
                  </div>
                  <div className="chip-stack-row">
                    <ActorChipById
                      dump={dump}
                      actorId={actorId}
                      onSelect={onSelect}
                      size={14}
                    />
                    <span className="muted">POV:</span>
                    <StockChip
                      dump={dump}
                      itemKindId={lot.itemKindId}
                      qualityTier={lot.qualityTier}
                      quantity={lot.quantity}
                      observerActorId={actorId}
                      onSelect={onSelect}
                    />
                  </div>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ClearanceScene({
  events,
  dump,
  onSelect,
}: {
  readonly events: readonly RunEvent[];
  readonly dump: RunDump;
  readonly onSelect: (s: Selection) => void;
}) {
  const itemName = (id: number) =>
    dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`;
  return (
    <section className="scene scene-clearance">
      <header className="scene-header">
        <span className="scene-tag scene-tag-clearance">House clearance</span>
        <span className="muted">· {events.length} event{events.length === 1 ? "" : "s"}</span>
      </header>
      <ul className="clearance-events">
        {events.map((e, i) => {
          if (e.type === "clearance.listed") {
            const lots = (e.lots as readonly {
              itemKindId: number;
              qualityTier: string;
              quantity: number;
            }[]) ?? [];
            const totalUnits = lots.reduce((s, l) => s + l.quantity, 0);
            return (
              <li key={i} className="clearance-row clearance-listed">
                <span className="muted">📰</span>
                <strong>Listed</strong>{" "}
                <span>{(e.flavour as string | null) ?? "Clearance"}</span>
                <span className="muted">
                  · fee £{Number(e.fee)} · {lots.length} lot
                  {lots.length === 1 ? "" : "s"} ({totalUnits} units)
                </span>
              </li>
            );
          }
          if (e.type === "clearance.booked") {
            const bookerId = e.bookerActorId as number;
            const locId = e.atLocationId as number | null;
            return (
              <li key={i} className="clearance-row clearance-booked">
                <span className="muted">☎</span>
                <ActorChipById
                  dump={dump}
                  actorId={bookerId}
                  onSelect={onSelect}
                  size={14}
                />
                <strong>booked</strong>{" "}
                <span className="muted">
                  listing #{Number(e.listingId)} for {Number(e.scheduledHour)}:00
                </span>
                {locId !== null ? (
                  <>
                    <span className="muted">· from </span>
                    <LocationLink dump={dump} locationId={locId} onSelect={onSelect} />
                  </>
                ) : null}
              </li>
            );
          }
          if (e.type === "clearance.resolved") {
            const winnerId = e.winnerActorId as number | null;
            const delivered = (e.lotsDelivered as readonly {
              itemKindId: number;
              quantity: number;
            }[]) ?? [];
            const losers = (e.loserActorIds as readonly number[]) ?? [];
            return (
              <li key={i} className="clearance-row clearance-resolved">
                <span>★</span>
                {winnerId !== null ? (
                  <>
                    <ActorChipById
                      dump={dump}
                      actorId={winnerId}
                      onSelect={onSelect}
                      size={14}
                    />
                    <strong>cleared</strong>{" "}
                    <span className="muted">
                      listing #{Number(e.listingId)} · paid £{Number(e.feeCharged)}
                      {" · "}
                      took {delivered.reduce((s, l) => s + l.quantity, 0)} units
                      {delivered.length > 0
                        ? ` (${delivered.map((l) => itemName(l.itemKindId)).join(", ")})`
                        : ""}
                    </span>
                    {losers.length > 0 ? (
                      <span className="warn">
                        · {losers.length} loser{losers.length === 1 ? "" : "s"} walked
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="warn">
                    listing #{Number(e.listingId)} resolved with no winner
                  </span>
                )}
              </li>
            );
          }
          if (e.type === "clearance.expired") {
            return (
              <li key={i} className="clearance-row clearance-expired">
                <span className="muted">∅</span>
                <strong>Expired</strong>{" "}
                <span className="muted">
                  {(e.flavour as string | null) ?? "Clearance"} — no booker, no take
                </span>
              </li>
            );
          }
          return null;
        })}
      </ul>
    </section>
  );
}

function MarketScene({
  events,
  dump,
  snapshot,
  onSelect,
}: {
  readonly events: readonly RunEvent[];
  readonly dump: RunDump;
  readonly snapshot: DaySnapshot | null;
  readonly onSelect: (s: Selection) => void;
}) {
  // Judgement audit index for the sellerBelief band hovers (one row
  // per stall via market-seller-belief / shop-seller-belief).
  const judgementIdx = useMemo<JudgementIndex>(
    () => indexJudgements(dump),
    [dump],
  );
  // All sellers this hour share the same footfall + customer mix —
  // it's the same passing crowd. Take the mix from the first event.
  const first = events[0]!;
  const footfall = Number(first.footfall ?? 0);
  const customerMix =
    (first.customerMix as Record<string, number> | undefined) ?? {};
  const personaIds = Object.keys(customerMix);
  const personaTotal = Math.max(
    1,
    Object.values(customerMix).reduce((s, n) => s + Number(n), 0),
  );
  const totalSold = events.reduce(
    (s, e) => s + Number(e.unitsSold ?? 0),
    0,
  );
  const totalRevenue = events.reduce(
    (s, e) => s + Number(e.revenue ?? 0),
    0,
  );
  const marketLocId = first.atLocationId as number | undefined;

  return (
    <section className="scene scene-market">
      <header className="scene-header">
        <span className="scene-tag scene-tag-market">★ Market</span>
        {marketLocId !== undefined ? (
          <LocationLink
            dump={dump}
            locationId={marketLocId}
            onSelect={onSelect}
          />
        ) : null}
        <span className="muted">
          · {events.length} stall{events.length === 1 ? "" : "s"} · footfall{" "}
          {footfall} · sold {totalSold} units · rev £{totalRevenue}
        </span>
      </header>

      {/* Customer mix: a stacked-bar histogram showing the persona
          breakdown of the hour's footfall. */}
      {personaIds.length > 0 && footfall > 0 ? (
        <div className="market-histogram" role="img" aria-label="customer mix">
          {personaIds.map((id) => {
            const count = Number(customerMix[id] ?? 0);
            const pct = (count / personaTotal) * 100;
            return (
              <span
                key={id}
                className={`market-histogram-bar market-persona-${id}`}
                style={{ flexBasis: `${pct}%` }}
                title={`${count} ${id}`}
              >
                <span className="market-histogram-label">
                  {count} {id}
                </span>
              </span>
            );
          })}
        </div>
      ) : null}

      {/* Per-stall cards. Each is a lot-card with the seller, the
          displayed item, the price, and a sold/offered split with a
          per-persona breakdown of who bought. */}
      <ul className="lot-cards">
        {events.map((e, i) => {
          const sellerId = e.sellerActorId as number;
          const itemId = e.itemKindId as number;
          const tier = (e.qualityTier as string | null) ?? null;
          const price = Number(e.pricePerUnit ?? 0);
          const sold = Number(e.unitsSold ?? 0);
          const offered = Number(e.unitsOffered ?? 0);
          const revenue = Number(e.revenue ?? 0);
          const stockLotId = e.stockLotId as number | undefined;
          const sellerBelief = e.sellerBelief as
            | { low: number; high: number }
            | undefined;
          const sellerJudgementId = e.sellerJudgementId as number | undefined;
          const sellerJudgement =
            sellerJudgementId !== undefined
              ? getJudgementById(judgementIdx, sellerJudgementId)
              : null;
          const sellerActor = dump.actors.find((a) => a.id === sellerId);
          const itemName =
            dump.items.find((it) => it.id === itemId)?.displayName ??
            `item ${itemId}`;
          const sellerBeliefHover =
            sellerJudgement !== null &&
            isPriceArm(sellerJudgement) &&
            sellerActor !== undefined
              ? formatPriceArmMathFromPayload({
                  observerName: fullName(sellerActor),
                  itemName,
                  payload: sellerJudgement.payload,
                })
              : "what the seller thought a unit was worth";
          // Profit needs cost basis. The lot may have been fully sold
          // by the current day, so fall back to scanning every snapshot
          // for the first hit — acquiredUnitPrice is immutable.
          let lot: SnapshotStockLot | null = null;
          if (stockLotId !== undefined) {
            if (snapshot !== null) {
              lot = snapshot.stockLots.find((l) => l.id === stockLotId) ?? null;
            }
            if (lot === null) {
              for (const snap of dump.snapshots) {
                const found = snap.stockLots.find((l) => l.id === stockLotId);
                if (found !== undefined) {
                  lot = found;
                  break;
                }
              }
            }
          }
          const costPerUnit = lot?.acquiredUnitPrice ?? null;
          const profit = costPerUnit !== null
            ? revenue - sold * costPerUnit
            : null;
          const soldByPersona =
            (e.soldByPersona as Record<string, number> | undefined) ?? {};
          const soldOut = sold > 0 && sold === offered;
          const empty = sold === 0;
          const cardClass = `lot-card ${
            soldOut
              ? "lot-card-final lot-cleared"
              : empty
                ? "lot-card-final lot-unsold"
                : "lot-card-live"
          }`;
          return (
            <li key={i}>
              <article className={cardClass}>
                <div className="lot-line">
                  <ActorChipById
                    dump={dump}
                    actorId={sellerId}
                    onSelect={onSelect}
                    size={20}
                  />
                  <span className="muted">·</span>
                  <StockChip
                    dump={dump}
                    itemKindId={itemId}
                    qualityTier={tier}
                    quantity={offered}
                    observerActorId={null}
                    onSelect={onSelect}
                  />
                  <StockChip
                    dump={dump}
                    itemKindId={itemId}
                    qualityTier={tier}
                    quantity={offered}
                    observerActorId={sellerId}
                    onSelect={onSelect}
                  />
                  {sellerBelief !== undefined ? (
                    <span className="belief-band" title={sellerBeliefHover}>
                      thought £{sellerBelief.low}–£{sellerBelief.high}
                    </span>
                  ) : null}
                </div>
                <div className="lot-bidline">
                  {empty ? (
                    <span className="lot-hammer lot-hammer-unsold">
                      0 sold · footfall passed
                    </span>
                  ) : (
                    <>
                      <span className="muted">SOLD</span>
                      <StockChip
                        dump={dump}
                        itemKindId={itemId}
                        qualityTier={tier}
                        quantity={sold}
                        observerActorId={sellerId}
                        unitPriceOverride={price}
                        onSelect={onSelect}
                      />
                      <span className="muted">
                        to passing trade · rev £{revenue}
                        {profit !== null ? (
                          <>
                            {" · "}
                            <strong className={profit >= 0 ? "" : "warn"}>
                              {profit >= 0 ? "+" : "−"}£{Math.abs(profit)}
                            </strong>{" "}
                            profit
                          </>
                        ) : null}
                      </span>
                    </>
                  )}
                </div>
                {Object.keys(soldByPersona).length > 0 ? (
                  <div className="lot-room">
                    <span className="lot-room-label muted">Bought by:</span>
                    <ul className="lot-bidders">
                      {Object.entries(soldByPersona).map(([persona, n]) => (
                        <li
                          key={persona}
                          className="lot-bidder lot-bidder-in"
                        >
                          <span>
                            {String(n)} {persona}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Format a signed pound delta as "+£X" / "−£X" / "±0". Used on the
 *  pubdeal closing frame to show how the agreed price compares to
 *  the engine's true RRP. */
function fmtDelta(n: number): string {
  if (n === 0) return "±0";
  return n > 0 ? `+£${n}` : `−£${Math.abs(n)}`;
}
