import { nextRungAbove, rungAtOrBelow } from "./bid-ladder.js";

/**
 * Resolver for a true ascending alternation auction, snapped to the
 * standard bid ladder (`bid-ladder.ts`).
 *
 * Each interested actor declares a hidden ceiling — the most they'd pay
 * for the entire lot. The engine simulates an English ascending auction:
 *
 *   1. The opening ask snaps DOWN from the listed floor: a £144 floor
 *      opens at £125 if rungs are 125/150.
 *   2. Bidders sit in a queue, ordered by their snapped ceiling
 *      ascending (lowest opens, highest gets the last word).
 *   3. The auctioneer announces the opening ask. The first bidder in
 *      the queue who can match it takes it — they're now the leader.
 *   4. The auctioneer asks the next rung. Bidders rotate: the next
 *      one in the queue who isn't currently leading bids if their
 *      snap allows. They become the new leader.
 *   5. When nobody other than the leader can match the next ask, the
 *      auction ends. The leader wins at their LAST ACTUAL BID.
 *
 * This is "no proxy" — bidders only pay for what they actually said.
 * If R bid £200 (his ceiling) and M countered £250, R can't match
 * £300 next round, so M wins at £250 (M's last bid).
 *
 * No bidders, or all bidders below the snapped floor, returns a
 * no-clear result; the caller decides what to do with an unsold lot.
 */
export interface AuctionBidder {
  readonly actorId: number;
  /** Maximum total price this bidder will pay for the whole lot. */
  readonly ceiling: number;
  /** judgement_log row id for the appraisal that produced this
   *  ceiling — written by the bidder factory when the audit trail
   *  is wired in (docs/judgement.md). Omitted when the bidder
   *  factory ran without persistence (legacy/test paths). */
  readonly judgementId?: number;
}

export type AuctionSessionResult =
  | {
      readonly type: "won";
      readonly winnerActorId: number;
      /** Hammer price — winner's last actual bid. Always on a rung. */
      readonly finalPrice: number;
    }
  | { readonly type: "no-bidders" }
  | { readonly type: "all-below-floor" };

interface SnappedBidder {
  readonly actorId: number;
  readonly snappedCeiling: number;
  readonly originalCeiling: number;
  readonly originalIndex: number;
}

export function resolveAuctionSession(
  bidders: readonly AuctionBidder[],
  floorPrice: number,
): AuctionSessionResult {
  if (bidders.length === 0) {
    return { type: "no-bidders" };
  }

  const reservedRung = rungAtOrBelow(Math.max(0, floorPrice));

  const valid: SnappedBidder[] = [];
  bidders.forEach((b, i) => {
    const snapped = rungAtOrBelow(b.ceiling);
    if (snapped >= reservedRung) {
      valid.push({
        actorId: b.actorId,
        snappedCeiling: snapped,
        originalCeiling: b.ceiling,
        originalIndex: i,
      });
    }
  });

  if (valid.length === 0) {
    return { type: "all-below-floor" };
  }
  if (valid.length === 1) {
    return {
      type: "won",
      winnerActorId: valid[0]!.actorId,
      finalPrice: reservedRung,
    };
  }

  // Walk the auction in ascending alternation. Bidders rotate in queue
  // order (lowest snap first); each round, the auctioneer's ask is
  // taken by the next bidder in rotation who isn't currently leader and
  // can still bid. When nobody else can match, leader wins at last bid.
  const queue = [...valid].sort((a, b) => {
    if (a.snappedCeiling !== b.snappedCeiling) {
      return a.snappedCeiling - b.snappedCeiling;
    }
    if (a.originalCeiling !== b.originalCeiling) {
      return a.originalCeiling - b.originalCeiling;
    }
    return a.originalIndex - b.originalIndex;
  });

  let leader: SnappedBidder | null = null;
  let lastBid = reservedRung;
  let queueIdx = 0;
  let ask = reservedRung;

  // safety bound — should never trip with a well-formed lot
  for (let guard = 0; guard < 10_000; guard += 1) {
    let picked: SnappedBidder | null = null;
    for (let scan = 0; scan < queue.length; scan += 1) {
      const candidate = queue[(queueIdx + scan) % queue.length]!;
      if (
        (leader === null || candidate.actorId !== leader.actorId) &&
        candidate.snappedCeiling >= ask
      ) {
        picked = candidate;
        break;
      }
    }
    if (picked === null) {
      // Nobody else can match the ask. Leader wins at last actual bid.
      if (leader === null) return { type: "all-below-floor" };
      return {
        type: "won",
        winnerActorId: leader.actorId,
        finalPrice: lastBid,
      };
    }
    leader = picked;
    lastBid = ask;
    queueIdx = (queue.indexOf(picked) + 1) % queue.length;
    ask = nextRungAbove(ask);
  }

  // Defensive fallback — shouldn't be reached.
  if (leader === null) return { type: "all-below-floor" };
  return {
    type: "won",
    winnerActorId: (leader as SnappedBidder).actorId,
    finalPrice: lastBid,
  };
}
