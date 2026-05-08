import type { DB } from "../core/db.js";
import { isQualityTier, type QualityTier } from "../stock/types.js";
import type { Lead, LeadConfidence, LeadSide } from "./types.js";

export interface InsertLeadInput {
  readonly holderActorId: number;
  readonly side: LeadSide;
  readonly subjectItemKindId: number;
  readonly subjectQualityTier?: QualityTier | null;
  readonly counterpartyActorId?: number | null;
  readonly estimatedQuantity: number;
  readonly estimatedUnitPrice: number;
  readonly confidence?: LeadConfidence;
  readonly sourceActorId?: number | null;
  readonly acquiredDay: number;
  readonly hopCount?: number;
  readonly derivedFromLeadId?: number | null;
  readonly subjectPoolId?: number | null;
}

interface LeadRow {
  id: number;
  holder_actor_id: number;
  side: string;
  subject_item_kind_id: number;
  subject_quality_tier: string | null;
  counterparty_actor_id: number | null;
  estimated_qty: number;
  estimated_unit_price: number;
  confidence: string;
  source_actor_id: number | null;
  acquired_day: number;
  hop_count: number;
  derived_from_lead_id: number | null;
  subject_pool_id: number | null;
}

function rowToLead(r: LeadRow): Lead {
  if (r.side !== "supply" && r.side !== "demand") {
    throw new Error(`invalid lead side: ${r.side}`);
  }
  if (r.confidence !== "warm" && r.confidence !== "cold") {
    throw new Error(`invalid lead confidence: ${r.confidence}`);
  }
  if (r.subject_quality_tier !== null && !isQualityTier(r.subject_quality_tier)) {
    throw new Error(`invalid quality_tier on lead: ${r.subject_quality_tier}`);
  }
  return {
    id: r.id,
    holderActorId: r.holder_actor_id,
    side: r.side,
    subjectItemKindId: r.subject_item_kind_id,
    subjectQualityTier: r.subject_quality_tier as QualityTier | null,
    counterpartyActorId: r.counterparty_actor_id,
    estimatedQuantity: r.estimated_qty,
    estimatedUnitPrice: r.estimated_unit_price,
    confidence: r.confidence,
    sourceActorId: r.source_actor_id,
    acquiredDay: r.acquired_day,
    hopCount: r.hop_count,
    derivedFromLeadId: r.derived_from_lead_id,
    subjectPoolId: r.subject_pool_id,
  };
}

export function insertLead(db: DB, input: InsertLeadInput): Lead {
  const result = db
    .prepare(
      `INSERT INTO leads
        (holder_actor_id, side, subject_item_kind_id, subject_quality_tier,
         counterparty_actor_id, estimated_qty, estimated_unit_price, confidence,
         source_actor_id, acquired_day, hop_count, derived_from_lead_id,
         subject_pool_id)
       VALUES
        (@holder, @side, @kind, @tier, @counterparty, @qty, @unit_price,
         @confidence, @source, @acquired_day, @hop_count, @derived_from,
         @pool)`,
    )
    .run({
      holder: input.holderActorId,
      side: input.side,
      kind: input.subjectItemKindId,
      tier: input.subjectQualityTier ?? null,
      counterparty: input.counterpartyActorId ?? null,
      qty: input.estimatedQuantity,
      unit_price: input.estimatedUnitPrice,
      confidence: input.confidence ?? "warm",
      source: input.sourceActorId ?? null,
      acquired_day: input.acquiredDay,
      hop_count: input.hopCount ?? 0,
      derived_from: input.derivedFromLeadId ?? null,
      pool: input.subjectPoolId ?? null,
    });
  const fetched = getLeadById(db, result.lastInsertRowid);
  if (!fetched) throw new Error("failed to fetch newly inserted lead");
  return fetched;
}

export function getLeadById(db: DB, id: number): Lead | null {
  const row = db.prepare<LeadRow>(`SELECT * FROM leads WHERE id = @id`).get({ id });
  return row ? rowToLead(row) : null;
}

export function getLeadsByHolder(db: DB, holderActorId: number): Lead[] {
  return db
    .prepare<LeadRow>(
      `SELECT * FROM leads WHERE holder_actor_id = @id ORDER BY id ASC`,
    )
    .all({ id: holderActorId })
    .map(rowToLead);
}

/**
 * Supply leads held by `actor` for a given item kind, ordered by hop_count
 * ascending (closest to source first), then warm-before-cold. Used by the
 * settlement walk to satisfy short obligations.
 */
export function getSupplyLeadsForItem(
  db: DB,
  holderActorId: number,
  itemKindId: number,
): Lead[] {
  return db
    .prepare<LeadRow>(
      `SELECT * FROM leads
       WHERE holder_actor_id = @holder
         AND side = 'supply'
         AND subject_item_kind_id = @kind
       ORDER BY hop_count ASC, confidence ASC, id ASC`,
    )
    .all({ holder: holderActorId, kind: itemKindId })
    .map(rowToLead);
}

export function deleteLead(db: DB, leadId: number): void {
  db.prepare(`DELETE FROM leads WHERE id = @id`).run({ id: leadId });
}

/**
 * Mark leads older than `warmThresholdDays` as cold, and delete leads
 * older than `deleteThresholdDays`. Designed to run from the daily tick.
 */
export interface DecayLeadsResult {
  readonly cooled: number;
  readonly deleted: number;
}

export function decayLeads(
  db: DB,
  today: number,
  warmThresholdDays: number,
  deleteThresholdDays: number,
): DecayLeadsResult {
  if (deleteThresholdDays <= warmThresholdDays) {
    throw new Error("deleteThresholdDays must be greater than warmThresholdDays");
  }
  return db.transaction((): DecayLeadsResult => {
    // Null out the derived_from pointers of any lead whose parent is
    // about to be deleted — otherwise the FK blocks the delete.
    db.prepare(
      `UPDATE leads
       SET derived_from_lead_id = NULL
       WHERE derived_from_lead_id IN (
         SELECT id FROM leads
         WHERE (@today - acquired_day) >= @delete_threshold
       )`,
    ).run({ today, delete_threshold: deleteThresholdDays });

    const deleted = db
      .prepare(
        `DELETE FROM leads
         WHERE (@today - acquired_day) >= @delete_threshold`,
      )
      .run({ today, delete_threshold: deleteThresholdDays }).changes;

    const cooled = db
      .prepare(
        `UPDATE leads
         SET confidence = 'cold'
         WHERE confidence = 'warm'
           AND (@today - acquired_day) >= @warm_threshold`,
      )
      .run({ today, warm_threshold: warmThresholdDays }).changes;

    return { cooled, deleted };
  });
}

/**
 * Pass a lead from one actor to another — produces a new lead in the
 * recipient's bag with hop_count incremented and confidence stepped down
 * (warm leads become cold once retold). The original is left intact.
 */
export function shareLead(
  db: DB,
  fromActorId: number,
  toActorId: number,
  leadId: number,
  onDay: number,
): Lead {
  return db.transaction((): Lead => {
    const source = getLeadById(db, leadId);
    if (!source) throw new Error(`lead ${leadId} not found`);
    if (source.holderActorId !== fromActorId) {
      throw new Error(`actor ${fromActorId} doesn't hold lead ${leadId}`);
    }
    if (fromActorId === toActorId) {
      throw new Error(`cannot share a lead with oneself`);
    }
    return insertLead(db, {
      holderActorId: toActorId,
      side: source.side,
      subjectItemKindId: source.subjectItemKindId,
      subjectQualityTier: source.subjectQualityTier,
      counterpartyActorId: source.counterpartyActorId,
      estimatedQuantity: source.estimatedQuantity,
      estimatedUnitPrice: source.estimatedUnitPrice,
      // Retold leads are hearsay — always cold from here on.
      confidence: "cold",
      sourceActorId: fromActorId,
      acquiredDay: onDay,
      hopCount: source.hopCount + 1,
      derivedFromLeadId: source.id,
      // Crucially: the pool reference propagates through the gossip chain.
      // Two retold leads pointing to the same pool reveal the over-count.
      subjectPoolId: source.subjectPoolId,
    });
  });
}
