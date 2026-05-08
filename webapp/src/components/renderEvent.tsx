import type { RunDump, RunEvent } from "../types.js";

/**
 * Translate one event into a human-readable React fragment, looking up
 * actor / item / location names from the dump.
 */
export function renderEvent(e: RunEvent, dump: RunDump) {
  const actor = (id: unknown) =>
    typeof id === "number"
      ? dump.actors.find((a) => a.id === id)?.displayName ?? `actor ${id}`
      : String(id);
  const loc = (id: unknown) =>
    typeof id === "number"
      ? dump.locations.find((l) => l.id === id)?.displayName ?? `loc ${id}`
      : String(id);
  const item = (id: unknown) =>
    typeof id === "number"
      ? dump.items.find((i) => i.id === id)?.displayName ?? `item ${id}`
      : String(id);

  switch (e.type) {
    case "pool.spawned": {
      const tag = e.isEasterEgg ? <span className="tag-egg">✨</span> : null;
      const flavour = e.flavourText ? (
        <em style={{ display: "block", color: "var(--muted)", marginTop: 4 }}>
          “{String(e.flavourText)}”
        </em>
      ) : null;
      return (
        <>
          {tag}
          {item(e.itemKindId)} ({String(e.qualityTier)}) — qty {String(e.quantity)},
          window £{String(e.openingUnitPrice)}→£{String(e.closingUnitPrice)},
          expires D{String(e.expiryDay).padStart(2, "0")}
          {flavour}
        </>
      );
    }
    case "pool.flushed":
      return (
        <>
          pool {String(e.poolId)} qty {String(e.quantity)} → {String(e.destination)}
          {e.auctionLotId !== null && e.auctionLotId !== undefined
            ? ` (lot ${String(e.auctionLotId)})`
            : ""}
        </>
      );
    case "pool.claimed":
      return (
        <>
          {actor(e.actorId)} grabbed {String(e.quantity)} units @ £{String(e.unitPrice)} from pool {String(e.poolId)}
        </>
      );
    case "auction.cleared":
      return (
        <>
          lot {String(e.auctionLotId)} → {actor(e.winnerActorId)}: total £{String(e.totalPrice)} (≈ £{String(e.unitPrice)}/unit)
        </>
      );
    case "auction.unsold":
      return (
        <>
          lot {String(e.auctionLotId)} unsold ({String(e.reason)})
        </>
      );
    case "auction.written_off":
      return (
        <>
          lot {String(e.auctionLotId)} written off after {String(e.daysOpen)} days
        </>
      );
    case "deal.settled":
      return (
        <>
          deal {String(e.dealId)}: {actor(e.sellerActorId)} → {actor(e.buyerActorId)} for £{String(e.totalPrice)}
        </>
      );
    case "deal.defaulted":
      return (
        <>
          <span className="tag-warn">⚠</span>
          deal {String(e.dealId)}: {actor(e.sellerActorId)} → {actor(e.buyerActorId)} —{" "}
          <em>{String(e.reason)}</em>
        </>
      );
    case "delivery.fee":
      return (
        <>
          deal {String(e.dealId)} — {actor(e.sellerActorId)} paid £{String(e.fee)} delivery
        </>
      );
    case "settlement.lead-claim":
      return (
        <>
          {actor(e.sellerActorId)} sourced {String(e.quantity)}@£{String(e.unitPrice)} from pool {String(e.poolId)} for deal {String(e.dealId)} (lead {String(e.throughLeadId)})
        </>
      );
    case "pubdeal.attempted":
      return (
        <>
          {actor(e.sellerActorId)} → {actor(e.buyerActorId)}: {item(e.itemKindId)} ({String(e.qualityTier)}) ×{String(e.quantity)}
        </>
      );
    case "pubdeal.agreed":
      return (
        <>
          deal {String(e.dealId)}: {actor(e.sellerActorId)} → {actor(e.buyerActorId)} — {String(e.quantity)} @ £{String(e.unitPrice)}/unit
        </>
      );
    case "pubdeal.walked":
      return (
        <>
          {actor(e.sellerActorId)} ↔ {actor(e.buyerActorId)} couldn't agree —{" "}
          <em>{String(e.reason)}</em>
        </>
      );
    case "pubdeal.skipped-low-trust":
      return (
        <>
          {actor(e.buyerActorId)} won't deal with {actor(e.sellerActorId)} (trust {String(e.trustScore)})
        </>
      );
    case "gossip.exchanged":
      return (
        <>
          {actor(e.visitorActorId)} ↔ {actor(e.proprietorActorId)} at {loc(e.atLocationId)}
        </>
      );
    case "actor.travelled":
      return (
        <>
          {actor(e.actorId)} → {loc(e.toLocationId)}
        </>
      );
    case "heat.raised":
      return (
        <>
          {actor(e.actorId)} +{String(e.delta)} heat → {String(e.score)} ({String(e.reason)})
        </>
      );
    case "authority.raid":
      return (
        <>
          <span className="tag-warn">🚨</span>
          {actor(e.actorId)}: {String(e.unitsSeized)} units seized, £{String(e.fine)} fine (heat was {String(e.heatBefore)})
        </>
      );
    case "world.started":
      return <>seed {String(e.seed)}, {String(e.maxDays)} days</>;
    case "world.ended":
      return <>final tick</>;
    case "day.started":
      return <>day {String(e.day)} begins</>;
    case "day.ended":
      return <>day {String(e.day)} closes</>;
    default:
      return <code>{JSON.stringify(e)}</code>;
  }
}
