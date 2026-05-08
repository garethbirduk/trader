import type { DB } from "../core/db.js";
import type { QualityTier } from "../stock/types.js";
import { isQualityTier } from "../stock/types.js";
import type { Deal, DealLine, DealState } from "./types.js";
import { isDealState } from "./types.js";

export interface DealLineInput {
  readonly itemKindId: number;
  readonly qualityTier: QualityTier;
  readonly quantity: number;
  readonly unitPrice: number;
}

export interface CreateAgreedDealInput {
  readonly buyerActorId: number;
  readonly sellerActorId: number;
  readonly agreedDay: number;
  readonly deadlineDay: number;
  readonly lines: readonly DealLineInput[];
  readonly deliveryLocationId?: number;
  readonly notes?: string;
}

interface DealRow {
  id: number;
  buyer_actor_id: number;
  seller_actor_id: number;
  state: string;
  agreed_day: number;
  deadline_day: number;
  delivery_location_id: number | null;
  settled_day: number | null;
  defaulted_day: number | null;
  default_reason: string | null;
  notes: string | null;
  delivery_dispatched_day: number | null;
}

interface DealLineRow {
  id: number;
  deal_id: number;
  item_kind_id: number;
  quality_tier: string;
  quantity: number;
  unit_price: number;
}

function rowToDeal(r: DealRow): Deal {
  if (!isDealState(r.state)) {
    throw new Error(`invalid deal state in DB: ${r.state}`);
  }
  return {
    id: r.id,
    buyerActorId: r.buyer_actor_id,
    sellerActorId: r.seller_actor_id,
    state: r.state,
    agreedDay: r.agreed_day,
    deadlineDay: r.deadline_day,
    deliveryLocationId: r.delivery_location_id,
    settledDay: r.settled_day,
    defaultedDay: r.defaulted_day,
    defaultReason: r.default_reason,
    notes: r.notes,
    deliveryDispatchedDay: r.delivery_dispatched_day,
  };
}

function rowToDealLine(r: DealLineRow): DealLine {
  if (!isQualityTier(r.quality_tier)) {
    throw new Error(`invalid quality_tier in DB: ${r.quality_tier}`);
  }
  return {
    id: r.id,
    dealId: r.deal_id,
    itemKindId: r.item_kind_id,
    qualityTier: r.quality_tier,
    quantity: r.quantity,
    unitPrice: r.unit_price,
  };
}

/**
 * Create a deal already in `agreed` state with one or more lines. This is
 * the path used when negotiation has converged on terms; a future
 * createProposedDeal will support the multi-step proposal flow.
 *
 * Note that no stock movement happens here — that's settlement's job. The
 * seller is committing to deliver by `deadlineDay`, not asserting they
 * currently hold the goods.
 */
export function createAgreedDeal(db: DB, input: CreateAgreedDealInput): Deal {
  if (input.lines.length === 0) {
    throw new Error("a deal must have at least one line");
  }
  if (input.buyerActorId === input.sellerActorId) {
    throw new Error("buyer and seller must differ");
  }
  if (input.deadlineDay < input.agreedDay) {
    throw new Error(
      `deadlineDay (${input.deadlineDay}) must be >= agreedDay (${input.agreedDay})`,
    );
  }
  for (const line of input.lines) {
    if (line.quantity <= 0) throw new Error(`line quantity must be > 0`);
    if (line.unitPrice < 0) throw new Error(`line unit_price must be >= 0`);
  }

  return db.transaction((): Deal => {
    const dealResult = db
      .prepare(
        `INSERT INTO deals
          (buyer_actor_id, seller_actor_id, state, agreed_day,
           deadline_day, delivery_location_id, notes)
         VALUES
          (@buyer, @seller, 'agreed', @agreed_day,
           @deadline_day, @delivery_location_id, @notes)`,
      )
      .run({
        buyer: input.buyerActorId,
        seller: input.sellerActorId,
        agreed_day: input.agreedDay,
        deadline_day: input.deadlineDay,
        delivery_location_id: input.deliveryLocationId ?? null,
        notes: input.notes ?? null,
      });
    const dealId = dealResult.lastInsertRowid;

    const lineStmt = db.prepare(
      `INSERT INTO deal_lines (deal_id, item_kind_id, quality_tier, quantity, unit_price)
       VALUES (@deal_id, @item_kind_id, @quality_tier, @quantity, @unit_price)`,
    );
    for (const line of input.lines) {
      lineStmt.run({
        deal_id: dealId,
        item_kind_id: line.itemKindId,
        quality_tier: line.qualityTier,
        quantity: line.quantity,
        unit_price: line.unitPrice,
      });
    }

    const fetched = getDealById(db, dealId);
    if (!fetched) throw new Error("failed to fetch newly inserted deal");
    return fetched;
  });
}

export function getDealById(db: DB, id: number): Deal | null {
  const row = db.prepare<DealRow>(`SELECT * FROM deals WHERE id = @id`).get({ id });
  return row ? rowToDeal(row) : null;
}

export function getDealLinesByDealId(db: DB, dealId: number): DealLine[] {
  return db
    .prepare<DealLineRow>(
      `SELECT * FROM deal_lines WHERE deal_id = @deal_id ORDER BY id ASC`,
    )
    .all({ deal_id: dealId })
    .map(rowToDealLine);
}

export function getDealsByBuyer(db: DB, buyerActorId: number): Deal[] {
  return db
    .prepare<DealRow>(
      `SELECT * FROM deals WHERE buyer_actor_id = @id ORDER BY id ASC`,
    )
    .all({ id: buyerActorId })
    .map(rowToDeal);
}

export function getDealsBySeller(db: DB, sellerActorId: number): Deal[] {
  return db
    .prepare<DealRow>(
      `SELECT * FROM deals WHERE seller_actor_id = @id ORDER BY id ASC`,
    )
    .all({ id: sellerActorId })
    .map(rowToDeal);
}

export function getDealsByState(db: DB, state: DealState): Deal[] {
  return db
    .prepare<DealRow>(
      `SELECT * FROM deals WHERE state = @state ORDER BY id ASC`,
    )
    .all({ state })
    .map(rowToDeal);
}

/**
 * Deals in 'agreed' state whose deadline is on or before `day`. The daily
 * tick uses this to drive settlement: every morning the engine finds deals
 * due today and tries to settle them.
 */
export function getAgreedDealsDueBy(db: DB, day: number): Deal[] {
  return db
    .prepare<DealRow>(
      `SELECT * FROM deals
       WHERE state = 'agreed' AND deadline_day <= @day
       ORDER BY deadline_day ASC, id ASC`,
    )
    .all({ day })
    .map(rowToDeal);
}

interface UpdateStateInput {
  readonly id: number;
  readonly state: DealState;
  readonly settledDay?: number;
  readonly defaultedDay?: number;
  readonly defaultReason?: string;
}

export function updateDealState(db: DB, input: UpdateStateInput): Deal {
  const updated = db
    .prepare<DealRow>(
      `UPDATE deals SET
         state          = @state,
         settled_day    = COALESCE(@settled_day, settled_day),
         defaulted_day  = COALESCE(@defaulted_day, defaulted_day),
         default_reason = COALESCE(@default_reason, default_reason)
       WHERE id = @id
       RETURNING *`,
    )
    .get({
      id: input.id,
      state: input.state,
      settled_day: input.settledDay ?? null,
      defaulted_day: input.defaultedDay ?? null,
      default_reason: input.defaultReason ?? null,
    });
  if (!updated) throw new Error(`deal ${input.id} not found`);
  return rowToDeal(updated);
}
