import { useMemo } from "react";
import type { DaySnapshot, RunDump, RunEvent } from "../types.js";
import type { Selection } from "../App.js";
import { LocationRef } from "./Refs.js";
import { ActorChipById } from "./ActorChip.js";
import { fullName } from "../lib/actor-names.js";
import { StockChip } from "./StockChip.js";
import {
  tieredAnchorFor,
  priceBandFor,
  tierTruth,
  formatPriceArmMath,
} from "../lib/perception.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly dealId: number;
  readonly onSelect: (s: Selection) => void;
}

export function DealProfile({ dump, day, snapshot, dealId, onSelect }: Props) {
  // Fall back to scanning every snapshot if today's doesn't carry the
  // deal yet — useful for browsing settled/defaulted deals on later days.
  const deal = useMemo(() => {
    if (snapshot !== null) {
      const here = snapshot.deals.find((d) => d.id === dealId);
      if (here !== undefined) return here;
    }
    for (let i = (dump.snapshots?.length ?? 0) - 1; i >= 0; i -= 1) {
      const s = dump.snapshots![i]!;
      const found = s.deals.find((d) => d.id === dealId);
      if (found !== undefined) return found;
    }
    return null;
  }, [snapshot, dump.snapshots, dealId]);

  // Where the deal was struck — for pub-deals, this is the pub the
  // negotiation happened in (also the eventual drop location, by
  // `attemptPubDeal`'s convention). Pulled from the `pubdeal.agreed`
  // event since the deal record itself doesn't carry it separately.
  // Also pull the belief snapshots while we're walking the event list,
  // so we can render "what each side thought a unit was worth" beside
  // the agreed unit price.
  const { struckAtLocationId, sellerBelief, buyerBelief, truePricePerUnit } =
    useMemo<{
      struckAtLocationId: number | null;
      sellerBelief: { low: number; high: number } | null;
      buyerBelief: { low: number; high: number } | null;
      truePricePerUnit: number | null;
    }>(() => {
      for (const e of dump.events as readonly RunEvent[]) {
        if (e.type !== "pubdeal.agreed") continue;
        if ((e.dealId as number) !== dealId) continue;
        const locId = e.locationId as number | null | undefined;
        const sb = e.sellerBelief as { low: number; high: number } | undefined;
        const bb = e.buyerBelief as { low: number; high: number } | undefined;
        const tp = e.truePricePerUnit as number | undefined;
        return {
          struckAtLocationId: typeof locId === "number" ? locId : null,
          sellerBelief: sb ?? null,
          buyerBelief: bb ?? null,
          truePricePerUnit: typeof tp === "number" ? tp : null,
        };
      }
      return {
        struckAtLocationId: null,
        sellerBelief: null,
        buyerBelief: null,
        truePricePerUnit: null,
      };
    }, [dump.events, dealId]);

  if (deal === null) {
    return <div className="empty-state">deal {dealId} not found</div>;
  }

  return (
    <section className="actor-profile">
      <header className="profile-head">
        <div className="loc-icon">⇄</div>
        <div className="profile-title">
          <div className="profile-name">deal {deal.id}</div>
          <div className="profile-code muted">
            <span className={`deal-state state-${deal.state}`}>{deal.state}</span>
          </div>
        </div>
      </header>
      <dl className="profile-stats">
        <dt>Seller</dt>
        <dd>
          <ActorChipById
            dump={dump}
            actorId={deal.sellerActorId}
            onSelect={onSelect}
            size={16}
          />
        </dd>
        <dt>Buyer</dt>
        <dd>
          <ActorChipById
            dump={dump}
            actorId={deal.buyerActorId}
            onSelect={onSelect}
            size={16}
          />
        </dd>
        <dt>Total</dt>
        <dd>£{deal.totalPrice}</dd>
        <dt>Agreed</dt>
        <dd>D{deal.agreedDay}</dd>
        <dt>Deadline</dt>
        <dd className={day > deal.deadlineDay && deal.state === "agreed" ? "warn" : ""}>
          D{deal.deadlineDay}
        </dd>
        {struckAtLocationId !== null ? (
          <>
            <dt>Struck at</dt>
            <dd>
              <LocationRef
                dump={dump}
                id={struckAtLocationId}
                onSelect={onSelect}
                variant="chip"
                size={16}
              />
            </dd>
          </>
        ) : null}
        {deal.deliveryLocationId !== null &&
        deal.deliveryLocationId !== struckAtLocationId ? (
          <>
            <dt>Drop</dt>
            <dd>
              <LocationRef
                dump={dump}
                id={deal.deliveryLocationId}
                onSelect={onSelect}
                variant="chip"
                size={16}
              />
            </dd>
          </>
        ) : deal.deliveryLocationId !== null && struckAtLocationId === null ? (
          <>
            <dt>Drop</dt>
            <dd>
              <LocationRef
                dump={dump}
                id={deal.deliveryLocationId}
                onSelect={onSelect}
                variant="chip"
                size={16}
              />
            </dd>
          </>
        ) : null}
        {deal.settledDay !== null ? (
          <>
            <dt>Settled</dt>
            <dd>D{deal.settledDay}</dd>
          </>
        ) : null}
        {deal.defaultedDay !== null ? (
          <>
            <dt>Defaulted</dt>
            <dd className="warn">
              D{deal.defaultedDay}
              {deal.defaultReason !== null ? (
                <>
                  {" — "}
                  <span className="muted">{deal.defaultReason}</span>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
      {deal.lines.length > 0 ? (
        <div className="loc-people">
          <div className="profile-section-label">Lines</div>
          {deal.lines.map((l, i) => {
            const item = dump.items.find((it) => it.id === l.itemKindId);
            const truth =
              item !== undefined ? tierTruth(item, l.qualityTier, dump.economics) : null;
            const seller = dump.actors.find((a) => a.id === deal.sellerActorId);
            const buyer = dump.actors.find((a) => a.id === deal.buyerActorId);
            const sellerBand =
              seller?.knowledgeProfile !== undefined && item !== undefined && truth !== null
                ? priceBandFor(
                    seller.knowledgeProfile,
                    item.category,
                    truth,
                    tieredAnchorFor(dump, item.category, l.qualityTier),
                    seller.armJ?.price,
                  )
                : null;
            const buyerBand =
              buyer?.knowledgeProfile !== undefined && item !== undefined && truth !== null
                ? priceBandFor(
                    buyer.knowledgeProfile,
                    item.category,
                    truth,
                    tieredAnchorFor(dump, item.category, l.qualityTier),
                    buyer.armJ?.price,
                  )
                : null;
            const sellerCentre =
              sellerBand !== null ? Math.max(0, Math.round(sellerBand.centre)) : null;
            const buyerCentre =
              buyerBand !== null ? Math.max(0, Math.round(buyerBand.centre)) : null;
            const beliefTitle =
              item !== undefined && truth !== null
                ? [
                    sellerBand !== null
                      ? formatPriceArmMath({
                          observerName: `seller ${seller !== undefined ? fullName(seller) : "?"}`,
                          itemName: item.displayName,
                          category: item.category,
                          truthTier: l.qualityTier,
                          truthUnit: truth,
                          anchor: tieredAnchorFor(dump, item.category, l.qualityTier),
                          band: sellerBand,
                          quantity: l.quantity,
                        })
                      : null,
                    buyerBand !== null
                      ? formatPriceArmMath({
                          observerName: `buyer ${buyer !== undefined ? fullName(buyer) : "?"}`,
                          itemName: item.displayName,
                          category: item.category,
                          truthTier: l.qualityTier,
                          truthUnit: truth,
                          anchor: tieredAnchorFor(dump, item.category, l.qualityTier),
                          band: buyerBand,
                          quantity: l.quantity,
                        })
                      : null,
                  ]
                    .filter((s): s is string => s !== null)
                    .join("\n\n")
                : "";
            return (
              <div key={i} className="loc-person-row">
                <StockChip
                  dump={dump}
                  itemKindId={l.itemKindId}
                  qualityTier={l.qualityTier}
                  quantity={l.quantity}
                  observerActorId={null}
                  onSelect={onSelect}
                />
                <span className="muted">agreed £{l.unitPrice}/u</span>
                {sellerCentre !== null || buyerCentre !== null ? (
                  <span className="muted" title={beliefTitle}>
                    {" · "}
                    {sellerCentre !== null ? <>seller £{sellerCentre}</> : null}
                    {sellerCentre !== null && buyerCentre !== null ? " / " : null}
                    {buyerCentre !== null ? <>buyer £{buyerCentre}</> : null}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {sellerBelief !== null || buyerBelief !== null || truePricePerUnit !== null ? (
        <BeliefBands
          sellerBelief={sellerBelief}
          buyerBelief={buyerBelief}
          truePricePerUnit={truePricePerUnit}
          agreedUnitPrice={deal.lines[0]?.unitPrice ?? null}
        />
      ) : null}
    </section>
  );
}

/**
 * Side-by-side per-unit belief ranges captured at agreement time.
 * Shows "what each side thought a unit was worth" — the asymmetric-
 * knowledge surface area. The agreed unit price sits between (or
 * inside one of) the two bands; the engine's true RRP renders as a
 * reference line.
 */
function BeliefBands({
  sellerBelief,
  buyerBelief,
  truePricePerUnit,
  agreedUnitPrice,
}: {
  readonly sellerBelief: { low: number; high: number } | null;
  readonly buyerBelief: { low: number; high: number } | null;
  readonly truePricePerUnit: number | null;
  readonly agreedUnitPrice: number | null;
}) {
  return (
    <div className="loc-people deal-beliefs">
      <div className="profile-section-label">Per-unit beliefs</div>
      <dl className="profile-stats">
        {sellerBelief !== null ? (
          <>
            <dt>Seller thought</dt>
            <dd>
              <span className="belief-band">
                £{sellerBelief.low}–£{sellerBelief.high}
              </span>
            </dd>
          </>
        ) : null}
        {buyerBelief !== null ? (
          <>
            <dt>Buyer thought</dt>
            <dd>
              <span className="belief-band">
                £{buyerBelief.low}–£{buyerBelief.high}
              </span>
            </dd>
          </>
        ) : null}
        {agreedUnitPrice !== null ? (
          <>
            <dt>Agreed</dt>
            <dd>£{agreedUnitPrice}</dd>
          </>
        ) : null}
        {truePricePerUnit !== null ? (
          <>
            <dt>True RRP</dt>
            <dd className="muted">
              £{truePricePerUnit}
              {agreedUnitPrice !== null ? (
                <span className="muted">
                  {" "}
                  ({fmtDelta(agreedUnitPrice - truePricePerUnit)} on agreed)
                </span>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function fmtDelta(n: number): string {
  if (n === 0) return "±0";
  return n > 0 ? `+£${n}` : `−£${Math.abs(n)}`;
}
