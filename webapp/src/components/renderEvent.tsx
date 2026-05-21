import type { RunDump, RunEvent } from "../types.js";
import type { Selection } from "../App.js";
import { DealRef, LocationRef, LotRef, PoolRef } from "./Refs.js";
import { ActorChipById } from "./ActorChip.js";
import { BeliefChip } from "./BeliefChip.js";

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
      <ActorChipById
        dump={dump}
        actorId={id}
        onSelect={onSelect}
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
  /** RRP / truth chip — observer=null. */
  const I = (
    id: unknown,
    qualityTier?: string | null,
    quantity?: number | null,
  ) =>
    typeof id === "number" ? (
      <BeliefChip
        dump={dump}
        itemKindId={id}
        qualityTier={qualityTier ?? null}
        quantity={quantity ?? null}
        observerActorId={null}
        onSelect={onSelect}
      />
    ) : (
      <span className="muted">{String(id)}</span>
    );
  /** Actor-POV chip — observer set, judgement engine drives the
   *  unit price. Use after `I()` to compose the layering pattern
   *  (RRP first, then one chip per actor in the event). */
  const IPov = (
    id: unknown,
    qualityTier: string | null | undefined,
    quantity: number | null | undefined,
    observerActorId: number,
  ) =>
    typeof id === "number" ? (
      <BeliefChip
        dump={dump}
        itemKindId={id}
        qualityTier={qualityTier ?? null}
        quantity={quantity ?? null}
        observerActorId={observerActorId}
        onSelect={onSelect}
      />
    ) : null;
  /** Transactional chip — actor-POV at a fixed agreed / realised
   *  unit price. Used for SOLD / AGREED chips in the centre panel. */
  const ITxn = (
    id: unknown,
    qualityTier: string | null | undefined,
    quantity: number | null | undefined,
    observerActorId: number,
    unitPrice: number,
  ) =>
    typeof id === "number" ? (
      <BeliefChip
        dump={dump}
        itemKindId={id}
        qualityTier={qualityTier ?? null}
        quantity={quantity ?? null}
        observerActorId={observerActorId}
        unitPriceOverride={unitPrice}
        onSelect={onSelect}
      />
    ) : null;
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
          {I(e.itemKindId, String(e.qualityTier), Number(e.quantity))}{" "}
          <span className="muted">
            window £{String(e.openingUnitPrice)}→£{String(e.closingUnitPrice)},
            expires D{String(e.expiryDay).padStart(2, "0")}
          </span>
          {flavour}
        </>
      );
    }
    case "pool.flushed": {
      const pool = findPool(dump, e.poolId as number);
      return (
        <>
          {Pool(e.poolId)} ·{" "}
          {pool !== null
            ? I(pool.itemKindId, pool.qualityTier, Number(e.quantity))
            : <span className="muted">qty {String(e.quantity)}</span>}{" "}
          <span className="muted">→ {String(e.destination)}</span>
          {e.auctionLotId !== null && e.auctionLotId !== undefined ? (
            <>
              {" ("}
              {Lot(e.auctionLotId)}
              {")"}
            </>
          ) : null}
        </>
      );
    }
    case "pool.claimed": {
      const pool = findPool(dump, e.poolId as number);
      return (
        <>
          {A(e.actorId)} grabbed{" "}
          {pool !== null ? (
            <>
              {I(pool.itemKindId, pool.qualityTier, Number(e.quantity))}
              {IPov(pool.itemKindId, pool.qualityTier, Number(e.quantity), Number(e.actorId))}
            </>
          ) : (
            <span className="muted">{String(e.quantity)} units</span>
          )}{" "}
          <span className="muted">@ £{String(e.unitPrice)}/u from {Pool(e.poolId)}</span>
        </>
      );
    }
    case "auction.cleared": {
      const lot = findAuctionLot(dump, e.auctionLotId as number);
      const winnerId = e.winnerActorId as number | null;
      return (
        <>
          {Lot(e.auctionLotId)}
          {lot !== null ? (
            <>
              {" · "}
              {I(lot.itemKindId, lot.qualityTier, lot.quantity)}
              {winnerId !== null
                ? IPov(lot.itemKindId, lot.qualityTier, lot.quantity, winnerId)
                : null}
            </>
          ) : null}{" "}
          <span className="ref-arrow">→</span>{" "}
          {A(e.winnerActorId)}{" "}
          <span className="muted">
            for £{String(e.totalPrice)} (£{String(e.unitPrice)}/u)
          </span>
        </>
      );
    }
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
      const price = Number(e.pricePerUnit);
      const sellerId = Number(e.sellerActorId);
      const tierStr = String(e.qualityTier);
      const mix = (e.customerMix ?? {}) as Record<string, number>;
      const mixStr = Object.entries(mix)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}`)
        .join(", ");
      return (
        <>
          {A(e.sellerActorId)} ·{" "}
          {I(e.itemKindId, tierStr, offered)}
          {IPov(e.itemKindId, tierStr, offered, sellerId)}
          {sold > 0 ? (
            <>
              {" "}
              <span className="muted">SOLD</span>{" "}
              {ITxn(e.itemKindId, tierStr, sold, sellerId, price)}
              <span className="muted">
                to passing trade · rev £{rev}{" "}
                (footfall {footfall}
                {mixStr.length > 0 ? `: ${mixStr}` : ""})
              </span>
            </>
          ) : (
            <span className="muted">
              {" "}· 0 sold (footfall {footfall}
              {mixStr.length > 0 ? `: ${mixStr}` : ""})
            </span>
          )}
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
          {A(e.buyerActorId)}:{" "}
          {I(e.itemKindId, String(e.qualityTier), Number(e.quantity))}
          {IPov(e.itemKindId, String(e.qualityTier), Number(e.quantity), Number(e.sellerActorId))}
          {IPov(e.itemKindId, String(e.qualityTier), Number(e.quantity), Number(e.buyerActorId))}
        </>
      );
    case "pubdeal.agreed":
      return (
        <>
          {Deal(e.dealId)}: {A(e.sellerActorId)}
          <span className="ref-arrow">→</span>
          {A(e.buyerActorId)}{" "}
          <span className="muted">AGREED</span>{" "}
          {ITxn(e.itemKindId, e.qualityTier as string | null | undefined, Number(e.quantity), Number(e.sellerActorId), Number(e.unitPrice))}
          <span className="muted">to</span>{" "}
          {ITxn(e.itemKindId, e.qualityTier as string | null | undefined, Number(e.quantity), Number(e.buyerActorId), Number(e.unitPrice))}
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
          New lot: {I(e.itemKindId, String(e.qualityTier), Number(e.quantity))}{" "}
          <span className="muted">floor £{String(e.floorPrice)}</span>
          {e.provenance !== null && e.provenance !== undefined ? (
            <> <span className="muted">— {String(e.provenance)}</span></>
          ) : null}
        </>
      );
    case "stock.written-off":
      return (
        <>
          {A(e.ownerActorId)} skipped{" "}
          {I(e.itemKindId, String(e.qualityTier), Number(e.quantity))}
          {IPov(e.itemKindId, String(e.qualityTier), Number(e.quantity), Number(e.ownerActorId))}
          {" "}<span className="muted">(fee £{String(e.feePaid)})</span>
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
      const locked = e.unlocked === false ? (
        <span className="muted"> · headline only</span>
      ) : null;
      return (
        <>
          {A(e.actorId)} {verb}: {A(e.counterpartyActorId)} {side} {I(e.itemKindId)}
          {score}
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

/** Find a pool's stock-shape (itemKindId + qualityTier) across all
 *  snapshots — the pool may have been flushed and pruned from the
 *  current snapshot, but `itemKindId`/`qualityTier` are immutable. */
function findPool(
  dump: RunDump,
  poolId: number,
): { itemKindId: number; qualityTier: string } | null {
  for (const snap of dump.snapshots) {
    const found = snap.pools.find((p) => p.id === poolId);
    if (found !== undefined) return found;
  }
  return null;
}

/** Same for auction lots — pulled across snapshots so a long-cleared
 *  lot still resolves its item/tier/quantity for chip rendering. */
function findAuctionLot(
  dump: RunDump,
  lotId: number,
): { itemKindId: number; qualityTier: string; quantity: number } | null {
  for (const snap of dump.snapshots) {
    const found = snap.auctionLots.find((l) => l.id === lotId);
    if (found !== undefined) return found;
  }
  return null;
}
