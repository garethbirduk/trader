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
      <ActorRef
        dump={dump}
        id={id}
        onSelect={onSelect}
        variant="chip"
        size={14}
      />
    ) : (
      <span className="muted">{String(id)}</span>
    );
  const L = (id: unknown) =>
    typeof id === "number" ? (
      <LocationRef
        dump={dump}
        id={id}
        onSelect={onSelect}
        variant="chip"
        size={14}
      />
    ) : (
      <span className="muted">{String(id)}</span>
    );
  const I = (id: unknown, qualityTier?: string) =>
    typeof id === "number" ? (
      <ItemRef
        dump={dump}
        id={id}
        onSelect={onSelect}
        variant="chip"
        qualityTier={qualityTier}
      />
    ) : (
      <span className="muted">{String(id)}</span>
    );
  const Deal = (id: unknown) =>
    typeof id === "number" ? (
      <DealRef dump={dump} id={id} onSelect={onSelect} variant="chip" />
    ) : (
      <span className="muted">deal {String(id)}</span>
    );
  const Lot = (id: unknown) =>
    typeof id === "number" ? (
      <LotRef dump={dump} id={id} onSelect={onSelect} variant="chip" />
    ) : (
      <span className="muted">lot {String(id)}</span>
    );
  const Pool = (id: unknown) =>
    typeof id === "number" ? (
      <PoolRef dump={dump} id={id} onSelect={onSelect} variant="chip" />
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
          {Lot(e.auctionLotId)}<span className="ref-arrow">→</span>{A(e.winnerActorId)}: total £{String(e.totalPrice)} (≈ £{String(e.unitPrice)}/unit)
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
          {typeof e.reason === "string" ? (
            <>
              {" — "}
              <em>{e.reason}</em>
            </>
          ) : null}
        </>
      );
    case "auction.docket-published": {
      const lots = (e.lots as readonly { lotId: number; scheduledHour: number }[] | undefined) ?? [];
      if (lots.length === 0) return <>no lots on today's docket</>;
      return (
        <>
          today's docket ({lots.length} lot{lots.length === 1 ? "" : "s"}):{" "}
          {lots.map((l, i) => (
            <span key={l.lotId}>
              {i > 0 ? ", " : ""}
              {String(l.scheduledHour).padStart(2, "0")}:00 {Lot(l.lotId)}
            </span>
          ))}
        </>
      );
    }
    case "auction.knowledge-acquired":
      return (
        <>
          {A(e.actorId)} learned about {Lot(e.auctionLotId)}{" "}
          <span className="muted">via {String(e.via)}</span>
          {typeof e.fromActorId === "number" ? (
            <>
              {" "}
              <span className="muted">from</span> {A(e.fromActorId)}
            </>
          ) : null}
        </>
      );
    case "auction.lot-inspected":
      return (
        <>
          {A(e.actorId)} inspected {Lot(e.auctionLotId)}
        </>
      );
    case "actor.planned":
      return (
        <>
          {A(e.actorId)} plans {String(e.kind)} → {L(e.locationId)}
          <span className="muted">
            {" "}
            (D{String(e.targetDay).padStart(2, "0")}{" "}
            {String(e.targetHour).padStart(2, "0")}:00)
          </span>
        </>
      );
    case "off-map.resold":
      return (
        <>
          {A(e.dealerActorId)} liquidated {String(e.lotsSold)} lot
          {e.lotsSold === 1 ? "" : "s"} ({String(e.unitsSold)} units) →{" "}
          <span className="muted">£{String(e.totalValue)}</span>
        </>
      );
    case "market.hour-summary": {
      const sold = Number(e.unitsSold);
      const offered = Number(e.unitsOffered);
      const rev = Number(e.revenue);
      const footfall = Number(e.footfall);
      const mix = (e.customerMix ?? {}) as Record<string, number>;
      const mixStr = Object.entries(mix)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}`)
        .join(", ");
      return (
        <>
          {A(e.sellerActorId)} sold {sold}/{offered} ×{" "}
          {I(e.itemKindId, String(e.qualityTier))} @ £{String(e.pricePerUnit)}/u —{" "}
          rev £{rev}{" "}
          <span className="muted">
            (footfall {footfall}
            {mixStr.length > 0 ? `: ${mixStr}` : ""})
          </span>
        </>
      );
    }
    case "deal.settled":
      return (
        <>
          {Deal(e.dealId)}: {A(e.sellerActorId)}
          <span className="ref-arrow">→</span>
          {A(e.buyerActorId)} for £{String(e.totalPrice)}
        </>
      );
    case "deal.defaulted":
      return (
        <>
          <span className="tag-warn">⚠</span>
          {Deal(e.dealId)}: {A(e.sellerActorId)}
          <span className="ref-arrow">→</span>
          {A(e.buyerActorId)} — <em>{String(e.reason)}</em>
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
          {A(e.sellerActorId)}
          <span className="ref-arrow">→</span>
          {A(e.buyerActorId)}: {I(e.itemKindId, String(e.qualityTier))} ×{String(e.quantity)}
        </>
      );
    case "pubdeal.agreed":
      return (
        <>
          {Deal(e.dealId)}: {A(e.sellerActorId)}
          <span className="ref-arrow">→</span>
          {A(e.buyerActorId)} — {String(e.quantity)} @ £{String(e.unitPrice)}/unit
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
    case "pubdeal.skipped-rep":
      return (
        <>
          {A(e.buyerActorId)} clocks {A(e.sellerActorId)} and walks{" "}
          <span className="muted">
            (rep — hop {String(e.hopCount)}, £{String(e.damageOnLead)})
          </span>
        </>
      );
    case "pubdeal.skipped-too-small":
      return (
        <>
          {A(e.sellerActorId)} ↔ {A(e.buyerActorId)} too small to bother{" "}
          <span className="muted">
            (seller £{String(e.sellerRrp)}, buyer £{String(e.buyerRrp)}, floor £{String(e.floor)})
          </span>
        </>
      );
    case "rep.spawned":
      return (
        <>
          {A(e.holderActorId)} learns: {A(e.subjectTargetActorId)} burned them for £{String(e.damage)}
        </>
      );
    case "broker.materialised":
      return (
        <>
          {A(e.brokerActorId)} brings {A(e.producerActorId)} to {L(e.locationId)}{" "}
          <span className="muted">(£{String(e.fee)} fee · until {String(e.untilHour).padStart(2,"0")}:00)</span>
        </>
      );
    case "broker.materialisation-aborted":
      return (
        <>
          {A(e.producerActorId)} clocks {A(e.blockerActorId)} at {L(e.locationId)} and walks
        </>
      );
    case "payout.released":
      return (
        <>
          {A(e.actorId)} receives £{String(e.amount)}{" "}
          <span className="muted">
            ({String(e.source)} from D{String(e.originatedDay)})
          </span>
        </>
      );
    case "regional-clearance.listed":
      return (
        <>
          New lot: {I(e.itemKindId)} ×{String(e.quantity)} ({String(e.qualityTier)}){" "}
          floor £{String(e.floorPrice)}
          {e.provenance !== null && e.provenance !== undefined ? (
            <> <span className="muted">— {String(e.provenance)}</span></>
          ) : null}
        </>
      );
    case "stock.written-off":
      return (
        <>
          {A(e.ownerActorId)} skipped {String(e.quantity)}× {I(e.itemKindId)}{" "}
          <span className="muted">
            ({String(e.qualityTier)} · fee £{String(e.feePaid)})
          </span>
        </>
      );
    case "gossip.exchanged": {
      const participants = (e.participantActorIds as readonly number[]) ?? [];
      const a = participants[0];
      const b = participants[1];
      const kind = e.kind as "proprietor" | "chat" | "deal" | "clarification";
      const tag =
        kind === "chat"
          ? "chat"
          : kind === "deal"
            ? "deal-side"
            : kind === "clarification"
              ? "clarification"
              : "proprietor";
      return (
        <>
          {a !== undefined ? A(a) : <span className="muted">?</span>} ↔{" "}
          {b !== undefined ? A(b) : <span className="muted">?</span>} at {L(e.atLocationId)}{" "}
          <span className="muted">({tag})</span>
        </>
      );
    }
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
    case "actor.notebook-row-added":
    case "actor.notebook-row-updated": {
      const verb = e.type === "actor.notebook-row-added" ? "noted" : "updated";
      const side = e.side === "sell" ? "wants" : "has";
      const score =
        typeof e.score === "number" ? (
          <>
            {" · "}
            <strong className={(e.score as number) > 0 ? "" : "warn"}>
              gross £{String(e.score)}
            </strong>
          </>
        ) : null;
      const exploit = e.counterpartyExploitable ? (
        <span title="Counterparty has a category blind spot — exploitable">{" ⚠"}</span>
      ) : null;
      const locked = e.unlocked === false ? (
        <span className="muted"> · headline only</span>
      ) : null;
      return (
        <>
          {A(e.actorId)} {verb}: {A(e.counterpartyActorId)} {side} {I(e.itemKindId)}
          {score}
          {exploit}
          {locked}
        </>
      );
    }
    case "actor.notebook-row-removed":
      return (
        <span className="muted">
          {A(e.actorId)} dropped note: {A(e.counterpartyActorId)}{" "}
          {e.side === "sell" ? "wants" : "has"} {I(e.itemKindId)}
        </span>
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
