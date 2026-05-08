import {
  nextRungAbove,
  rungAtOrAbove,
  rungAtOrBelow,
} from "./bid-ladder.js";

/**
 * Closed-form resolver for an ascending second-price-style auction lot,
 * snapped to the standard auction bid ladder (`bid-ladder.ts`).
 *
 * Each interested actor declares a hidden ceiling — the most they'd pay
 * for the entire lot. The engine snaps every ceiling DOWN to the highest
 * ladder rung at or below it (you can't bid a non-rung amount), and snaps
 * the floor UP to the lowest rung at or above it (the reserve).
 *
 * Resolution:
 *   • The bidder with the highest snapped ceiling wins.
 *   • If only one bidder clears the floor, they pay the snapped floor.
 *   • Otherwise, the winner pays one rung above the runner-up's snapped
 *     ceiling, capped at the winner's own snapped ceiling. If both top
 *     bidders snap to the same rung (a tie), the first by sort wins at
 *     the tied amount.
 *
 * No bidders, or all bidders below the snapped floor, returns a
 * no-clear result; the caller decides what to do with an unsold lot.
 */
export interface AuctionBidder {
  readonly actorId: number;
  /** Maximum total price this bidder will pay for the whole lot. */
  readonly ceiling: number;
}

export type AuctionSessionResult =
  | {
      readonly type: "won";
      readonly winnerActorId: number;
      /** Hammer price — total for the whole lot. Always lands on a ladder rung. */
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

  const reservedRung = rungAtOrAbove(Math.max(0, floorPrice));

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

  // Sort by snappedCeiling desc; ties broken by raw ceiling (the bidder with
  // more headroom wins, matching an English-auction "last hand still up at
  // the price"); ties at the raw level go to the earlier-listed bidder.
  valid.sort((a, b) => {
    if (b.snappedCeiling !== a.snappedCeiling) return b.snappedCeiling - a.snappedCeiling;
    if (b.originalCeiling !== a.originalCeiling) return b.originalCeiling - a.originalCeiling;
    return a.originalIndex - b.originalIndex;
  });

  const winner = valid[0]!;

  if (valid.length === 1) {
    return {
      type: "won",
      winnerActorId: winner.actorId,
      finalPrice: reservedRung,
    };
  }

  const second = valid[1]!;
  if (winner.snappedCeiling === second.snappedCeiling) {
    // Tied at a rung — winner pays that rung.
    return {
      type: "won",
      winnerActorId: winner.actorId,
      finalPrice: winner.snappedCeiling,
    };
  }

  // Winner outbids by one ladder rung over runner-up.
  const oneAbove = nextRungAbove(second.snappedCeiling);
  const finalPrice = Math.min(winner.snappedCeiling, oneAbove);
  return {
    type: "won",
    winnerActorId: winner.actorId,
    finalPrice: Math.max(finalPrice, reservedRung),
  };
}
