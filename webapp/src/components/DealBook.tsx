import { useMemo, useState } from "react";
import type { DaySnapshot, RunDump, SnapshotDeal } from "../types.js";
import type { Selection } from "../App.js";
import { DealRef, LocationRef } from "./Refs.js";
import { ActorChipById } from "./ActorChip.js";
import { CategoryTag, StockChip } from "./StockChip.js";
import { usePov } from "../lib/pov.js";
import { useSelectionSet } from "../lib/selection-set.js";

interface Props {
  readonly dump: RunDump;
  readonly day: number;
  readonly snapshot: DaySnapshot | null;
  readonly onSelect: (s: Selection) => void;
}

const STATE_FILTERS = ["all", "agreed", "settled", "defaulted", "cancelled"] as const;
type StateFilter = (typeof STATE_FILTERS)[number];

/** Selection-set buckets used to filter the deal list. Empty buckets
 *  mean "no constraint on this axis"; a deal is included if it matches
 *  any populated axis (OR-union, matching CalendarView's behaviour). */
interface DealFilter {
  readonly actors: ReadonlySet<number>;
  readonly locations: ReadonlySet<number>;
  readonly itemKinds: ReadonlySet<number>;
  readonly categories: ReadonlySet<string>;
  readonly deals: ReadonlySet<number>;
  readonly hasAny: boolean;
}

function bucketSelection(items: readonly Selection[]): DealFilter {
  const actors = new Set<number>();
  const locations = new Set<number>();
  const itemKinds = new Set<number>();
  const categories = new Set<string>();
  const deals = new Set<number>();
  for (const s of items) {
    if (s.kind === "actor") actors.add(s.id);
    else if (s.kind === "location") locations.add(s.id);
    else if (s.kind === "item") itemKinds.add(s.id);
    else if (s.kind === "category" && s.category !== undefined) {
      categories.add(s.category);
    } else if (s.kind === "deal") deals.add(s.id);
  }
  const hasAny =
    actors.size + locations.size + itemKinds.size + categories.size + deals.size > 0;
  return { actors, locations, itemKinds, categories, deals, hasAny };
}

function dealMatches(
  deal: SnapshotDeal,
  filter: DealFilter,
  itemCategoryById: ReadonlyMap<number, string>,
): boolean {
  if (filter.deals.has(deal.id)) return true;
  if (filter.actors.has(deal.buyerActorId)) return true;
  if (filter.actors.has(deal.sellerActorId)) return true;
  if (
    deal.deliveryLocationId !== null &&
    filter.locations.has(deal.deliveryLocationId)
  ) {
    return true;
  }
  if (filter.itemKinds.size > 0 || filter.categories.size > 0) {
    for (const line of deal.lines) {
      if (filter.itemKinds.has(line.itemKindId)) return true;
      const cat = itemCategoryById.get(line.itemKindId);
      if (cat !== undefined && filter.categories.has(cat)) return true;
    }
  }
  return false;
}

export function DealBook({ dump, day, snapshot, onSelect }: Props) {
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const { pov } = usePov();
  const set = useSelectionSet();

  const itemCategoryById = useMemo(() => {
    const m = new Map<number, string>();
    for (const i of dump.items) m.set(i.id, i.category);
    return m;
  }, [dump.items]);

  const filter = useMemo(() => bucketSelection(set.items), [set.items]);

  const filtered = useMemo(() => {
    if (snapshot === null) return [];
    const byState =
      stateFilter === "all"
        ? snapshot.deals
        : snapshot.deals.filter((d) => d.state === stateFilter);
    // Admin POV with empty selection → show everything; otherwise apply
    // selection-set OR-union. Actor POV always has at least the self
    // chip (auto-add-self), so its empty branch is never hit here.
    const bySelection = filter.hasAny
      ? byState.filter((d) => dealMatches(d, filter, itemCategoryById))
      : pov.kind === "admin"
        ? byState
        : [];
    const out = [...bySelection];
    out.sort((a, b) => {
      const sortKey = (d: SnapshotDeal) =>
        d.state === "agreed" ? 0 : d.state === "settled" ? 1 : 2;
      const ka = sortKey(a);
      const kb = sortKey(b);
      if (ka !== kb) return ka - kb;
      return b.id - a.id;
    });
    return out;
  }, [snapshot, stateFilter, filter, itemCategoryById, pov.kind]);

  if (snapshot === null) {
    return (
      <div className="empty-state">
        no snapshot for day {day} (re-run the sim with --out to capture
        per-day state)
      </div>
    );
  }

  const povActorId = pov.kind === "actor" ? pov.actorId : null;

  return (
    <div className="dealbook">
      <div className="toggle">
        {STATE_FILTERS.map((s) => (
          <label key={s}>
            <input
              type="radio"
              checked={stateFilter === s}
              onChange={() => setStateFilter(s)}
            />
            {s}
          </label>
        ))}
      </div>
      {filtered.length === 0 ? (
        <div className="empty-state">no deals match</div>
      ) : (
        <div className="deals">
          {filtered.map((d) => (
            <DealCard
              key={d.id}
              dump={dump}
              deal={d}
              onSelect={onSelect}
              povActorId={povActorId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface DealCardProps {
  readonly dump: RunDump;
  readonly deal: SnapshotDeal;
  readonly onSelect: (s: Selection) => void;
  readonly povActorId: number | null;
}

function DealCard({ dump, deal, onSelect, povActorId }: DealCardProps) {
  // Character-POV collapses the line to the actor's own view of the
  // sale when they are party to the deal. Observer-POV (admin, or a
  // character watching someone else's deal) gets the full 4-chip read:
  // RRP truth + sale + each side's belief.
  const collapseSide: "seller" | "buyer" | null =
    povActorId === null
      ? null
      : povActorId === deal.sellerActorId
        ? "seller"
        : povActorId === deal.buyerActorId
          ? "buyer"
          : null;
  const verb =
    deal.state === "settled"
      ? "SOLD"
      : deal.state === "defaulted"
        ? "DEFAULTED"
        : "AGREED";

  return (
    <article className={`deal deal-${deal.state}`}>
      <header className="deal-head">
        <span className="deal-id">
          <DealRef dump={dump} id={deal.id} onSelect={onSelect} variant="chip" />
        </span>
        <span className={`deal-state state-${deal.state}`}>{deal.state}</span>
        <span className="deal-parties">
          <ActorChipById
            dump={dump}
            actorId={deal.sellerActorId}
            onSelect={onSelect}
            size={14}
          />
          <span className="ref-arrow">→</span>
          <ActorChipById
            dump={dump}
            actorId={deal.buyerActorId}
            onSelect={onSelect}
            size={14}
          />
        </span>
        <span className="muted">
          agreed D{deal.agreedDay} · deadline D{deal.deadlineDay}
          {deal.deliveryLocationId !== null ? (
            <>
              {" · drop @ "}
              <LocationRef
                dump={dump}
                id={deal.deliveryLocationId}
                onSelect={onSelect}
                variant="chip"
                size={14}
              />
            </>
          ) : null}
        </span>
        <span className="deal-total">£{deal.totalPrice}</span>
      </header>
      <ul className="deal-lines">
        {deal.lines.map((l, i) => {
          const item = dump.items.find((it) => it.id === l.itemKindId);
          const category = item?.category;
          return (
            <li key={i} className="deal-line">
              <div className="deal-line-row">
                {category !== undefined ? (
                  <CategoryTag category={category} />
                ) : null}
                {collapseSide === null ? (
                  <>
                    <StockChip
                      dump={dump}
                      itemKindId={l.itemKindId}
                      qualityTier={l.qualityTier}
                      quantity={l.quantity}
                      observerActorId={null}
                      onSelect={onSelect}
                    />
                    <span className="muted">—</span>
                    <StockChip
                      dump={dump}
                      itemKindId={l.itemKindId}
                      qualityTier={l.qualityTier}
                      quantity={l.quantity}
                      observerActorId={null}
                      unitPriceOverride={l.unitPrice}
                      onSelect={onSelect}
                    />
                    <span className="muted">{verb}</span>
                    <StockChip
                      dump={dump}
                      itemKindId={l.itemKindId}
                      qualityTier={l.qualityTier}
                      quantity={l.quantity}
                      observerActorId={deal.sellerActorId}
                      onSelect={onSelect}
                    />
                    <ActorChipById
                      dump={dump}
                      actorId={deal.sellerActorId}
                      onSelect={onSelect}
                      size={14}
                    />
                    <span className="muted">→</span>
                    <StockChip
                      dump={dump}
                      itemKindId={l.itemKindId}
                      qualityTier={l.qualityTier}
                      quantity={l.quantity}
                      observerActorId={deal.buyerActorId}
                      onSelect={onSelect}
                    />
                    <ActorChipById
                      dump={dump}
                      actorId={deal.buyerActorId}
                      onSelect={onSelect}
                      size={14}
                    />
                  </>
                ) : (
                  <>
                    <StockChip
                      dump={dump}
                      itemKindId={l.itemKindId}
                      qualityTier={l.qualityTier}
                      quantity={l.quantity}
                      observerActorId={
                        collapseSide === "seller"
                          ? deal.sellerActorId
                          : deal.buyerActorId
                      }
                      unitPriceOverride={l.unitPrice}
                      onSelect={onSelect}
                    />
                    <span className="muted">{verb}</span>
                    <ActorChipById
                      dump={dump}
                      actorId={deal.sellerActorId}
                      onSelect={onSelect}
                      size={14}
                    />
                    <span className="muted">→</span>
                    <ActorChipById
                      dump={dump}
                      actorId={deal.buyerActorId}
                      onSelect={onSelect}
                      size={14}
                    />
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {deal.state === "settled" && deal.settledDay !== null ? (
        <footer className="muted">settled D{deal.settledDay}</footer>
      ) : null}
      {deal.state === "defaulted" && deal.defaultedDay !== null ? (
        <footer className="warn">
          defaulted D{deal.defaultedDay}
          {deal.defaultReason !== null ? ` — ${deal.defaultReason}` : ""}
        </footer>
      ) : null}
    </article>
  );
}
