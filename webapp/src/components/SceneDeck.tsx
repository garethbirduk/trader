import { useEffect, useMemo, useRef, useState } from "react";
import type { DaySnapshot, RunDump, RunEvent, SnapshotAuctionLot, SnapshotDeal } from "../types.js";
import type { Selection } from "../App.js";
import { ActorChip, LocationLink } from "./Links.js";
import { nextRungAbove, rungAtOrBelow } from "../lib/bid-ladder.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly hour: number;
  readonly snapshot: DaySnapshot | null;
  readonly onSelect: (s: Selection) => void;
}

interface Scene {
  readonly key: string;
  readonly label: string;
  readonly render: () => JSX.Element;
}

/**
 * Live "what's happening right now" deck for the current cursor hour.
 * Each in-progress activity (auction, pub deal, gossip) becomes its own
 * tab; once the cursor moves past the hour, the scene disappears.
 */
export function SceneDeck({ dump, day, hour, snapshot, onSelect }: Props) {
  const eventsThisHour = useMemo(
    () => dump.events.filter((e) => e.at.day === day && e.at.hour === hour),
    [dump.events, day, hour],
  );

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
    const isAuctionHour =
      dump.auctionHour !== undefined && hour === dump.auctionHour;
    const eventLotIds = new Set<number>(
      auctionEvents.map((e) => e.auctionLotId as number),
    );
    const onViewLots = isAuctionHour
      ? (snapshot?.auctionLots ?? []).filter(
          (l) =>
            l.listedDay <= day &&
            (l.clearedDay === null || l.clearedDay === day) &&
            !eventLotIds.has(l.id),
        )
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

    // Gossip — single tab covering every exchange this hour.
    const gossip = eventsThisHour.filter((e) => e.type === "gossip.exchanged");
    if (gossip.length > 0) {
      list.push({
        key: "gossip",
        label: `Gossip (${gossip.length})`,
        render: () => (
          <GossipScene events={gossip} dump={dump} onSelect={onSelect} />
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

    return list;
  }, [eventsThisHour, snapshot, dump, day, onSelect]);

  const [activeKey, setActiveKey] = useState<string | null>(null);
  useEffect(() => {
    // When the hour changes, snap to the first scene (or null if none).
    setActiveKey(scenes.length === 0 ? null : scenes[0]!.key);
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
  // The engine auctions lots whose listedDay < today. Anything listed
  // today goes on the block tomorrow.
  const auctionedOnDay = lot.listedDay < day ? day : lot.listedDay + 1;
  return (
    <article className="lot-card lot-card-onview">
      <div className="lot-line">
        <strong>{itemName(lot.itemKindId)}</strong>
        <span className={`tier tier-${lot.qualityTier}`}>{lot.qualityTier}</span>
        <span>×{lot.quantity}</span>
        <span className="muted">floor £{lot.floorPrice}</span>
      </div>
      <div className="lot-bidline">
        <span className="lot-status muted">
          On view{lot.listedDay === day ? " (just listed)" : ""}
        </span>
        <span className="muted">
          next session: D{String(auctionedOnDay).padStart(2, "0")} 10:00
        </span>
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
    (event.bidders as readonly { actorId: number; ceiling: number }[] | undefined) ?? [];
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
  const actorName = (id: number) =>
    dump.actors.find((a) => a.id === id)?.displayName ?? `actor ${id}`;

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
    describeLogEntry(f, cleared, finalPrice, winnerId, actorName, reason),
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
          <>
            <strong>{itemName(lot.itemKindId)}</strong>
            <span className={`tier tier-${lot.qualityTier}`}>{lot.qualityTier}</span>
            <span>×{lot.quantity}</span>
          </>
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
              ★ HAMMER · <ActorChip dump={dump} actorId={winnerId} onSelect={onSelect} size={16} /> for £{finalPrice}
            </span>
          ) : (
            <span className="lot-hammer lot-hammer-unsold">unsold ({reason || "no clear"})</span>
          )
        ) : currentLeader !== null ? (
          <span className="muted">
            <ActorChip dump={dump} actorId={currentLeader} onSelect={onSelect} size={14} />{" "}
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
                      <ActorChip dump={dump} actorId={b.actorId} onSelect={onSelect} size={14} />
                      <span className="muted">
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
                    <ActorChip dump={dump} actorId={id} onSelect={onSelect} size={14} />
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
  readonly text: string;
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
  actorName: (id: number) => string,
  unsoldReason: string,
): LogEntry {
  if (frame.kind === "unsold") {
    return { price: frame.price, text: `unsold (${unsoldReason || "no clear"})` };
  }
  if (frame.kind === "hammer") {
    if (cleared && winnerId !== null && finalPrice !== null) {
      return { price: finalPrice, text: `★ HAMMER — ${actorName(winnerId)} wins` };
    }
    return { price: frame.price, text: `unsold (${unsoldReason || "no clear"})` };
  }
  // bid frame
  const bidderName = frame.bidder !== null ? actorName(frame.bidder) : "—";
  return { price: frame.price, text: `${bidderName} bids` };
}

function PubdealAgreedScene({
  event,
  dump,
  snapshot,
  hourEvents,
  onSelect,
}: {
  readonly event: RunEvent;
  readonly dump: RunDump;
  readonly snapshot: DaySnapshot | null;
  readonly hourEvents: readonly RunEvent[];
  readonly onSelect: (s: Selection) => void;
}) {
  const dealId = event.dealId as number;
  const sellerId = event.sellerActorId as number;
  const buyerId = event.buyerActorId as number;
  const unitPrice = event.unitPrice as number;
  const qty = event.quantity as number;
  const deal: SnapshotDeal | undefined = snapshot?.deals.find((d) => d.id === dealId);

  // Find the corresponding pubdeal.attempted to recover the location.
  const attempted = hourEvents.find(
    (e) =>
      e.type === "pubdeal.attempted" &&
      e.sellerActorId === sellerId &&
      e.buyerActorId === buyerId,
  );
  const locId = attempted?.locationId as number | undefined;

  const itemName = (id: number) =>
    dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`;

  return (
    <section className="scene scene-pubdeal">
      <header className="scene-header">
        <span className="scene-tag scene-tag-deal">Pub deal struck</span>
        {locId !== undefined ? (
          <LocationLink dump={dump} locationId={locId} onSelect={onSelect} />
        ) : null}
      </header>
      <div className="scene-parties">
        <ActorChip dump={dump} actorId={sellerId} onSelect={onSelect} size={20} />
        <span>→</span>
        <ActorChip dump={dump} actorId={buyerId} onSelect={onSelect} size={20} />
      </div>
      <div className="scene-row muted">
        deal {dealId} · qty {qty} @ £{unitPrice}{deal !== undefined ? ` · total £${deal.totalPrice}` : ""}
      </div>
      {deal !== undefined && deal.lines.length > 0 ? (
        <ul className="scene-lines">
          {deal.lines.map((line, i) => (
            <li key={i}>
              {line.quantity} {itemName(line.itemKindId)}{" "}
              <span className="muted">({line.qualityTier})</span>{" "}
              <span className="muted">@ £{line.unitPrice}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {deal !== undefined ? (
        <div className="scene-row muted">
          deadline D{deal.deadlineDay}
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

function PubdealWalkedScene({
  event,
  dump,
  hourEvents,
  onSelect,
}: {
  readonly event: RunEvent;
  readonly dump: RunDump;
  readonly hourEvents: readonly RunEvent[];
  readonly onSelect: (s: Selection) => void;
}) {
  const sellerId = event.sellerActorId as number;
  const buyerId = event.buyerActorId as number;
  const reason = String(event.reason ?? "");
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
  const itemName = (id: number) =>
    dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`;

  return (
    <section className="scene scene-pubdeal scene-walked">
      <header className="scene-header">
        <span className="scene-tag scene-tag-walk">Couldn't agree</span>
        {locId !== undefined ? (
          <LocationLink dump={dump} locationId={locId} onSelect={onSelect} />
        ) : null}
      </header>
      <div className="scene-parties">
        <ActorChip dump={dump} actorId={sellerId} onSelect={onSelect} size={20} />
        <span className="muted">↮</span>
        <ActorChip dump={dump} actorId={buyerId} onSelect={onSelect} size={20} />
      </div>
      {itemId !== undefined ? (
        <div className="scene-row">
          {qty} {itemName(itemId)}
          {tier !== undefined ? (
            <span className="muted"> ({tier})</span>
          ) : null}
        </div>
      ) : null}
      <div className="scene-row muted">{reason}</div>
    </section>
  );
}

function GossipScene({
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
    <section className="scene scene-gossip">
      <header className="scene-header">
        <span className="scene-tag scene-tag-gossip">Gossip</span>
        <span className="muted">{events.length} exchange{events.length === 1 ? "" : "s"}</span>
      </header>
      <ul className="scene-gossip-list">
        {events.map((e, i) => {
          const v = e.visitorActorId as number;
          const p = e.proprietorActorId as number;
          const loc = e.atLocationId as number;
          const exchanges = (e.exchanges as readonly any[] | undefined) ?? [];
          return (
            <li key={i} className="scene-gossip-row">
              <div className="scene-parties">
                <ActorChip dump={dump} actorId={v} onSelect={onSelect} size={16} />
                <span>↔</span>
                <ActorChip dump={dump} actorId={p} onSelect={onSelect} size={16} />
                <span className="muted">at</span>
                <LocationLink dump={dump} locationId={loc} onSelect={onSelect} />
              </div>
              {exchanges.length > 0 ? (
                <ul className="scene-lines">
                  {exchanges.map((x, j) => {
                    const lead = x.lead;
                    const verb = lead.side === "supply" ? "has" : "wants";
                    return (
                      <li key={j}>
                        <ActorChip
                          dump={dump}
                          actorId={x.fromActorId}
                          onSelect={onSelect}
                          size={14}
                        />
                        <span className="muted"> →</span>{" "}
                        {lead.counterpartyActorId !== null ? (
                          <ActorChip
                            dump={dump}
                            actorId={lead.counterpartyActorId}
                            onSelect={onSelect}
                            size={14}
                          />
                        ) : (
                          <span className="muted">someone</span>
                        )}{" "}
                        {verb} {lead.estimatedQuantity}{" "}
                        {itemName(lead.subjectItemKindId)}{" "}
                        <span className="muted">
                          ({lead.subjectQualityTier ?? "?"}) @ £
                          {lead.estimatedUnitPrice} · {lead.confidence}
                        </span>
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
        <ActorChip dump={dump} actorId={actorId} onSelect={onSelect} size={20} />
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

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
