import type { SeededRNG } from "../core/rng.js";
import type {
  NegotiationContext,
  NegotiationResult,
  NegotiationTurn,
} from "./types.js";

/**
 * Run a rule-based negotiation to convergence or walk-away.
 *
 * Algorithm: each party holds a "current position" — the unit price they
 * are presently asking. They open at their target. On their turn they
 * inspect the opponent's last position; if it crosses their own (i.e. the
 * opponent is offering at least as much / asking at most as little as they
 * want), they accept the opponent's price. Otherwise they concede a
 * `concedeRate` fraction of the remaining gap toward their floor/ceiling
 * and counter. If concession is exhausted and no overlap has emerged, they
 * walk.
 *
 * Result: deterministic given seed, so suitable for tests, replays, and as
 * the offline default. Replaceable later by LLM-backed drivers using the
 * same NegotiationContext shape.
 */
export function runRuleBasedNegotiation(
  ctx: NegotiationContext,
  // RNG is wired through but the v1 algorithm is fully deterministic; reserved
  // for future jitter/personality modelling.
  _rng: SeededRNG,
): NegotiationResult {
  validateContext(ctx);

  const turns: NegotiationTurn[] = [];

  if (ctx.seller.floor > ctx.buyer.ceiling) {
    return {
      type: "walked",
      reason: "no overlap between seller floor and buyer ceiling",
      turns,
    };
  }

  let sellerPos = clampSellerStart(ctx);
  let buyerPos = clampBuyerStart(ctx);

  // Opening turn.
  let active: "seller" | "buyer" = ctx.initiator;
  turns.push({
    by: active,
    action: "open",
    unitPrice: active === "seller" ? sellerPos : buyerPos,
  });
  active = otherSide(active);

  for (let round = 0; round < ctx.maxRounds; round += 1) {
    if (active === "seller") {
      // Seller evaluates buyer's last position.
      if (buyerPos >= sellerPos) {
        // Buyer is willing to pay at least what we're asking — accept their offer.
        turns.push({ by: "seller", action: "accept", unitPrice: buyerPos });
        return { type: "agreed", unitPrice: buyerPos, turns };
      }
      const next = concedeSeller(sellerPos, ctx.seller.floor, ctx.seller.concedeRate);
      if (next === sellerPos) {
        turns.push({ by: "seller", action: "walk", unitPrice: null });
        return {
          type: "walked",
          reason: "seller at floor, buyer's offer still below it",
          turns,
        };
      }
      sellerPos = next;
      turns.push({ by: "seller", action: "counter", unitPrice: sellerPos });
    } else {
      // Buyer evaluates seller's last position.
      if (sellerPos <= buyerPos) {
        turns.push({ by: "buyer", action: "accept", unitPrice: sellerPos });
        return { type: "agreed", unitPrice: sellerPos, turns };
      }
      const next = concedeBuyer(buyerPos, ctx.buyer.ceiling, ctx.buyer.concedeRate);
      if (next === buyerPos) {
        turns.push({ by: "buyer", action: "walk", unitPrice: null });
        return {
          type: "walked",
          reason: "buyer at ceiling, seller's ask still above it",
          turns,
        };
      }
      buyerPos = next;
      turns.push({ by: "buyer", action: "counter", unitPrice: buyerPos });
    }

    active = otherSide(active);
  }

  turns.push({ by: active, action: "walk", unitPrice: null });
  return { type: "walked", reason: "max rounds exhausted", turns };
}

function validateContext(ctx: NegotiationContext): void {
  if (ctx.quantity <= 0) throw new Error(`quantity must be > 0; got ${ctx.quantity}`);
  if (ctx.seller.floor < 0) throw new Error(`seller.floor must be >= 0`);
  if (ctx.buyer.ceiling < 0) throw new Error(`buyer.ceiling must be >= 0`);
  if (ctx.seller.target < ctx.seller.floor) {
    throw new Error(`seller.target (${ctx.seller.target}) below floor (${ctx.seller.floor})`);
  }
  if (ctx.buyer.target > ctx.buyer.ceiling) {
    throw new Error(`buyer.target (${ctx.buyer.target}) above ceiling (${ctx.buyer.ceiling})`);
  }
  if (ctx.seller.concedeRate <= 0 || ctx.seller.concedeRate > 1) {
    throw new Error(`seller.concedeRate must be in (0, 1]`);
  }
  if (ctx.buyer.concedeRate <= 0 || ctx.buyer.concedeRate > 1) {
    throw new Error(`buyer.concedeRate must be in (0, 1]`);
  }
  if (ctx.maxRounds < 1) throw new Error(`maxRounds must be >= 1`);
  if (ctx.seller.actorId === ctx.buyer.actorId) {
    throw new Error(`seller and buyer must differ`);
  }
}

function clampSellerStart(ctx: NegotiationContext): number {
  // Seller can't open below their floor.
  return Math.max(ctx.seller.target, ctx.seller.floor);
}

function clampBuyerStart(ctx: NegotiationContext): number {
  // Buyer can't open above their ceiling.
  return Math.min(ctx.buyer.target, ctx.buyer.ceiling);
}

function concedeSeller(pos: number, floor: number, rate: number): number {
  if (pos <= floor) return floor;
  // Move toward floor by at least 1 unit (so we don't stall on round-down).
  const step = Math.max(1, Math.round((pos - floor) * rate));
  return Math.max(floor, pos - step);
}

function concedeBuyer(pos: number, ceiling: number, rate: number): number {
  if (pos >= ceiling) return ceiling;
  const step = Math.max(1, Math.round((ceiling - pos) * rate));
  return Math.min(ceiling, pos + step);
}

function otherSide(s: "seller" | "buyer"): "seller" | "buyer" {
  return s === "seller" ? "buyer" : "seller";
}
