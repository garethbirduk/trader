import type { RunDump, RunEvent } from "../types.js";
import type { Selection } from "../App.js";
import { ActorRef, DealRef, ItemRef, LocationRef, LotRef, PoolRef } from "./Refs.js";

/**
 * Translate one event into a human-readable React fragment, looking up
 * actor / item / location / deal / lot / pool names from the dump and
 * rendering them as clickable refs.
 */
export function renderEvent(
  e: RunEvent,
  dump: RunDump,
  onSelect: (s: Selection) => void,
) {
  const A = (id: unknown) =>
    typeof id === "number" ? (
      <ActorRef dump={dump} id={id} onSelect={onSelect} variant="inline" />
    ) : (
      <span className="muted">{String(id)}</span>
    );
  const L = (id: unknown) =>
    typeof id === "number" ? (
      <LocationRef dump={dump} id={id} onSelect={onSelect} variant="inline" />
    ) : (
      <span className="muted">{String(id)}</span>
    );
  const I = (id: unknown, qualityTier?: string) =>
    typeof id === "number" ? (
      <ItemRef
        dump={dump}
        id={id}
        onSelect={onSelect}
        variant="inline"
        qualityTier={qualityTier}
      />
    ) : (
      <span className="muted">{String(id)}</span>
    );
  const Deal = (id: unknown) =>
    typeof id === "number" ? (
      <DealRef dump={dump} id={id} onSelect={onSelect} variant="inline" />
    ) : (
      <span className="muted">deal {String(id)}</span>
    );
  const Lot = (id: unknown) =>
    typeof id === "number" ? (
      <LotRef dump={dump} id={id} onSelect={onSelect} variant="inline" />
    ) : (
      <span className="muted">lot {String(id)}</span>
    );
  const Pool = (id: unknown) =>
    typeof id === "number" ? (
      <PoolRef dump={dump} id={id} onSelect={onSelect} variant="inline" />
    ) : (
      <span className="muted">pool {String(id)}</span>
    );

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
          {I(e.itemKindId, String(e.qualityTier))} — qty {String(e.quantity)},
          window £{String(e.openingUnitPrice)}→£{String(e.closingUnitPrice)},
          expires D{String(e.expiryDay).padStart(2, "0")}
          {flavour}
        </>
      );
    }
    case "pool.flushed":
      return (
        <>
          {Pool(e.poolId)} qty {String(e.quantity)} → {String(e.destination)}
          {e.auctionLotId !== null && e.auctionLotId !== undefined ? (
            <>
              {" ("}
              {Lot(e.auctionLotId)}
              {")"}
            </>
          ) : null}
        </>
      );
    case "pool.claimed":
      return (
        <>
          {A(e.actorId)} grabbed {String(e.quantity)} units @ £{String(e.unitPrice)} from {Pool(e.poolId)}
        </>
      );
    case "auction.cleared":
      return (
        <>
          {Lot(e.auctionLotId)} → {A(e.winnerActorId)}: total £{String(e.totalPrice)} (≈ £{String(e.unitPrice)}/unit)
        </>
      );
    case "auction.unsold":
      return (
        <>
          {Lot(e.auctionLotId)} unsold ({String(e.reason)})
        </>
      );
    case "auction.written_off":
      return (
        <>
          {Lot(e.auctionLotId)} written off after {String(e.daysOpen)} days
        </>
      );
    case "deal.settled":
      return (
        <>
          {Deal(e.dealId)}: {A(e.sellerActorId)} → {A(e.buyerActorId)} for £{String(e.totalPrice)}
        </>
      );
    case "deal.defaulted":
      return (
        <>
          <span className="tag-warn">⚠</span>
          {Deal(e.dealId)}: {A(e.sellerActorId)} → {A(e.buyerActorId)} —{" "}
          <em>{String(e.reason)}</em>
        </>
      );
    case "delivery.fee":
      return (
        <>
          {Deal(e.dealId)} — {A(e.sellerActorId)} paid £{String(e.fee)} delivery
        </>
      );
    case "settlement.lead-claim":
      return (
        <>
          {A(e.sellerActorId)} sourced {String(e.quantity)}@£{String(e.unitPrice)} from {Pool(e.poolId)} for {Deal(e.dealId)} (lead {String(e.throughLeadId)})
        </>
      );
    case "pubdeal.attempted":
      return (
        <>
          {A(e.sellerActorId)} → {A(e.buyerActorId)}: {I(e.itemKindId, String(e.qualityTier))} ×{String(e.quantity)}
        </>
      );
    case "pubdeal.agreed":
      return (
        <>
          {Deal(e.dealId)}: {A(e.sellerActorId)} → {A(e.buyerActorId)} — {String(e.quantity)} @ £{String(e.unitPrice)}/unit
        </>
      );
    case "pubdeal.walked":
      return (
        <>
          {A(e.sellerActorId)} ↔ {A(e.buyerActorId)} couldn't agree —{" "}
          <em>{String(e.reason)}</em>
        </>
      );
    case "pubdeal.skipped-low-trust":
      return (
        <>
          {A(e.buyerActorId)} won't deal with {A(e.sellerActorId)} (trust {String(e.trustScore)})
        </>
      );
    case "gossip.exchanged":
      return (
        <>
          {A(e.visitorActorId)} ↔ {A(e.proprietorActorId)} at {L(e.atLocationId)}
        </>
      );
    case "actor.travelled":
      return (
        <>
          {A(e.actorId)} → {L(e.toLocationId)}
        </>
      );
    case "heat.raised":
      return (
        <>
          {A(e.actorId)} +{String(e.delta)} heat → {String(e.score)} ({String(e.reason)})
        </>
      );
    case "authority.raid":
      return (
        <>
          <span className="tag-warn">🚨</span>
          {A(e.actorId)}: {String(e.unitsSeized)} units seized, £{String(e.fine)} fine (heat was {String(e.heatBefore)})
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
