import type { QualityTier } from "../stock/types.js";

/**
 * A negotiating party's hidden parameters.
 *
 * For a seller: `floor` is the minimum unit price they'd accept; `target`
 * is their opening / desired price.
 * For a buyer: `ceiling` is their maximum unit price; `target` is their
 * opening / desired price.
 *
 * `concedeRate` ∈ (0, 1]. Each round, the party moves `concedeRate`
 * fraction of the remaining gap toward their floor/ceiling. Lower = harder
 * bargainer. Use 0.2–0.4 for everyday traders, 0.05 for hard cases like
 * Boycie, 0.6 for desperate sellers.
 */
export interface SellerParty {
  readonly actorId: number;
  readonly floor: number;
  readonly target: number;
  readonly concedeRate: number;
}

export interface BuyerParty {
  readonly actorId: number;
  readonly ceiling: number;
  readonly target: number;
  readonly concedeRate: number;
}

export interface NegotiationContext {
  readonly itemKindId: number;
  readonly qualityTier: QualityTier;
  readonly quantity: number;
  readonly seller: SellerParty;
  readonly buyer: BuyerParty;
  readonly initiator: "seller" | "buyer";
  readonly maxRounds: number;
}

export interface NegotiationTurn {
  readonly by: "seller" | "buyer";
  readonly action: "open" | "counter" | "accept" | "walk";
  readonly unitPrice: number | null;
}

export type NegotiationResult =
  | {
      readonly type: "agreed";
      readonly unitPrice: number;
      readonly turns: readonly NegotiationTurn[];
    }
  | {
      readonly type: "walked";
      readonly reason: string;
      readonly turns: readonly NegotiationTurn[];
    };
