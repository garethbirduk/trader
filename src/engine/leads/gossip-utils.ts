import type { GossipExchange } from "../core/events.js";
import type { Lead } from "./types.js";

/**
 * Helpers shared by every gossip handler: the value-shape adaptor for
 * the embedded `GossipExchange` payload and the "does the listener
 * already hold this fact verbatim?" novelty filter.
 *
 * Three handlers consume this today: visitor↔proprietor on arrival,
 * visitor↔visitor chats inside venues, and the deal-adjacent gossip
 * that fires alongside pub-deal lifecycle events. They all share the
 * same novelty filter — different values (qty/price) still count as
 * news (a correction), but an identical retransmission is silent.
 */

export function toExchange(
  lead: Lead,
  fromActorId: number,
  toActorId: number,
): GossipExchange {
  return {
    fromActorId,
    toActorId,
    lead: {
      kind: lead.kind,
      side: lead.side,
      subjectItemKindId: lead.subjectItemKindId,
      subjectQualityTier: lead.subjectQualityTier,
      subjectTargetActorId: lead.subjectTargetActorId,
      counterpartyActorId: lead.counterpartyActorId,
      estimatedQuantity: lead.estimatedQuantity,
      estimatedUnitPrice: lead.estimatedUnitPrice,
      confidence: lead.confidence,
      hopCount: lead.hopCount,
      sourceActorId: lead.sourceActorId,
    },
  };
}

/**
 * True if `listener` already holds a lead identical to `speaker` on every
 * value-bearing field (subject + qty + price). Different values count as
 * a *refinement* — a £7 correction to a previously-known £8 fact is news
 * and should still be transmitted, surfacing as a conflict in the
 * receiver's bag. Confidence/hopCount/source aren't compared because the
 * same fact retold always cools to cold with a higher hop, but that's
 * not a change in the underlying claim.
 */
export function isLeadKnownTo(
  speaker: Lead,
  listenerLeads: readonly Lead[],
): boolean {
  for (const l of listenerLeads) {
    if (l.kind !== speaker.kind) continue;
    if (
      l.side === speaker.side &&
      l.subjectItemKindId === speaker.subjectItemKindId &&
      l.subjectQualityTier === speaker.subjectQualityTier &&
      l.subjectTargetActorId === speaker.subjectTargetActorId &&
      l.counterpartyActorId === speaker.counterpartyActorId &&
      l.estimatedQuantity === speaker.estimatedQuantity &&
      l.estimatedUnitPrice === speaker.estimatedUnitPrice
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Filter `senderLeads` down to those that are novel to the receiver and
 * sort them by freshness — warm (recent / low-hop) leads first, cold
 * leads last. Within each band the original ordering is preserved so
 * callers can still draw deterministically with `rng.pick`.
 */
export function selectNovelLeads(
  senderLeads: readonly Lead[],
  receiverLeads: readonly Lead[],
): readonly Lead[] {
  const novel = senderLeads.filter((l) => !isLeadKnownTo(l, receiverLeads));
  if (novel.length <= 1) return novel;
  const warm = novel.filter((l) => l.confidence === "warm");
  const cold = novel.filter((l) => l.confidence === "cold");
  return [...warm, ...cold];
}
