import { useEffect, useMemo, useRef, useState } from "react";
import type { DaySnapshot, RunDump, RunEvent, SnapshotAuctionLot, SnapshotDeal } from "../types.js";
import type { Selection } from "../App.js";
import { ActorChip, LocationLink } from "./Links.js";
import { ActorRef, ItemRef, LotRef } from "./Refs.js";
import { nextRungAbove, rungAtOrBelow } from "../lib/bid-ladder.js";
import { isHourInAuctionWindow } from "../lib/auction-window.js";
import {
  getJudgementById,
  indexJudgements,
  isComposite,
  type JudgementIndex,
} from "../lib/judgement-log.js";
import { formatCompositeMath } from "../lib/perception.js";

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
    const onViewLots = isAuctionHour
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
          <MarketScene events={market} dump={dump} onSelect={onSelect} />
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
  void onSelect;
  void dump;
  // Docket mode: lot has a scheduledHour today. Legacy: schedule next
  // listed-day-after-today at the legacy auctionHour.
  const scheduled =
    lot.scheduledHour !== undefined && lot.scheduledHour !== null
      ? { day, hour: lot.scheduledHour }
      : null;
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
                  // Judgement audit lookup. Bidder snapshots carry
                  // judgementId via AuctionBidderSnapshot; the
                  // composite payload reconstructs the per-arm chain.
                  const judgement =
                    b.judgementId !== undefined
                      ? getJudgementById(judgementIdx, b.judgementId)
                      : null;
                  const bidderActor = dump.actors.find((a) => a.id === b.actorId);
                  const bidderName =
                    bidderActor?.displayName ?? bidderActor?.code ?? `actor#${b.actorId}`;
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
                      <ActorChip dump={dump} actorId={b.actorId} onSelect={onSelect} size={14} />
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
            <ActorRef
              dump={dump}
              id={winnerId}
              onSelect={onSelect}
              variant="chip"
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
          <ActorRef
            dump={dump}
            id={frame.bidder}
            onSelect={onSelect}
            variant="chip"
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
          <ActorChip dump={dump} actorId={sellerId} onSelect={onSelect} size={20} />
          <span className="muted">{kind === "walked" && isFinal ? "↮" : "↔"}</span>
          <ActorChip dump={dump} actorId={buyerId} onSelect={onSelect} size={20} />
          {itemId !== undefined ? (
            <>
              <span className="muted">·</span>
              <span>×{qty}</span>
              <strong>{itemName(itemId)}</strong>
              {tier !== undefined ? (
                <span className={`tier tier-${tier}`}>{tier}</span>
              ) : null}
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
                <ActorChip
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
                <ActorChip
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
              <ActorChip
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
              <ActorChip
                dump={dump}
                actorId={buyerId}
                onSelect={onSelect}
                size={14}
              />
              {buyerBelief !== undefined ? (
                <span
                  className="belief-band"
                  title="what the buyer thought a unit was worth"
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
                    <ActorRef
                      dump={dump}
                      id={speakerId}
                      onSelect={onSelect}
                      variant="chip"
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
                      <ActorRef
                        dump={dump}
                        id={sellerId}
                        onSelect={onSelect}
                        variant="chip"
                        size={14}
                      />
                      <span className="ref-arrow">→</span>
                      <ActorRef
                        dump={dump}
                        id={buyerId}
                        onSelect={onSelect}
                        variant="chip"
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
    <ActorChip dump={dump} actorId={sellerId} onSelect={onSelect} size={14} />
  );
  const buyer = (
    <ActorChip dump={dump} actorId={buyerId} onSelect={onSelect} size={14} />
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
          const participants = (e.participantActorIds as readonly number[] | undefined) ?? [];
          const a = participants[0];
          const b = participants[1];
          const kind = (e.kind as "proprietor" | "chat" | "deal" | "clarification" | undefined) ?? "proprietor";
          const tag =
            kind === "chat"
              ? "chat"
              : kind === "deal"
                ? "deal-side"
                : kind === "clarification"
                  ? "clarification"
                  : "proprietor";
          const loc = e.atLocationId as number;
          const exchanges = (e.exchanges as readonly any[] | undefined) ?? [];
          return (
            <li key={i} className="scene-gossip-row">
              <div className="scene-parties">
                {a !== undefined ? (
                  <ActorChip dump={dump} actorId={a} onSelect={onSelect} size={16} />
                ) : (
                  <span className="muted">?</span>
                )}
                <span>↔</span>
                {b !== undefined ? (
                  <ActorChip dump={dump} actorId={b} onSelect={onSelect} size={16} />
                ) : (
                  <span className="muted">?</span>
                )}
                <span className="muted">at</span>
                <LocationLink dump={dump} locationId={loc} onSelect={onSelect} />
                <span className="muted">· {tag}</span>
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
            <li key={i} className="inspection-row">
              <span className="muted">🔨</span>
              <ActorChip
                dump={dump}
                actorId={actorId}
                onSelect={onSelect}
                size={14}
              />{" "}
              <span className="muted">inspected</span>{" "}
              <LotRef dump={dump} id={lotId} onSelect={onSelect} variant="chip" />
              {lot !== null ? (
                <>
                  {" "}
                  <span className="muted">·</span>{" "}
                  <span>{lot.quantity}</span>{" "}
                  <ItemRef
                    dump={dump}
                    id={lot.itemKindId}
                    onSelect={onSelect}
                    variant="chip"
                  />{" "}
                  <span className="muted">({lot.qualityTier})</span>{" "}
                  <span className="muted">@ floor £{lot.floorPrice}</span>
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
                <ActorChip
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
                    <ActorChip
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
  onSelect,
}: {
  readonly events: readonly RunEvent[];
  readonly dump: RunDump;
  readonly onSelect: (s: Selection) => void;
}) {
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
  const itemName = (id: number) =>
    dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`;
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
          const tier = String(e.qualityTier ?? "");
          const price = Number(e.pricePerUnit ?? 0);
          const sold = Number(e.unitsSold ?? 0);
          const offered = Number(e.unitsOffered ?? 0);
          const revenue = Number(e.revenue ?? 0);
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
                  <ActorChip
                    dump={dump}
                    actorId={sellerId}
                    onSelect={onSelect}
                    size={20}
                  />
                  <span className="muted">·</span>
                  <strong>{itemName(itemId)}</strong>
                  <span className={`tier tier-${tier}`}>{tier}</span>
                </div>
                <div className="lot-bidline">
                  <span className="lot-price">£{price}</span>
                  {empty ? (
                    <span className="lot-hammer lot-hammer-unsold">
                      0 sold
                    </span>
                  ) : (
                    <span className="lot-hammer">
                      ★ {sold}/{offered} sold · rev £{revenue}
                    </span>
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
